import type {
  CertifiedWarehouse,
  WarehouseCertificationStatus,
  WarehouseDeposit,
  WarehouseDepositStatus,
  WarehousePledge,
  WarehousePledgeStatus,
  WarehouseReceipt,
  WarehouseReceiptStatus,
  WarehouseReceiptTransfer
} from '@agric-platform/shared';
import { ConflictException } from '@nestjs/common';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/* ----------------------------------------------------------- warehouses -- */

export interface CertifiedWarehouseCriteria {
  state?: string;
  lga?: string;
  certificationStatus?: WarehouseCertificationStatus;
  h3Cell?: string;
}

export type CertifiedWarehouseRepository = AsyncRepository<
  CertifiedWarehouse,
  CertifiedWarehouseCriteria
>;

export function certifiedWarehouseMatcher(
  criteria: CertifiedWarehouseCriteria
): (warehouse: CertifiedWarehouse) => boolean {
  return (warehouse) =>
    (!criteria.state || warehouse.state === criteria.state) &&
    (!criteria.lga || warehouse.lga === criteria.lga) &&
    (!criteria.certificationStatus ||
      warehouse.certificationStatus === criteria.certificationStatus) &&
    (!criteria.h3Cell || warehouse.h3Cell === criteria.h3Cell);
}

export class InMemoryCertifiedWarehouseRepository
  extends InMemoryRepository<CertifiedWarehouse, CertifiedWarehouseCriteria>
  implements CertifiedWarehouseRepository
{
  constructor(seed: readonly CertifiedWarehouse[] = []) {
    super(seed, certifiedWarehouseMatcher);
  }
}

export function createInMemoryCertifiedWarehouseRepository(): InMemoryCertifiedWarehouseRepository {
  return new InMemoryCertifiedWarehouseRepository();
}

/* ------------------------------------------------------------- deposits -- */

export interface WarehouseDepositCriteria {
  warehouseId?: string;
  farmerId?: string;
  lotId?: string;
  status?: WarehouseDepositStatus;
}

export type WarehouseDepositRepository = AsyncRepository<
  WarehouseDeposit,
  WarehouseDepositCriteria
>;

export function warehouseDepositMatcher(
  criteria: WarehouseDepositCriteria
): (deposit: WarehouseDeposit) => boolean {
  return (deposit) =>
    (!criteria.warehouseId || deposit.warehouseId === criteria.warehouseId) &&
    (!criteria.farmerId || deposit.farmerId === criteria.farmerId) &&
    (!criteria.lotId || deposit.lotId === criteria.lotId) &&
    (!criteria.status || deposit.status === criteria.status);
}

export class InMemoryWarehouseDepositRepository
  extends InMemoryRepository<WarehouseDeposit, WarehouseDepositCriteria>
  implements WarehouseDepositRepository
{
  constructor(seed: readonly WarehouseDeposit[] = []) {
    super(seed, warehouseDepositMatcher);
  }

  /**
   * V-21: mirror the pg partial unique index
   * `warehouse_deposits_open_lot_uq ON warehouse.deposits (lot_id)
   * WHERE status <> 'withdrawn'` (migration 080). Synchronous check-and-set:
   * the scan and the insert happen in one tick, so concurrent claims for the
   * same lot serialise exactly like the guarded INSERT (second claim → 409).
   */
  override async create(deposit: WarehouseDeposit): Promise<WarehouseDeposit> {
    if (deposit.lotId !== undefined && deposit.status !== 'withdrawn') {
      for (const existing of this.items.values()) {
        if (existing.lotId === deposit.lotId && existing.status !== 'withdrawn') {
          throw new ConflictException(
            `Commodity lot '${deposit.lotId}' already has an open warehouse deposit`
          );
        }
      }
    }
    return super.create(deposit);
  }
}

export function createInMemoryWarehouseDepositRepository(): InMemoryWarehouseDepositRepository {
  return new InMemoryWarehouseDepositRepository();
}

/* ------------------------------------------------------------- receipts -- */

export interface WarehouseReceiptCriteria {
  depositId?: string;
  warehouseId?: string;
  ownerId?: string;
  status?: WarehouseReceiptStatus;
  receiptNumber?: string;
}

export type WarehouseReceiptRepository = AsyncRepository<
  WarehouseReceipt,
  WarehouseReceiptCriteria
