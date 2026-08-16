import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type {
  CertifiedWarehouse,
  User,
  WarehouseDeposit,
  WarehouseGrade,
  WarehouseGrading,
  WarehousePledge,
  WarehouseReceipt,
  WarehouseReceiptStatus,
  WarehouseReceiptTransfer,
  WarehouseRegistryExport
} from '@agric-platform/shared';
import { WAREHOUSE_GRADES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CERTIFIED_WAREHOUSE_REPOSITORY,
  COMMODITY_LOT_REPOSITORY,
  WAREHOUSE_DEPOSIT_REPOSITORY,
  WAREHOUSE_PLEDGE_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY,
  WAREHOUSE_TRANSFER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CommodityLotRepository } from '../../database/repositories/traceability.repository.js';
import type {
  CertifiedWarehouseRepository,
  WarehouseDepositRepository,
  WarehousePledgeRepository,
  WarehouseReceiptRepository,
  WarehouseTransferRepository
} from '../../database/repositories/warehouse.repository.js';
import { H3Service } from '../geo/h3.service.js';
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from '../integrations/drivers/http.js';
import {
  WAREHOUSE_CERTIFICATION_FEED,
  type WarehouseCertificationFeed
} from './certification.driver.js';
import {
  COLLATERAL_REGISTRY,
  type CollateralRegistry
} from './collateral-registry.driver.js';
import {
  canonicalReceiptPayload,
  resolveReceiptSecret,
  signReceipt,
  verifyReceiptSignature
} from './receipt-crypto.js';

/** H3 resolution for warehouse cells (coarse browse resolution, no PostGIS). */
export const WAREHOUSE_H3_RESOLUTION = 5;

type Actor = Pick<User, 'id' | 'roles'>;

/** Receipt state machine. Terminal: redeemed. */
export const WHR_TRANSITIONS: Readonly<Record<WarehouseReceiptStatus, readonly WarehouseReceiptStatus[]>> = {
  active: ['pledged', 'redeemed'],
  pledged: ['released'],
  released: ['pledged', 'redeemed'],
  redeemed: []
};

export interface RegisterWarehouseInput {
  name: string;
  state: string;
  lga: string;
  latitude: number;
  longitude: number;
  capacityTonnes: number;
  operatorLicenseRef?: string;
}

export interface BrowseWarehousesFilter {
  state?: string;
  lga?: string;
  certificationStatus?: CertifiedWarehouse['certificationStatus'];
}

export interface CreateDepositInput {
  warehouseId: string;
  /** Optional traceability CommodityLot link (must belong to the farmer). */
  lotId?: string;
  crop: string;
}

export interface GradeDepositInput {
  grade: WarehouseGrade;
  moisturePercent: number;
  bagCount: number;
  weightKg: number;
}

export interface PledgeReceiptInput {
  principalKobo: number;
  terms?: string;
}

export interface WarehouseIntegrationStatus {
  certificationDriver: 'stub' | 'live';
  collateralRegistryDriver: 'stub' | 'live';
}

function isProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderConfigError ||
    error instanceof ProviderHttpError ||
    error instanceof ProviderRequestError ||
    error instanceof ServiceUnavailableException
  );
}

/**
 * Electronic warehouse receipt registry (wave WAREHOUSE, additive).
 * Operational records only — money stays in the finance ledger. Both
 * external ports (warehouse-operator certification feed, collateral
 * registry) follow the STUB-first doctrine: deterministic labelled stubs by
 * default, fail-closed live drivers (provider errors surface as 503; the
 * stub is never silently substituted).
 */
