import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  LivestockSpecies,
  OfftakeContract,
  OfftakeContractStatus,
  OfftakeTemplate,
  User
} from '@agric-platform/shared';
import { LIVESTOCK_SPECIES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  OFFTAKE_CONTRACT_REPOSITORY,
  OFFTAKE_TEMPLATE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  OfftakeContractRepository,
  OfftakeTemplateRepository
} from '../../database/repositories/livestock-trade.repository.js';
import { UsersService } from '../users/users.service.js';
import { assertKobo, assertRole, requireActor } from './trade.utils.js';

export interface CreateOfftakeTemplateInput {
  name: string;
  description?: string;
  species: LivestockSpecies;
  defaultQuantity?: number;
  defaultPricePerUnitKobo?: number;
  deliveryWindowDays: number;
  defaultQualityGrade?: string;
}

export interface UpdateOfftakeTemplateInput {
  name?: string;
  description?: string;
  defaultQuantity?: number;
  defaultPricePerUnitKobo?: number;
  deliveryWindowDays?: number;
  defaultQualityGrade?: string;
}

export interface InstantiateContractInput {
  farmerUserId: string;
  buyerUserId: string;
  quantity?: number;
  pricePerUnitKobo?: number;
  /** Defaults to now; the end is start + template.deliveryWindowDays. */
  deliveryWindowStart?: string;
  qualityGrade?: string;
}

/** Contract lifecycle: draft → active → fulfilled|breached; any open state
 * can be terminated. Every transition is audit-recorded and published. */
export const CONTRACT_TRANSITIONS: Record<OfftakeContractStatus, readonly OfftakeContractStatus[]> = {
  draft: ['active', 'terminated'],
  active: ['fulfilled', 'breached', 'terminated'],
  fulfilled: [],
  breached: [],
  terminated: []
};

/**
 * Off-take contract templates + contracts (F4). Templates are managed by
 * admins/partners; contracts are instantiated between a farmer and a buyer
 * with the template's variable slots (quantity, price, delivery window,
 * quality grade) resolved from overrides or template defaults.
 */
