import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryOfftakeContractRepository,
  createInMemoryOfftakeTemplateRepository
} from '../../database/repositories/livestock-trade.repository.js';
import { OfftakeService } from './offtake.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const partner = asUser('partner-1', ['partner']);
const admin = asUser('admin-1', ['admin']);
const farmer = asUser('farmer-1', ['farmer']);
const buyer = asUser('buyer-1', ['buyer']);
const outsider = asUser('farmer-9', ['farmer']);

const templateInput = {
  name: 'Kano cattle off-take Q3',
  species: 'cattle' as const,
  defaultQuantity: 20,
  defaultPricePerUnitKobo: 180_000_00,
  deliveryWindowDays: 30,
  defaultQualityGrade: 'A'
};

describe('OfftakeService', () => {
  let templates: ReturnType<typeof createInMemoryOfftakeTemplateRepository>;
  let contracts: ReturnType<typeof createInMemoryOfftakeContractRepository>;
  let users: { getById: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let service: OfftakeService;

  beforeEach(() => {
    templates = createInMemoryOfftakeTemplateRepository();
    contracts = createInMemoryOfftakeContractRepository();
    users = {
      getById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'missing') {
          throw new NotFoundException('User not found.');
        }
        return { id, roles: ['farmer'] };
      })
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    service = new OfftakeService(
      users as never,
      audit as never,
      new DomainEventsService(outbox),
      templates,
      contracts
    );
  });

  it('lets partners and admins create templates but not farmers', async () => {
    const template = await service.createTemplate(partner, templateInput);
    expect(template.status).toBe('active');
    await expect(service.createTemplate(farmer, templateInput)).rejects.toThrow(
      'Requires one of roles'
    );
    await expect(service.createTemplate(admin, templateInput)).resolves.toMatchObject({
      status: 'active'
    });
  });

  it('validates template slots and species', async () => {
    await expect(
      service.createTemplate(partner, { ...templateInput, deliveryWindowDays: 0 })
    ).rejects.toThrow('deliveryWindowDays');
    await expect(
      service.createTemplate(partner, { ...templateInput, species: 'camel' as never })
    ).rejects.toThrow('Unknown livestock species');
    await expect(
      service.createTemplate(partner, { ...templateInput, defaultPricePerUnitKobo: 1.5 })
    ).rejects.toThrow('kobo');
  });

  it('archives templates and blocks updates afterwards', async () => {
    const template = await service.createTemplate(partner, templateInput);
    const archived = await service.archiveTemplate(partner, template.id);
    expect(archived.status).toBe('archived');
    await expect(
      service.updateTemplate(partner, template.id, { name: 'renamed' })
    ).rejects.toThrow('archived');
  });

  it('updates slot defaults on an active template', async () => {
    const template = await service.createTemplate(partner, templateInput);
    const updated = await service.updateTemplate(partner, template.id, {
      defaultQuantity: 50,
      deliveryWindowDays: 45
    });
    expect(updated.defaultQuantity).toBe(50);
    expect(updated.deliveryWindowDays).toBe(45);
  });

  it('instantiates a contract from template defaults with computed totals', async () => {
    const template = await service.createTemplate(partner, templateInput);
    const contract = await service.instantiate(farmer, template.id, {
      farmerUserId: farmer.id,
      buyerUserId: buyer.id,
      deliveryWindowStart: '2026-03-01T00:00:00.000Z'
    });
    expect(contract.status).toBe('draft');
    expect(contract.quantity).toBe(20);
    expect(contract.pricePerUnitKobo).toBe(180_000_00);
    expect(contract.totalKobo).toBe(20 * 180_000_00);
    expect(contract.qualityGrade).toBe('A');
    expect(contract.deliveryWindowEnd).toBe('2026-03-31T00:00:00.000Z');
  });

  it('lets overrides win over template defaults', async () => {
    const template = await service.createTemplate(partner, templateInput);
    const contract = await service.instantiate(buyer, template.id, {
      farmerUserId: farmer.id,
      buyerUserId: buyer.id,
      quantity: 5,
      pricePerUnitKobo: 200_000_00
    });
    expect(contract.totalKobo).toBe(5 * 200_000_00);
  });

  it('rejects instantiation by outsiders and self-contracts', async () => {
    const template = await service.createTemplate(partner, templateInput);
    await expect(
      service.instantiate(outsider, template.id, {
        farmerUserId: farmer.id,
        buyerUserId: buyer.id
      })
    ).rejects.toThrow('Only a contract party');
    await expect(
      service.instantiate(farmer, template.id, {
        farmerUserId: farmer.id,
        buyerUserId: farmer.id
      })
    ).rejects.toThrow('different users');
  });

  it('404s on unknown contract parties', async () => {
    const template = await service.createTemplate(partner, templateInput);
    await expect(
      service.instantiate(farmer, template.id, {
        farmerUserId: farmer.id,
        buyerUserId: 'missing'
      })
    ).rejects.toThrow('User not found.');
  });

  it('rejects instantiation from archived templates or missing slots', async () => {
    const template = await service.createTemplate(partner, templateInput);
    await service.archiveTemplate(partner, template.id);
    await expect(
      service.instantiate(farmer, template.id, {
        farmerUserId: farmer.id,
        buyerUserId: buyer.id
      })
    ).rejects.toThrow('archived');
    const bare = await service.createTemplate(partner, {
      name: 'bare',
      species: 'goat',
      deliveryWindowDays: 14
    });
    await expect(
      service.instantiate(farmer, bare.id, { farmerUserId: farmer.id, buyerUserId: buyer.id })
    ).rejects.toThrow('quantity');
  });

  it('walks draft → active → fulfilled with audit records on every transition', async () => {
    const template = await service.createTemplate(partner, templateInput);
    const contract = await service.instantiate(farmer, template.id, {
      farmerUserId: farmer.id,
      buyerUserId: buyer.id
    });
    const active = await service.transition(buyer, contract.id, 'active');
    expect(active.status).toBe('active');
    const fulfilled = await service.transition(farmer, contract.id, 'fulfilled');
    expect(fulfilled.status).toBe('fulfilled');
    const transitions = audit.record.mock.calls.filter(
      ([input]) => input.action === 'livestock_trade.offtake_contract_transitioned'
    );
    expect(transitions).toHaveLength(2);
    const events = await outbox.list();
    expect(
      events.filter((event) => event.name === 'livestock_trade.contract.transitioned')
    ).toHaveLength(2);
  });

  it('blocks invalid transitions and non-party access', async () => {
    const template = await service.createTemplate(partner, templateInput);
    const contract = await service.instantiate(farmer, template.id, {
      farmerUserId: farmer.id,
      buyerUserId: buyer.id
    });
    await expect(service.transition(farmer, contract.id, 'fulfilled')).rejects.toThrow(
      'Invalid contract transition'
    );
    await expect(service.transition(outsider, contract.id, 'active')).rejects.toThrow(
      'Only a contract party'
    );
    await expect(service.getContract(outsider, contract.id)).rejects.toThrow(
      'Only a contract party'
    );
  });

  it('lists contracts for both parties', async () => {
    const template = await service.createTemplate(partner, templateInput);
    await service.instantiate(farmer, template.id, {
      farmerUserId: farmer.id,
      buyerUserId: buyer.id
    });
    expect(await service.listMine(farmer)).toHaveLength(1);
    expect(await service.listMine(buyer)).toHaveLength(1);
    expect(await service.listMine(outsider)).toHaveLength(0);
  });
});