@Injectable()
export class WarehouseService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly h3: H3Service,
    @Inject(CERTIFIED_WAREHOUSE_REPOSITORY)
    private readonly warehouses: CertifiedWarehouseRepository,
    @Inject(WAREHOUSE_DEPOSIT_REPOSITORY)
    private readonly deposits: WarehouseDepositRepository,
    @Inject(WAREHOUSE_RECEIPT_REPOSITORY)
    private readonly receipts: WarehouseReceiptRepository,
    @Inject(WAREHOUSE_PLEDGE_REPOSITORY)
    private readonly pledges: WarehousePledgeRepository,
    @Inject(WAREHOUSE_TRANSFER_REPOSITORY)
    private readonly transfers: WarehouseTransferRepository,
    @Inject(COMMODITY_LOT_REPOSITORY)
    private readonly lots: CommodityLotRepository,
    @Inject(WAREHOUSE_CERTIFICATION_FEED)
    private readonly certificationFeed: WarehouseCertificationFeed,
    @Inject(COLLATERAL_REGISTRY)
    private readonly collateralRegistry: CollateralRegistry,
    @Optional() private readonly audit?: AuditService
  ) {}

  // -- Warehouse registry (admin) --------------------------------------------

  async registerWarehouse(input: RegisterWarehouseInput, actorId: string): Promise<CertifiedWarehouse> {
    this.h3.assertCoordinates(input.latitude, input.longitude);
    if (!input.name?.trim()) {
      throw new BadRequestException('Warehouse name is required');
    }
    if (!input.state?.trim() || !input.lga?.trim()) {
      throw new BadRequestException('Warehouse state and lga are required');
    }
    if (!Number.isFinite(input.capacityTonnes) || input.capacityTonnes <= 0) {
      throw new BadRequestException('capacityTonnes must be a positive number');
    }
    const now = new Date().toISOString();
    const warehouse: CertifiedWarehouse = {
      id: newId('warehouse'),
      name: input.name.trim(),
      state: input.state.trim(),
      lga: input.lga.trim(),
      latitude: input.latitude,
      longitude: input.longitude,
      h3Cell: this.h3.cellAt(input.latitude, input.longitude, WAREHOUSE_H3_RESOLUTION),
      capacityTonnes: input.capacityTonnes,
      certificationStatus: 'pending',
      operatorLicenseRef: input.operatorLicenseRef,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.warehouses.create(warehouse);
    await this.events.publish(
      'warehouse.warehouse.registered',
      { warehouseId: created.id, state: created.state, lga: created.lga },
      actorId
    );
    return created;
  }

  async browseWarehouses(filter: BrowseWarehousesFilter): Promise<CertifiedWarehouse[]> {
    return this.warehouses.find(filter);
  }

  async getWarehouse(id: string): Promise<CertifiedWarehouse> {
    return this.warehouses.getById(id);
  }

  /**
   * Re-check operator certification through the feed port. The check basis
   * ('stub' | 'live') is recorded on the audit entry and the domain event —
   * never presented as a live check when the stub produced it.
   */
  async refreshCertification(id: string, actor: Actor): Promise<CertifiedWarehouse> {
    const warehouse = await this.warehouses.getById(id);
    let check;
    try {
      check = await this.certificationFeed.check({
        warehouseId: warehouse.id,
        operatorLicenseRef: warehouse.operatorLicenseRef
      });
    } catch (error) {
      if (isProviderError(error)) {
        throw new ServiceUnavailableException(
          'Warehouse operator certification feed is unavailable (fail-closed: no status change).'
        );
      }
      throw error;
    }
    const updated = await this.warehouses.update(id, {
      certificationStatus: check.status,
      // The basis travels with the status it produced: a stub-derived
      // 'certified' is labelled as such and must not unblock deposits in
      // production (see createDeposit).
      certificationBasis: check.basis,
      updatedAt: new Date().toISOString()
    });
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.certification.checked',
      entityType: 'certified_warehouse',
      entityId: id,
      metadata: { status: check.status, basis: check.basis, reference: check.reference }
    });
    await this.events.publish(
      'warehouse.certification.checked',
      { warehouseId: id, status: check.status, basis: check.basis },
      actor.id
    );
    return updated;
  }

  // -- Deposits + grading ------------------------------------------------------

  async createDeposit(input: CreateDepositInput, farmerId: string): Promise<WarehouseDeposit> {
    const warehouse = await this.warehouses.getById(input.warehouseId);
    if (warehouse.certificationStatus !== 'certified') {
      throw new ConflictException(
        `Warehouse is not accepting deposits (certification '${warehouse.certificationStatus}')`
      );
    }
    // Fail closed (mirrors the commodity-price/weather production gates): a
    // 'certified' status produced by the stub feed is a development fixture
    // and must never unblock deposits (or downstream pledges) in production.
    if (isProduction() && warehouse.certificationBasis !== 'live') {
      throw new ServiceUnavailableException(
        `Warehouse '${warehouse.id}' certification was not verified against the live operator ` +
          'feed (basis is not live). Refusing the deposit in production — re-check certification ' +
          'with the live certification feed configured.'
      );
    }
    if (!input.crop?.trim()) {
      throw new BadRequestException('crop is required');
    }
    if (input.lotId) {
      const lot = await this.lots.findById(input.lotId);
      if (!lot) {
        throw new BadRequestException(`Commodity lot '${input.lotId}' not found`);
      }
      if (lot.ownerUserId !== farmerId) {
        throw new ForbiddenException('Only the lot owner may deposit it');
      }
      const existing = await this.deposits.find({ lotId: input.lotId });
      if (existing.some((deposit) => deposit.status !== 'withdrawn')) {
        throw new ConflictException('This commodity lot already has an open warehouse deposit');
      }
    }
    const now = new Date().toISOString();
    const deposit: WarehouseDeposit = {
      id: newId('whdeposit'),
      warehouseId: warehouse.id,
      farmerId,
      lotId: input.lotId,
      crop: input.crop.trim(),
      status: 'received',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.deposits.create(deposit);
    await this.events.publish(
      'warehouse.deposit.received',
      { depositId: created.id, warehouseId: warehouse.id, farmerId },
      farmerId
    );
    return created;
  }

  async getDeposit(id: string): Promise<WarehouseDeposit> {
    return this.deposits.getById(id);
  }

  async listDepositsForFarmer(farmerId: string): Promise<WarehouseDeposit[]> {
    const deposits = await this.deposits.find({ farmerId });
    return deposits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listDepositsForWarehouse(warehouseId: string): Promise<WarehouseDeposit[]> {
    const deposits = await this.deposits.find({ warehouseId });
    return deposits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Record the quality grading (warehouse operator / admin). */
  async gradeDeposit(
    id: string,
    input: GradeDepositInput,
    actor: Actor
  ): Promise<WarehouseDeposit> {
    if (!WAREHOUSE_GRADES.includes(input.grade)) {
      throw new BadRequestException(`grade must be one of ${WAREHOUSE_GRADES.join(', ')}`);
    }
    if (
      !Number.isFinite(input.moisturePercent) ||
      input.moisturePercent < 0 ||
      input.moisturePercent > 100
    ) {
      throw new BadRequestException('moisturePercent must be between 0 and 100');
    }
    if (!Number.isInteger(input.bagCount) || input.bagCount <= 0) {
      throw new BadRequestException('bagCount must be a positive integer');
    }
    if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) {
      throw new BadRequestException('weightKg must be a positive number');
    }
    const deposit = await this.deposits.getById(id);
    if (deposit.status !== 'received') {
      throw new BadRequestException(
        `Only received deposits can be graded (status '${deposit.status}')`
      );
    }
    const grading: WarehouseGrading = {
      grade: input.grade,
      moisturePercent: input.moisturePercent,
      bagCount: input.bagCount,
      weightKg: input.weightKg,
      gradedBy: actor.id,
      gradedAt: new Date().toISOString()
    };
    const updated = await this.deposits.update(id, {
      status: 'graded',
      grading,
      updatedAt: new Date().toISOString()
    });
    await this.events.publish(
      'warehouse.deposit.graded',
      { depositId: id, grade: grading.grade, weightKg: grading.weightKg },
      actor.id
    );
    return updated;
  }

  // -- e-WHR issuance -----------------------------------------------------------

  /**
   * Issue the HMAC-signed electronic warehouse receipt for a graded deposit.
   * Idempotent per deposit: a replay returns the already-issued receipt.
   */
  async issueReceipt(depositId: string, actor: Actor): Promise<WarehouseReceipt> {
    const deposit = await this.deposits.getById(depositId);
    if (deposit.receiptId) {
      return this.receipts.getById(deposit.receiptId); // idempotent replay
    }
    if (deposit.status !== 'graded' || !deposit.grading) {
      throw new BadRequestException(
        `Only graded deposits can be issued a receipt (status '${deposit.status}')`
      );
    }
    const secret = resolveReceiptSecret();
    const issuedAt = new Date().toISOString();
    // Unique, human-readable receipt number: WHR-<year>-<8 hex of a hash>.
    let nonce = randomUUID();
    let receiptNumber = this.receiptNumber(deposit.id, nonce);
    while (await this.receipts.findOne({ receiptNumber })) {
      nonce = randomUUID();
      receiptNumber = this.receiptNumber(deposit.id, nonce);
    }
    const payload = {
      receiptNumber,
      depositId: deposit.id,
      warehouseId: deposit.warehouseId,
      ownerId: deposit.farmerId,
      crop: deposit.crop,
      grade: deposit.grading.grade,
      bagCount: deposit.grading.bagCount,
      weightKg: deposit.grading.weightKg,
      issuedAt,
      nonce
    };
    const now = new Date().toISOString();
    const receipt: WarehouseReceipt = {
      id: newId('whr'),
      receiptNumber,
      depositId: deposit.id,
      warehouseId: deposit.warehouseId,
      ownerId: deposit.farmerId,
      crop: deposit.crop,
      grade: deposit.grading.grade,
      bagCount: deposit.grading.bagCount,
      weightKg: deposit.grading.weightKg,
      status: 'active',
      nonce,
      signature: signReceipt(payload, secret),
      issuedAt,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.receipts.create(receipt);
    await this.deposits.update(depositId, {
      status: 'issued',
      receiptId: created.id,
      updatedAt: now
    });
    await this.events.publish(
      'warehouse.receipt.issued',
      { receiptId: created.id, receiptNumber, depositId, ownerId: created.ownerId },
      actor.id
    );
    return created;
  }

  /** Server-side signature verification (tamper evidence for audits). */
  verifyReceipt(receipt: WarehouseReceipt): boolean {
    return verifyReceiptSignature(
      {
        receiptNumber: receipt.receiptNumber,
        depositId: deposit.id,
        warehouseId: receipt.warehouseId,
        ownerId: receipt.ownerId,
        crop: receipt.crop,
        grade: receipt.grade,
        bagCount: receipt.bagCount,
        weightKg: receipt.weightKg,
        issuedAt: receipt.issuedAt,
        nonce: receipt.nonce
      },
      receipt.signature,
      resolveReceiptSecret()
    );
  }

  // -- Receipts ------------------------------------------------------------------

  async getReceipt(id: string): Promise<WarehouseReceipt> {
    return this.receipts.getById(id);
  }

  async listReceiptsForOwner(ownerId: string): Promise<WarehouseReceipt[]> {
    const receipts = await this.receipts.find({ ownerId });
    return receipts.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  async listPledgesForReceipt(receiptId: string): Promise<WarehousePledge[]> {
    const pledges = await this.pledges.find({ receiptId });
    return pledges.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  }

  async listPledgesForLender(lenderId: string): Promise<WarehousePledge[]> {
    const pledges = await this.pledges.find({ lenderId });
    return pledges.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  }

  async listTransfersForReceipt(receiptId: string): Promise<WarehouseReceiptTransfer[]> {
    const transfers = await this.transfers.find({ receiptId });
    return transfers.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Receipt visibility: the owner, a lender holding a pledge on the receipt,
   * admin, or regulator (read-only oversight).
   */
  async assertReceiptViewer(receipt: WarehouseReceipt, actor: Actor): Promise<void> {
    if (actor.roles.includes('admin') || actor.roles.includes('regulator')) {
      return;
    }
    if (receipt.ownerId === actor.id) {
      return;
    }
    const pledged = await this.pledges.find({ receiptId: receipt.id, lenderId: actor.id });
    if (pledged.length > 0) {
      return;
    }
    throw new ForbiddenException('Only a receipt party may view this receipt');
  }

  // -- Pledge / lien (lender) -----------------------------------------------------

  /**
   * Register a lien: the receipt is pledged to the lender as loan collateral
   * and the pledge is recorded with the collateral registry port (STUB by
   * default — the basis label travels with the record). Fail-closed: when
   * the registry cannot confirm the registration, nothing is persisted.
   */
  async pledgeReceipt(
    receiptId: string,
    input: PledgeReceiptInput,
    lender: Actor
  ): Promise<{ receipt: WarehouseReceipt; pledge: WarehousePledge }> {
    if (!Number.isInteger(input.principalKobo) || input.principalKobo <= 0) {
      throw new BadRequestException('principalKobo must be a positive integer (kobo)');
    }
    const receipt = await this.receipts.getById(receiptId);
    if (receipt.status === 'pledged') {
      throw new ConflictException('This receipt is already pledged to a lender');
    }
    if (!WHR_TRANSITIONS[receipt.status].includes('pledged')) {
      throw new BadRequestException(
        `Receipt cannot be pledged from status '${receipt.status}'`
      );
    }
    const now = new Date().toISOString();
    const pledgeId = newId('whpledge');
    let registration;
    try {
      registration = await this.collateralRegistry.register({
        pledgeId,
        receiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        lenderId: lender.id,
        borrowerId: receipt.ownerId,
        principalKobo: input.principalKobo
      });
    } catch (error) {
      if (isProviderError(error)) {
        throw new ServiceUnavailableException(
          'Collateral registry is unavailable (fail-closed: the pledge was not recorded).'
        );
      }
      throw error;
    }
    // Fail closed (same doctrine as the deposit certification guard above):
    // a stub-basis registration is a fabricated reference — a lender lien
    // recorded on it in production would be legally meaningless and
    // unverifiable. Refuse the pledge instead of persisting it.
    if (isProduction() && registration.basis !== 'live') {
      throw new ServiceUnavailableException(
        'The collateral registry registration was not confirmed against the live national ' +
          'registry (basis is not live). Refusing the pledge in production — configure ' +
          'COLLATERAL_REGISTRY_DRIVER=live with the registry credentials.'
      );
    }
    const pledge: WarehousePledge = {
      id: pledgeId,
      receiptId: receipt.id,
      lenderId: lender.id,
      borrowerId: receipt.ownerId,
      principalKobo: input.principalKobo,
      terms: input.terms?.trim() ?? '',
      status: 'active',
      registryRef: registration.reference,
      registryBasis: registration.basis,
      registeredAt: now,
      createdAt: now,
      updatedAt: now
    };
    const updated = await this.transitionReceipt(receipt, 'pledged', lender.id);
    const created = await this.pledges.create(pledge);
    await this.audit?.record({
      actorId: lender.id,
      action: 'warehouse.receipt.pledged',
      entityType: 'warehouse_receipt',
      entityId: receipt.id,
      metadata: {
        pledgeId: created.id,
        principalKobo: created.principalKobo,
        registryRef: created.registryRef,
        registryBasis: created.registryBasis
      }
    });
    await this.events.publish(
      'warehouse.receipt.pledged',
      {
        receiptId: receipt.id,
        pledgeId: created.id,
        lenderId: lender.id,
        principalKobo: created.principalKobo,
        registryBasis: created.registryBasis
      },
      lender.id
    );
    return { receipt: updated, pledge: created };
  }

  /**
   * Release an active pledge (the registering lender or admin). The registry
   * release is fail-closed: when it cannot be confirmed, the lien stays.
   */
  async releasePledge(
    receiptId: string,
    actor: Actor
  ): Promise<{ receipt: WarehouseReceipt; pledge: WarehousePledge }> {
    const receipt = await this.receipts.getById(receiptId);
    const active = await this.pledges.findOne({ receiptId, status: 'active' });
    if (!active) {
      if (receipt.status === 'released') {
        const prior = (await this.listPledgesForReceipt(receiptId))[0];
        if (prior) {
          return { receipt, pledge: prior }; // idempotent replay
        }
      }
      throw new BadRequestException('No active pledge on this receipt');
    }
    // Entitlement BEFORE state: a non-pledge lender must not probe the flow.
    if (active.lenderId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the pledge-holding lender may release this pledge');
    }
    if (active.registryRef) {
      try {
        await this.collateralRegistry.release(active.registryRef);
      } catch (error) {
        if (isProviderError(error)) {
          throw new ServiceUnavailableException(
            'Collateral registry is unavailable (fail-closed: the pledge was not released).'
          );
        }
        throw error;
      }
    }
    const now = new Date().toISOString();
    const pledge = await this.pledges.update(active.id, {
      status: 'released',
      releasedAt: now,
      updatedAt: now
    });
    const updated = await this.transitionReceipt(receipt, 'released', actor.id);
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.pledge.released',
      entityType: 'warehouse_receipt',
      entityId: receipt.id,
      metadata: { pledgeId: active.id }
    });
    await this.events.publish(
      'warehouse.receipt.released',
      { receiptId: receipt.id, pledgeId: active.id, lenderId: active.lenderId },
      actor.id
    );
    return { receipt: updated, pledge };
  }

  // -- Transfer + redeem -----------------------------------------------------------

  /** Ownership transfer with an append-only audit record. */
  async transferReceipt(
    id: string,
    toOwnerId: string,
    actor: Actor,
    note?: string
  ): Promise<WarehouseReceipt> {
    const receipt = await this.receipts.getById(id);
    // Entitlement BEFORE state validity.
    if (receipt.ownerId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the receipt owner may transfer it');
    }
    if (!toOwnerId?.trim() || toOwnerId === receipt.ownerId) {
      throw new BadRequestException('toOwnerId must be a different user');
    }
    if (receipt.status === 'pledged') {
      throw new ConflictException('A pledged receipt cannot be transferred until the lien is released');
    }
    if (receipt.status === 'redeemed') {
      throw new BadRequestException('A redeemed receipt cannot be transferred');
    }
    const now = new Date().toISOString();
    const event = this.events.build(
      'warehouse.receipt.transferred',
      { receiptId: id, fromOwnerId: receipt.ownerId, toOwnerId },
      actor.id
    );
    const updated = await this.receipts.updateExpected(
      id,
      { ownerId: toOwnerId, updatedAt: now },
      { ownerId: receipt.ownerId, status: receipt.status },
      event
    );
    if (this.receipts.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.transfers.create({
      id: newId('whtransfer'),
      receiptId: id,
      fromOwnerId: receipt.ownerId,
      toOwnerId,
      transferredBy: actor.id,
      note: note?.trim() || undefined,
      createdAt: now
    });
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.receipt.transferred',
      entityType: 'warehouse_receipt',
      entityId: id,
      metadata: { fromOwnerId: receipt.ownerId, toOwnerId }
    });
    return updated;
  }

  /** Withdrawal: the grain is released and the receipt is REDEEMED. */
  async redeemReceipt(id: string, actor: Actor): Promise<WarehouseReceipt> {
    const receipt = await this.receipts.getById(id);
    // Entitlement BEFORE state validity (a non-owner must not be able to
    // probe even the terminal state).
    if (receipt.ownerId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the receipt owner may redeem it');
    }
    if (receipt.status === 'redeemed') {
      return receipt; // idempotent replay
    }
    if (receipt.status === 'pledged') {
      throw new ConflictException('A pledged receipt cannot be redeemed until the lien is released');
    }
    const updated = await this.transitionReceipt(receipt, 'redeemed', actor.id);
    await this.deposits.update(receipt.depositId, {
      status: 'withdrawn',
      updatedAt: new Date().toISOString()
    });
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.receipt.redeemed',
      entityType: 'warehouse_receipt',
      entityId: id,
      metadata: { depositId: receipt.depositId }
    });
    await this.events.publish(
      'warehouse.receipt.redeemed',
      { receiptId: id, depositId: receipt.depositId, ownerId: receipt.ownerId },
      actor.id
    );
    return updated;
  }

  // -- Oversight ---------------------------------------------------------------------

  /** Regulator/admin read-only audit export. */
  async exportRegistry(): Promise<WarehouseRegistryExport> {
    const receipts = (await this.receipts.all()).sort((a, b) =>
      a.receiptNumber.localeCompare(b.receiptNumber)
    );
    const pledges = (await this.pledges.all()).sort((a, b) =>
      a.registeredAt.localeCompare(b.registeredAt)
    );
    const transfers = (await this.transfers.all()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    return { receipts, pledges, transfers, exportedAt: new Date().toISOString() };
  }

  /** Honest driver labels for the UI basis badges. */
  integrationStatus(): WarehouseIntegrationStatus {
    return {
      certificationDriver: this.certificationFeed.name,
      collateralRegistryDriver: this.collateralRegistry.name
    };
  }

  // -- internals ----------------------------------------------------------------------

  private receiptNumber(depositId: string, nonce: string): string {
    const suffix = createHash('sha256')
      .update(`warehouse-receipt:${depositId}:${nonce}`)
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();
    return `WHR-${new Date().getUTCFullYear()}-${suffix}`;
  }

  private async transitionReceipt(
    receipt: WarehouseReceipt,
    status: WarehouseReceiptStatus,
    actorId: string
  ): Promise<WarehouseReceipt> {
    if (!WHR_TRANSITIONS[receipt.status].includes(status)) {
      throw new BadRequestException(
        `Invalid receipt transition from '${receipt.status}' to '${status}'`
      );
    }
    const event = this.events.build(
      'warehouse.receipt.status_changed',
      { receiptId: receipt.id, from: receipt.status, to: status },
      actorId
    );
    const updated = await this.receipts.updateExpected(
      receipt.id,
      { status, updatedAt: new Date().toISOString() },
      { status: receipt.status },
      event
    );
    if (this.receipts.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    return updated;
  }
}

/** Re-exported for the controller's verify endpoint payload assembly. */
export { canonicalReceiptPayload };