>;

export function warehouseReceiptMatcher(
  criteria: WarehouseReceiptCriteria
): (receipt: WarehouseReceipt) => boolean {
  return (receipt) =>
    (!criteria.depositId || receipt.depositId === criteria.depositId) &&
    (!criteria.warehouseId || receipt.warehouseId === criteria.warehouseId) &&
    (!criteria.ownerId || receipt.ownerId === criteria.ownerId) &&
    (!criteria.status || receipt.status === criteria.status) &&
    (!criteria.receiptNumber || receipt.receiptNumber === criteria.receiptNumber);
}

export class InMemoryWarehouseReceiptRepository
  extends InMemoryRepository<WarehouseReceipt, WarehouseReceiptCriteria>
  implements WarehouseReceiptRepository
{
  constructor(seed: readonly WarehouseReceipt[] = []) {
    super(seed, warehouseReceiptMatcher);
  }

  /**
   * Mirror the pg UNIQUE index `warehouse_receipts_deposit_idx ON
   * warehouse.receipts (deposit_id)` (034_warehouse.sql): one receipt per
   * deposit. Synchronous check-and-set so concurrent issuance serialises
   * (second claim → 409 → service adopts the winner's receipt).
   */
  override async create(receipt: WarehouseReceipt): Promise<WarehouseReceipt> {
    for (const existing of this.items.values()) {
      if (existing.depositId === receipt.depositId) {
        throw new ConflictException(
          `Deposit '${receipt.depositId}' already has a warehouse receipt`
        );
      }
    }
    return super.create(receipt);
  }
}

export function createInMemoryWarehouseReceiptRepository(): InMemoryWarehouseReceiptRepository {
  return new InMemoryWarehouseReceiptRepository();
}

/* -------------------------------------------------------------- pledges -- */

export interface WarehousePledgeCriteria {
  receiptId?: string;
  lenderId?: string;
  borrowerId?: string;
  status?: WarehousePledgeStatus;
}

export type WarehousePledgeRepository = AsyncRepository<WarehousePledge, WarehousePledgeCriteria>;

export function warehousePledgeMatcher(
  criteria: WarehousePledgeCriteria
): (pledge: WarehousePledge) => boolean {
  return (pledge) =>
    (!criteria.receiptId || pledge.receiptId === criteria.receiptId) &&
    (!criteria.lenderId || pledge.lenderId === criteria.lenderId) &&
    (!criteria.borrowerId || pledge.borrowerId === criteria.borrowerId) &&
    (!criteria.status || pledge.status === criteria.status);
}

export class InMemoryWarehousePledgeRepository
  extends InMemoryRepository<WarehousePledge, WarehousePledgeCriteria>
  implements WarehousePledgeRepository
{
  constructor(seed: readonly WarehousePledge[] = []) {
    super(seed, warehousePledgeMatcher);
  }
}

export function createInMemoryWarehousePledgeRepository(): InMemoryWarehousePledgeRepository {
  return new InMemoryWarehousePledgeRepository();
}

/* ------------------------------------------------------------ transfers -- */

export interface WarehouseTransferCriteria {
  receiptId?: string;
  fromOwnerId?: string;
  toOwnerId?: string;
}

export type WarehouseTransferRepository = AsyncRepository<
  WarehouseReceiptTransfer,
  WarehouseTransferCriteria
>;

export function warehouseTransferMatcher(
  criteria: WarehouseTransferCriteria
): (transfer: WarehouseReceiptTransfer) => boolean {
  return (transfer) =>
    (!criteria.receiptId || transfer.receiptId === criteria.receiptId) &&
    (!criteria.fromOwnerId || transfer.fromOwnerId === criteria.fromOwnerId) &&
    (!criteria.toOwnerId || transfer.toOwnerId === criteria.toOwnerId);
}

export class InMemoryWarehouseTransferRepository
  extends InMemoryRepository<WarehouseReceiptTransfer, WarehouseTransferCriteria>
  implements WarehouseTransferRepository
{
  constructor(seed: readonly WarehouseReceiptTransfer[] = []) {
    super(seed, warehouseTransferMatcher);
  }
}

export function createInMemoryWarehouseTransferRepository(): InMemoryWarehouseTransferRepository {
  return new InMemoryWarehouseTransferRepository();
}
