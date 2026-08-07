import type pg from 'pg';
import type {
  CertifiedWarehouse,
  WarehouseDeposit,
  WarehousePledge,
  WarehouseReceipt,
  WarehouseReceiptTransfer
} from '@agric-platform/shared';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import {
  certifiedWarehouseMapper,
  warehouseDepositMapper,
  warehousePledgeMapper,
  warehouseReceiptMapper,
  warehouseTransferMapper
} from '../pg/row-mappers.js';
import type {
  CertifiedWarehouseCriteria,
  CertifiedWarehouseRepository,
  WarehouseDepositCriteria,
  WarehouseDepositRepository,
  WarehousePledgeCriteria,
  WarehousePledgeRepository,
  WarehouseReceiptCriteria,
  WarehouseReceiptRepository,
  WarehouseTransferCriteria,
  WarehouseTransferRepository
} from './warehouse.repository.js';

export function certifiedWarehouseCriteriaSql(criteria: CertifiedWarehouseCriteria): WhereClause {
  return composeWhere(
    eq('state', criteria.state),
    eq('lga', criteria.lga),
    eq('certification_status', criteria.certificationStatus),
    eq('h3_cell', criteria.h3Cell)
  );
}

export class PgCertifiedWarehouseRepository
  extends PgRepositoryBase<CertifiedWarehouse, CertifiedWarehouseCriteria>
  implements CertifiedWarehouseRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'warehouse.warehouses',
      mapper: certifiedWarehouseMapper,
      criteria: certifiedWarehouseCriteriaSql
    });
  }
}

export function warehouseDepositCriteriaSql(criteria: WarehouseDepositCriteria): WhereClause {
  return composeWhere(
    eq('warehouse_id', criteria.warehouseId),
    eq('farmer_id', criteria.farmerId),
    eq('lot_id', criteria.lotId),
    eq('status', criteria.status)
  );
}

export class PgWarehouseDepositRepository
  extends PgRepositoryBase<WarehouseDeposit, WarehouseDepositCriteria>
  implements WarehouseDepositRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'warehouse.deposits',
      mapper: warehouseDepositMapper,
      criteria: warehouseDepositCriteriaSql
    });
  }
}

export function warehouseReceiptCriteriaSql(criteria: WarehouseReceiptCriteria): WhereClause {
  return composeWhere(
    eq('deposit_id', criteria.depositId),
    eq('warehouse_id', criteria.warehouseId),
    eq('owner_id', criteria.ownerId),
    eq('status', criteria.status),
    eq('receipt_number', criteria.receiptNumber)
  );
}

export class PgWarehouseReceiptRepository
  extends PgRepositoryBase<WarehouseReceipt, WarehouseReceiptCriteria>
  implements WarehouseReceiptRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'warehouse.receipts',
      mapper: warehouseReceiptMapper,
      criteria: warehouseReceiptCriteriaSql
    });
  }
}

export function warehousePledgeCriteriaSql(criteria: WarehousePledgeCriteria): WhereClause {
  return composeWhere(
    eq('receipt_id', criteria.receiptId),
    eq('lender_id', criteria.lenderId),
    eq('borrower_id', criteria.borrowerId),
    eq('status', criteria.status)
  );
}

export class PgWarehousePledgeRepository
  extends PgRepositoryBase<WarehousePledge, WarehousePledgeCriteria>
  implements WarehousePledgeRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'warehouse.pledges',
      mapper: warehousePledgeMapper,
      criteria: warehousePledgeCriteriaSql
    });
  }
}

export function warehouseTransferCriteriaSql(criteria: WarehouseTransferCriteria): WhereClause {
  return composeWhere(
    eq('receipt_id', criteria.receiptId),
    eq('from_owner_id', criteria.fromOwnerId),
    eq('to_owner_id', criteria.toOwnerId)
  );
}

export class PgWarehouseTransferRepository
  extends PgRepositoryBase<WarehouseReceiptTransfer, WarehouseTransferCriteria>
  implements WarehouseTransferRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'warehouse.transfers',
      mapper: warehouseTransferMapper,
      criteria: warehouseTransferCriteriaSql
    });
  }
}

export function createPgCertifiedWarehouseRepository(pool: pg.Pool): PgCertifiedWarehouseRepository {
  return new PgCertifiedWarehouseRepository(pool);
}

export function createPgWarehouseDepositRepository(pool: pg.Pool): PgWarehouseDepositRepository {
  return new PgWarehouseDepositRepository(pool);
}

export function createPgWarehouseReceiptRepository(pool: pg.Pool): PgWarehouseReceiptRepository {
  return new PgWarehouseReceiptRepository(pool);
}

export function createPgWarehousePledgeRepository(pool: pg.Pool): PgWarehousePledgeRepository {
  return new PgWarehousePledgeRepository(pool);
}

export function createPgWarehouseTransferRepository(pool: pg.Pool): PgWarehouseTransferRepository {
  return new PgWarehouseTransferRepository(pool);
}