@Injectable()
export class OfftakeService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(OFFTAKE_TEMPLATE_REPOSITORY)
    private readonly templates: OfftakeTemplateRepository,
    @Inject(OFFTAKE_CONTRACT_REPOSITORY)
    private readonly contracts: OfftakeContractRepository
  ) {}

  async createTemplate(actor: User | null, input: CreateOfftakeTemplateInput): Promise<OfftakeTemplate> {
    const caller = assertRole(actor, ['partner']);
    this.assertValidTemplate(input);
    const now = new Date().toISOString();
    const template: OfftakeTemplate = {
      id: newId('offtake_template'),
      name: input.name,
      description: input.description,
      species: input.species,
      defaultQuantity: input.defaultQuantity,
      defaultPricePerUnitKobo: input.defaultPricePerUnitKobo,
      deliveryWindowDays: input.deliveryWindowDays,
      defaultQualityGrade: input.defaultQualityGrade,
      status: 'active',
      createdByUserId: caller.id,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.templates.create(template);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.offtake_template_created',
      entityType: 'offtake_template',
      entityId: created.id,
      metadata: { name: created.name, species: created.species }
    });
    return created;
  }

  async listTemplates(actor: User | null, status?: OfftakeTemplate['status']): Promise<OfftakeTemplate[]> {
    requireActor(actor);
    return this.templates.find({ status });
  }

  async updateTemplate(
    actor: User | null,
    id: string,
    patch: UpdateOfftakeTemplateInput
  ): Promise<OfftakeTemplate> {
    assertRole(actor, ['partner']);
    const template = await this.templates.getById(id);
    if (template.status === 'archived') {
      throw new BadRequestException(`Template '${id}' is archived and cannot be updated`);
    }
    const merged = { ...template, ...patch };
    this.assertValidTemplate(merged);
    return this.templates.update(id, { ...patch, updatedAt: new Date().toISOString() });
  }

  async archiveTemplate(actor: User | null, id: string): Promise<OfftakeTemplate> {
    const caller = assertRole(actor, ['partner']);
    await this.templates.getById(id);
    const updated = await this.templates.update(id, {
      status: 'archived',
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.offtake_template_archived',
      entityType: 'offtake_template',
      entityId: id
    });
    return updated;
  }

  /** Instantiates a contract from an active template. The caller must be
   * one of the two parties (or an admin/partner facilitator). */
  async instantiate(
    actor: User | null,
    templateId: string,
    input: InstantiateContractInput
  ): Promise<OfftakeContract> {
    const caller = requireActor(actor);
    const template = await this.templates.getById(templateId);
    if (template.status !== 'active') {
      throw new BadRequestException(`Template '${templateId}' is archived`);
    }
    const isParty = caller.id === input.farmerUserId || caller.id === input.buyerUserId;
    const isFacilitator = caller.roles.includes('admin') || caller.roles.includes('partner');
    if (!isParty && !isFacilitator) {
      throw new ForbiddenException('Only a contract party (or admin/partner) can instantiate a contract');
    }
    if (input.farmerUserId === input.buyerUserId) {
      throw new BadRequestException('Farmer and buyer must be different users');
    }
    await this.users.getById(input.farmerUserId);
    await this.users.getById(input.buyerUserId);
    const quantity = input.quantity ?? template.defaultQuantity;
    if (quantity === undefined || !Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException('quantity must be a positive integer (no template default)');
    }
    const pricePerUnitKobo = input.pricePerUnitKobo ?? template.defaultPricePerUnitKobo;
    if (pricePerUnitKobo === undefined) {
      throw new BadRequestException('pricePerUnitKobo is required (no template default)');
    }
    assertKobo(pricePerUnitKobo, 'pricePerUnitKobo', { allowZero: true });
    const start = input.deliveryWindowStart ?? new Date().toISOString();
    const startMs = Date.parse(start);
    if (Number.isNaN(startMs)) {
      throw new BadRequestException('deliveryWindowStart must be an ISO timestamp');
    }
    const end = new Date(startMs + template.deliveryWindowDays * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const contract: OfftakeContract = {
      id: newId('offtake_contract'),
      templateId,
      farmerUserId: input.farmerUserId,
      buyerUserId: input.buyerUserId,
      species: template.species,
      quantity,
      pricePerUnitKobo,
      totalKobo: quantity * pricePerUnitKobo,
      deliveryWindowStart: start,
      deliveryWindowEnd: end,
      qualityGrade: input.qualityGrade ?? template.defaultQualityGrade,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.contracts.create(contract);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.offtake_contract_created',
      entityType: 'offtake_contract',
      entityId: created.id,
      metadata: {
        templateId,
        farmerUserId: input.farmerUserId,
        buyerUserId: input.buyerUserId,
        totalKobo: created.totalKobo
      }
    });
    await this.events.publish(
      'livestock_trade.contract.created',
      {
        contractId: created.id,
        templateId,
        farmerUserId: input.farmerUserId,
        buyerUserId: input.buyerUserId
      },
      caller.id
    );
    return created;
  }

  async listMine(actor: User | null): Promise<OfftakeContract[]> {
    const caller = requireActor(actor);
    const [asFarmer, asBuyer] = await Promise.all([
      this.contracts.find({ farmerUserId: caller.id }),
      this.contracts.find({ buyerUserId: caller.id })
    ]);
    return [...asFarmer, ...asBuyer];
  }

  async getContract(actor: User | null, id: string): Promise<OfftakeContract> {
    const contract = await this.contracts.getById(id);
    this.assertPartyOrAdmin(actor, contract);
    return contract;
  }

  /** Lifecycle transition; every transition writes an audit record and
   * publishes livestock_trade.contract.transitioned. */
  async transition(
    actor: User | null,
    id: string,
    to: OfftakeContractStatus
  ): Promise<OfftakeContract> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(id);
    this.assertPartyOrAdmin(caller, contract);
    const allowed = CONTRACT_TRANSITIONS[contract.status];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Invalid contract transition from '${contract.status}' to '${to}'`
      );
    }
    const updated = await this.contracts.update(id, {
      status: to,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.offtake_contract_transitioned',
      entityType: 'offtake_contract',
      entityId: id,
      metadata: { from: contract.status, to }
    });
    await this.events.publish(
      'livestock_trade.contract.transitioned',
      { contractId: id, from: contract.status, to },
      caller.id
    );
    return updated;
  }

  private assertPartyOrAdmin(actor: User | null, contract: OfftakeContract): User {
    const caller = requireActor(actor);
    if (
      caller.id === contract.farmerUserId ||
      caller.id === contract.buyerUserId ||
      caller.roles.includes('admin')
    ) {
      return caller;
    }
    throw new ForbiddenException('Only a contract party (or admin) may access this contract');
  }

  private assertValidTemplate(input: {
    name: string;
    species: string;
    deliveryWindowDays: number;
    defaultQuantity?: number;
    defaultPricePerUnitKobo?: number;
  }): void {
    if (!input.name.trim()) {
      throw new BadRequestException('Template name is required');
    }
    if (!(LIVESTOCK_SPECIES as readonly string[]).includes(input.species)) {
      throw new BadRequestException(
        `Unknown livestock species '${input.species}'. Expected one of: ${LIVESTOCK_SPECIES.join(', ')}`
      );
    }
    if (!Number.isInteger(input.deliveryWindowDays) || input.deliveryWindowDays < 1) {
      throw new BadRequestException('deliveryWindowDays must be a positive integer');
    }
    if (input.defaultQuantity !== undefined) {
      if (!Number.isInteger(input.defaultQuantity) || input.defaultQuantity < 1) {
        throw new BadRequestException('defaultQuantity must be a positive integer');
      }
    }
    if (input.defaultPricePerUnitKobo !== undefined) {
      assertKobo(input.defaultPricePerUnitKobo, 'defaultPricePerUnitKobo', { allowZero: true });
    }
  }
}
