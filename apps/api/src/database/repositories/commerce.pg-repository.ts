import type pg from 'pg';
import type { EscrowRecord, Invoice, Shipment } from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { escrowMapper, invoiceMapper, shipmentMapper } from '../pg/row-mappers.js';
import type { EscrowCriteria, EscrowRepository } from './escrow.repository.js';
import type { InvoiceCriteria, InvoiceRepository } from './invoice.repository.js';
import type { ShipmentCriteria, ShipmentRepository } from './shipment.repository.js';

/**
 * Wave P2a marketplace depth pg repositories (marketplace.escrow_records,
 * marketplace.invoices + invoice_counters, marketplace.shipments).
 */
export function escrowCriteriaSql(criteria: EscrowCriteria): WhereClause {
  return composeWhere(eq('order_id', criteria.orderId), eq('status', criteria.status));
}

export class PgEscrowRepository
  extends PgRepositoryBase<EscrowRecord, EscrowCriteria>
  implements EscrowRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.escrow_records',
      mapper: escrowMapper,
      criteria: escrowCriteriaSql
    });
  }
}

export function invoiceCriteriaSql(criteria: InvoiceCriteria): WhereClause {
  return composeWhere(
    eq('order_id', criteria.orderId),
    eq('seller_id', criteria.sellerId),
    eq('buyer_id', criteria.buyerId),
    eq('status', criteria.status)
  );
}

export class PgInvoiceRepository
  extends PgRepositoryBase<Invoice, InvoiceCriteria>
  implements InvoiceRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'marketplace.invoices', mapper: invoiceMapper, criteria: invoiceCriteriaSql });
  }

  /**
   * Per-seller sequence allocation with INSERT … ON CONFLICT … RETURNING so
   * concurrent issuances cannot collide (same pattern as learning counters).
   */
  async nextInvoiceSequence(sellerId: string): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO marketplace.invoice_counters (seller_id, next)
       VALUES ($1, 2)
       ON CONFLICT (seller_id) DO UPDATE SET next = marketplace.invoice_counters.next + 1
       RETURNING next - 1 AS sequence`,
      [sellerId]
    );
    return result.rows[0].sequence as number;
  }
}

export function shipmentCriteriaSql(criteria: ShipmentCriteria): WhereClause {
  return composeWhere(eq('order_id', criteria.orderId), eq('status', criteria.status));
}

export class PgShipmentRepository
  extends PgRepositoryBase<Shipment, ShipmentCriteria>
  implements ShipmentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.shipments',
      mapper: shipmentMapper,
      criteria: shipmentCriteriaSql
    });
  }
}

export function createPgEscrowRepository(pool: pg.Pool): PgEscrowRepository {
  return new PgEscrowRepository(pool);
}

export function createPgInvoiceRepository(pool: pg.Pool): PgInvoiceRepository {
  return new PgInvoiceRepository(pool);
}

export function createPgShipmentRepository(pool: pg.Pool): PgShipmentRepository {
  return new PgShipmentRepository(pool);
}
