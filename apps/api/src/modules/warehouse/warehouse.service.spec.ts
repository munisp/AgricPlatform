import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CertifiedWarehouse, User, WarehouseReceipt } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryCommodityLotRepository } from '../../database/repositories/traceability.repository.js';
import {
  createInMemoryCertifiedWarehouseRepository,
  createInMemoryWarehouseDepositRepository,
  createInMemoryWarehousePledgeRepository,
  createInMemoryWarehouseReceiptRepository,
  createInMemoryWarehouseTransferRepository
} from '../../database/repositories/warehouse.repository.js';
import { ProviderRequestError } from '../integrations/drivers/http.js';
import { H3Service } from '../geo/h3.service.js';
import { StubCertificationFeed, type WarehouseCertificationFeed } from './certification.driver.js';
import { StubCollateralRegistry, type CollateralRegistry } from './collateral-registry.driver.js';
import { WarehouseService, WHR_TRANSITIONS } from './warehouse.service.js';

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-farmer', roles: ['farmer'] };
const farmer2: Pick<User, 'id' | 'roles'> = { id: 'user-farmer-2', roles: ['farmer'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };
const lender2: Pick<User, 'id' | 'roles'> = { id: 'user-lender-2', roles: ['lender'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const regulator: Pick<User, 'id' | 'roles'> = { id: 'user-regulator', roles: ['regulator'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-outsider', roles: ['supplier'] };

const KANO = { latitude: 12.0022, longitude: 8.592 };

afterEach(() => {
  vi.unstubAllEnvs();
});

const LOT = {
  id: 'lot-1',
  ownerUserId: farmer.id,
  crop: 'maize',
  harvestWindowStart: '2026-01-01T00:00:00.000Z',
  harvestWindowEnd: '2026-02-01T00:00:00.000Z',
  quantity: 2000,
  unit: 'kg',
  status: 'active' as const,
  parentLotIds: [],
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z'
};

function makeService(options: {
  certificationFeed?: WarehouseCertificationFeed;
  collateralRegistry?: CollateralRegistry;
  audit?: AuditService;
} = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const lots = createInMemoryCommodityLotRepository();
  const warehouses = createInMemoryCertifiedWarehouseRepository();
  const service = new WarehouseService(
    events,
    new H3Service(),
    warehouses,
    createInMemoryWarehouseDepositRepository(),
    createInMemoryWarehouseReceiptRepository(),
    createInMemoryWarehousePledgeRepository(),
    createInMemoryWarehouseTransferRepository(),
    lots,
    options.certificationFeed ?? new StubCertificationFeed(),
    options.collateralRegistry ?? new StubCollateralRegistry(),
    options.audit
  );
  return { service, events, lots, warehouses };
}

/** Certified-feed fixture whose outcome the test controls. */
function fixedFeed(status: 'certified' | 'pending' | 'suspended'): WarehouseCertificationFeed {
  return {
    name: 'stub',
    check: () => Promise.resolve({ status, basis: 'stub', reference: 'STUB-FIXED' })
  };
}

async function certifiedWarehouse(
  service: WarehouseService,
  ref = 'LIC-KANO-01'
): Promise<CertifiedWarehouse> {
  const warehouse = await service.registerWarehouse(
    {
      name: 'Kano Grains Depot',
      state: 'Kano',
      lga: 'Nassarawa',
      ...KANO,
      capacityTonnes: 500,
      operatorLicenseRef: ref
    },
    admin.id
  );
  return service.refreshCertification(warehouse.id, admin);
}

/** Drive a deposit all the way to an issued receipt. */
async function issuedReceipt(service: WarehouseService): Promise<WarehouseReceipt> {
  const warehouse = await certifiedWarehouse(service);
  const deposit = await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id);
  await service.gradeDeposit(
    deposit.id,
    { grade: 'A', moisturePercent: 12.5, bagCount: 40, weightKg: 2000 },
    admin
  );
  return service.issueReceipt(deposit.id, admin);
}

describe('warehouse registry', () => {
  it('registers a warehouse as pending with an app-layer H3 cell', async () => {
    const { service } = makeService();
    const warehouse = await service.registerWarehouse(
      { name: 'Kano Grains Depot', state: 'Kano', lga: 'Nassarawa', ...KANO, capacityTonnes: 500 },
      admin.id
    );
    expect(warehouse.certificationStatus).toBe('pending');
    expect(warehouse.h3Cell).toMatch(/^[0-9a-f]{15}$/);
  });

  it('rejects invalid coordinates and non-positive capacity', async () => {
    const { service } = makeService();
    await expect(
      service.registerWarehouse(
        { name: 'X', state: 'Kano', lga: 'Nassarawa', latitude: 95, longitude: 8.5, capacityTonnes: 10 },
        admin.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.registerWarehouse(
        { name: 'X', state: 'Kano', lga: 'Nassarawa', ...KANO, capacityTonnes: 0 },
        admin.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('browses warehouses with state/certification filters', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    await certifiedWarehouse(service);
    await service.registerWarehouse(
      { name: 'Kaduna Depot', state: 'Kaduna', lga: 'Chikun', latitude: 10.51, longitude: 7.42, capacityTonnes: 100 },
      admin.id
    );
    expect(await service.browseWarehouses({ state: 'Kano' })).toHaveLength(1);
    expect(await service.browseWarehouses({ certificationStatus: 'certified' })).toHaveLength(1);
    expect(await service.browseWarehouses({ certificationStatus: 'pending' })).toHaveLength(1);
  });

  it('refreshCertification applies the feed outcome with a stub basis', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    expect(warehouse.certificationStatus).toBe('certified');
  });

  it('refreshCertification maps feed outages to 503 and changes nothing', async () => {
    const failing: WarehouseCertificationFeed = {
      name: 'live',
      check: () => Promise.reject(new ProviderRequestError('warehouse-certification', 'network'))
    };
    const { service } = makeService({ certificationFeed: failing });
    const warehouse = await service.registerWarehouse(
      { name: 'Kano Grains Depot', state: 'Kano', lga: 'Nassarawa', ...KANO, capacityTonnes: 500 },
      admin.id
    );
    await expect(service.refreshCertification(warehouse.id, admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect((await service.getWarehouse(warehouse.id)).certificationStatus).toBe('pending');
  });

  it('the real stub feed pins the suspended branch', async () => {
    const { service } = makeService();
    const warehouse = await service.registerWarehouse(
      {
        name: 'Suspended Depot',
        state: 'Kano',
        lga: 'Nassarawa',
        ...KANO,
        capacityTonnes: 50,
        operatorLicenseRef: 'LIC-suspended-7'
      },
      admin.id
    );
    const checked = await service.refreshCertification(warehouse.id, admin);
    expect(checked.certificationStatus).toBe('suspended');
  });
});

describe('deposits and grading', () => {
  it('records the certification basis and round-trips it in warehouse payloads', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    expect(warehouse.certificationStatus).toBe('certified');
    expect(warehouse.certificationBasis).toBe('stub');
    const fetched = await service.getWarehouse(warehouse.id);
    expect(fetched.certificationBasis).toBe('stub');
    const listed = await service.browseWarehouses({ certificationStatus: 'certified' });
    expect(listed.find((row) => row.id === warehouse.id)?.certificationBasis).toBe('stub');
  });

  it('refuses stub-derived certifications for deposits in production (fail closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    expect(warehouse.certificationBasis).toBe('stub');
    await expect(
      service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses legacy (basis-less) certifications for deposits in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { service, warehouses } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await service.registerWarehouse(
      { name: 'Legacy Depot', state: 'Kano', lga: 'Nassarawa', ...KANO, capacityTonnes: 100 },
      admin.id
    );
    // Legacy row: certified status without a recorded basis.
    await warehouses.update(warehouse.id, { certificationStatus: 'certified' });
    await expect(
      service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('allows live-certified deposits in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const liveFeed: WarehouseCertificationFeed = {
      name: 'live',
      check: () => Promise.resolve({ status: 'certified', basis: 'live', reference: 'LIVE-1' })
    };
    const { service } = makeService({ certificationFeed: liveFeed });
    const warehouse = await certifiedWarehouse(service);
    expect(warehouse.certificationBasis).toBe('live');
    const deposit = await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id);
    expect(deposit.status).toBe('received');
  });

  it('rejects deposits at non-certified warehouses', async () => {
    const { service } = makeService();
    const warehouse = await service.registerWarehouse(
      { name: 'Pending Depot', state: 'Kano', lga: 'Nassarawa', ...KANO, capacityTonnes: 500 },
      admin.id
    );
    await expect(
      service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id)
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a received deposit linked to the farmer lot', async () => {
    const { service, lots } = makeService({ certificationFeed: fixedFeed('certified') });
    await lots.create(LOT);
    const warehouse = await certifiedWarehouse(service);
    const deposit = await service.createDeposit(
      { warehouseId: warehouse.id, crop: 'maize', lotId: LOT.id },
      farmer.id
    );
    expect(deposit.status).toBe('received');
    expect(deposit.lotId).toBe(LOT.id);
  });

  it('rejects a lot link when the lot does not exist or belongs to another farmer', async () => {
    const { service, lots } = makeService({ certificationFeed: fixedFeed('certified') });
    await lots.create(LOT);
    const warehouse = await certifiedWarehouse(service);
    await expect(
      service.createDeposit({ warehouseId: warehouse.id, crop: 'maize', lotId: 'lot-missing' }, farmer.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createDeposit({ warehouseId: warehouse.id, crop: 'maize', lotId: LOT.id }, farmer2.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows only one open deposit per lot', async () => {
    const { service, lots } = makeService({ certificationFeed: fixedFeed('certified') });
    await lots.create(LOT);
    const warehouse = await certifiedWarehouse(service);
    await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize', lotId: LOT.id }, farmer.id);
    await expect(
      service.createDeposit({ warehouseId: warehouse.id, crop: 'maize', lotId: LOT.id }, farmer.id)
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('grades a received deposit with the full grading record', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    const deposit = await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id);
    const graded = await service.gradeDeposit(
      deposit.id,
      { grade: 'A', moisturePercent: 12.5, bagCount: 40, weightKg: 2000 },
      admin
    );
    expect(graded.status).toBe('graded');
    expect(graded.grading?.gradedBy).toBe(admin.id);
    expect(graded.grading?.weightKg).toBe(2000);
  });

  it('validates grading fields', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    const deposit = await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id);
    await expect(
      service.gradeDeposit(deposit.id, { grade: 'Z' as 'A', moisturePercent: 10, bagCount: 1, weightKg: 1 }, admin)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.gradeDeposit(deposit.id, { grade: 'A', moisturePercent: 101, bagCount: 1, weightKg: 1 }, admin)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.gradeDeposit(deposit.id, { grade: 'A', moisturePercent: 10, bagCount: 0, weightKg: 1 }, admin)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.gradeDeposit(deposit.id, { grade: 'A', moisturePercent: 10, bagCount: 1, weightKg: 0 }, admin)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot grade a deposit twice', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    const deposit = await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id);
    const input = { grade: 'B' as const, moisturePercent: 13, bagCount: 10, weightKg: 500 };
    await service.gradeDeposit(deposit.id, input, admin);
    await expect(service.gradeDeposit(deposit.id, input, admin)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

describe('receipt issuance and signature', () => {
  it('issues a signed active receipt with a unique receipt number', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    expect(receipt.status).toBe('active');
    expect(receipt.receiptNumber).toMatch(/^WHR-\d{4}-[0-9A-F]{8}$/);
    expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(service.verifyReceipt(receipt)).toBe(true);
    const deposit = await service.getDeposit(receipt.depositId);
    expect(deposit.status).toBe('issued');
    expect(deposit.receiptId).toBe(receipt.id);
  });

  it('issuance is idempotent per deposit', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    const replay = await service.issueReceipt(receipt.depositId, admin);
    expect(replay.id).toBe(receipt.id);
    expect(replay.receiptNumber).toBe(receipt.receiptNumber);
  });

  it('requires a graded deposit before issuance', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const warehouse = await certifiedWarehouse(service);
    const deposit = await service.createDeposit({ warehouseId: warehouse.id, crop: 'maize' }, farmer.id);
    await expect(service.issueReceipt(deposit.id, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('detects tampering with a stored receipt', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    expect(service.verifyReceipt({ ...receipt, weightKg: 9999 })).toBe(false);
    expect(service.verifyReceipt({ ...receipt, ownerId: outsider.id })).toBe(false);
  });

  it('issues distinct receipt numbers for distinct deposits', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const first = await issuedReceipt(service);
    const second = await issuedReceipt(service);
    expect(second.receiptNumber).not.toBe(first.receiptNumber);
  });
});

describe('pledge / lien', () => {
  it('lender pledges an active receipt (STUB registry reference recorded)', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    const { receipt: pledged, pledge } = await service.pledgeReceipt(
      receipt.id,
      { principalKobo: 5_000_000, terms: '90 days' },
      lender
    );
    expect(pledged.status).toBe('pledged');
    expect(pledge.status).toBe('active');
    expect(pledge.borrowerId).toBe(farmer.id);
    expect(pledge.registryRef).toMatch(/^STUB-/);
    expect(pledge.registryBasis).toBe('stub');
  });

  it('rejects a second pledge while one is active', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await expect(
      service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender2)
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('validates the principal', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await expect(
      service.pledgeReceipt(receipt.id, { principalKobo: 0 }, lender)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.pledgeReceipt(receipt.id, { principalKobo: 100.5 }, lender)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when the collateral registry is down — nothing persisted', async () => {
    const failing: CollateralRegistry = {
      name: 'live',
      register: () => Promise.reject(new ProviderRequestError('collateral-registry', 'network')),
      release: () => Promise.resolve()
    };
    const { service } = makeService({
      certificationFeed: fixedFeed('certified'),
      collateralRegistry: failing
    });
    const receipt = await issuedReceipt(service);
    await expect(
      service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect((await service.getReceipt(receipt.id)).status).toBe('active');
    expect(await service.listPledgesForReceipt(receipt.id)).toHaveLength(0);
  });

  it('refuses stub-basis collateral registrations for pledges in production (fail closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WAREHOUSE_RECEIPT_SECRET', 'spec-receipt-signing-secret');
    const liveFeed: WarehouseCertificationFeed = {
      name: 'live',
      check: () => Promise.resolve({ status: 'certified', basis: 'live', reference: 'LIVE-1' })
    };
    const { service } = makeService({ certificationFeed: liveFeed }); // stub collateral registry
    const receipt = await issuedReceipt(service);
    await expect(
      service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Nothing persisted: the receipt stays active and no pledge was recorded.
    expect((await service.getReceipt(receipt.id)).status).toBe('active');
    expect(await service.listPledgesForReceipt(receipt.id)).toHaveLength(0);
  });

  it('allows live-registered pledges in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WAREHOUSE_RECEIPT_SECRET', 'spec-receipt-signing-secret');
    const liveFeed: WarehouseCertificationFeed = {
      name: 'live',
      check: () => Promise.resolve({ status: 'certified', basis: 'live', reference: 'LIVE-1' })
    };
    const liveRegistry: CollateralRegistry = {
      name: 'live',
      register: () => Promise.resolve({ reference: 'CR-LIVE-1', basis: 'live' }),
      release: () => Promise.resolve()
    };
    const { service } = makeService({
      certificationFeed: liveFeed,
      collateralRegistry: liveRegistry
    });
    const receipt = await issuedReceipt(service);
    const { pledge } = await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    expect(pledge.status).toBe('active');
    expect(pledge.registryBasis).toBe('live');
  });

  it('the registering lender releases the pledge (receipt released)', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    const { receipt: released, pledge } = await service.releasePledge(receipt.id, lender);
    expect(released.status).toBe('released');
    expect(pledge.status).toBe('released');
    expect(pledge.releasedAt).toBeTruthy();
  });

  it('another lender cannot release the pledge (403 before state)', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await expect(service.releasePledge(receipt.id, lender2)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('admin may release the pledge', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    const { receipt: released } = await service.releasePledge(receipt.id, admin);
    expect(released.status).toBe('released');
  });

  it('release replays idempotently', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    const { pledge } = await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await service.releasePledge(receipt.id, lender);
    const replay = await service.releasePledge(receipt.id, lender);
    expect(replay.pledge.id).toBe(pledge.id);
    expect(replay.receipt.status).toBe('released');
  });

  it('a released receipt can be re-pledged', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await service.releasePledge(receipt.id, lender);
    const { receipt: repledged } = await service.pledgeReceipt(
      receipt.id,
      { principalKobo: 200 },
      lender2
    );
    expect(repledged.status).toBe('pledged');
    expect((await service.listPledgesForReceipt(receipt.id))).toHaveLength(2);
  });

  it('a redeemed receipt cannot be pledged', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.redeemReceipt(receipt.id, farmer);
    await expect(
      service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender)
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('transfer and redeem', () => {
  it('owner transfers an active receipt with an audit trail record', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    const updated = await service.transferReceipt(receipt.id, farmer2.id, farmer, 'sold forward');
    expect(updated.ownerId).toBe(farmer2.id);
    const transfers = await service.listTransfersForReceipt(receipt.id);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].fromOwnerId).toBe(farmer.id);
    expect(transfers[0].toOwnerId).toBe(farmer2.id);
    expect(transfers[0].note).toBe('sold forward');
  });

  it('non-owners cannot transfer (403 before state)', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await expect(service.transferReceipt(receipt.id, outsider.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('a pledged receipt cannot be transferred', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await expect(service.transferReceipt(receipt.id, farmer2.id, farmer)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('transfer to the same owner is rejected', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await expect(service.transferReceipt(receipt.id, farmer.id, farmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('the new owner redeems; the deposit is withdrawn', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.transferReceipt(receipt.id, farmer2.id, farmer);
    const redeemed = await service.redeemReceipt(receipt.id, farmer2);
    expect(redeemed.status).toBe('redeemed');
    expect((await service.getDeposit(receipt.depositId)).status).toBe('withdrawn');
  });

  it('a pledged receipt cannot be redeemed', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await expect(service.redeemReceipt(receipt.id, farmer)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('redemption replays idempotently and non-owners get 403', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.redeemReceipt(receipt.id, farmer);
    const replay = await service.redeemReceipt(receipt.id, farmer);
    expect(replay.status).toBe('redeemed');
    await expect(service.redeemReceipt(receipt.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('a redeemed receipt cannot be transferred', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.redeemReceipt(receipt.id, farmer);
    await expect(service.transferReceipt(receipt.id, farmer2.id, farmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

describe('access control and oversight', () => {
  it('receipt visibility: owner, pledge lender, admin and regulator only', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await expect(service.assertReceiptViewer(receipt, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(service.assertReceiptViewer(receipt, lender)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await expect(service.assertReceiptViewer(receipt, farmer)).resolves.toBeUndefined();
    await expect(service.assertReceiptViewer(receipt, lender)).resolves.toBeUndefined();
    await expect(service.assertReceiptViewer(receipt, admin)).resolves.toBeUndefined();
    await expect(service.assertReceiptViewer(receipt, regulator)).resolves.toBeUndefined();
  });

  it('exportRegistry returns every receipt, pledge and transfer', async () => {
    const { service } = makeService({ certificationFeed: fixedFeed('certified') });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await service.releasePledge(receipt.id, lender);
    await service.transferReceipt(receipt.id, farmer2.id, farmer);
    const exported = await service.exportRegistry();
    expect(exported.receipts).toHaveLength(1);
    expect(exported.pledges).toHaveLength(1);
    expect(exported.transfers).toHaveLength(1);
    expect(exported.exportedAt).toBeTruthy();
  });

  it('integrationStatus honestly reports the stub drivers', () => {
    const { service } = makeService();
    expect(service.integrationStatus()).toEqual({
      certificationDriver: 'stub',
      collateralRegistryDriver: 'stub'
    });
  });

  it('writes audit entries for collateral movements', async () => {
    const audits = createInMemoryAuditRepository();
    const audit = new AuditService(audits);
    const { service } = makeService({ certificationFeed: fixedFeed('certified'), audit });
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await service.releasePledge(receipt.id, lender);
    await service.redeemReceipt(receipt.id, farmer);
    const entries = await audits.list({});
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain('warehouse.receipt.pledged');
    expect(actions).toContain('warehouse.pledge.released');
    expect(actions).toContain('warehouse.receipt.redeemed');
  });

  it('publishes domain events on the money/collateral movements', async () => {
    const { service, events } = makeService({ certificationFeed: fixedFeed('certified') });
    const seen: string[] = [];
    events.on('*', (event: { name: string }) => seen.push(event.name));
    const receipt = await issuedReceipt(service);
    await service.pledgeReceipt(receipt.id, { principalKobo: 100 }, lender);
    await service.releasePledge(receipt.id, lender);
    await service.redeemReceipt(receipt.id, farmer);
    expect(seen).toContain('warehouse.receipt.issued');
    expect(seen).toContain('warehouse.receipt.pledged');
    expect(seen).toContain('warehouse.receipt.released');
    expect(seen).toContain('warehouse.receipt.redeemed');
  });

  it('getReceipt throws NotFound for unknown ids', async () => {
    const { service } = makeService();
    await expect(service.getReceipt('whr-missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('state machine', () => {
  it('documents the intended transitions', () => {
    expect(WHR_TRANSITIONS.active).toEqual(['pledged', 'redeemed']);
    expect(WHR_TRANSITIONS.pledged).toEqual(['released']);
    expect(WHR_TRANSITIONS.released).toEqual(['pledged', 'redeemed']);
    expect(WHR_TRANSITIONS.redeemed).toEqual([]);
  });
});
