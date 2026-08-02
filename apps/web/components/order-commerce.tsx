'use client';

import { useState } from 'react';
import { VAT_RATE_BPS } from '@agric-platform/shared';
import type { EscrowRecord, Invoice, Order, Shipment } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  fetchOrderEscrow,
  fetchOrderShipment,
  holdOrderEscrow,
  listInvoices
} from '@/lib/api/endpoints';
import { ApiErrorNotice } from '@/components/api-state';
import { AutoBadge, StatusBadge, Timeline, formatKobo } from '@/components/ui';

const SHIPMENT_FLOW = ['pickup_scheduled', 'in_transit', 'delivered', 'confirmed'] as const;

function EscrowPanel({ order, escrow, onChanged }: { order: Order; escrow: EscrowRecord | null; onChanged: () => void }) {
  const holdMutation = useApiMutation<void, EscrowRecord>({
    mutationFn: () => holdOrderEscrow(order.id).then((res) => res.data),
    onSuccess: () => onChanged()
  });

  if (!escrow) {
    return (
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">No escrow held for this order yet.</span>
        {order.escrowRequired ? (
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={holdMutation.status === 'pending'}
            onClick={() => void holdMutation.mutate()}
          >
            {holdMutation.status === 'pending' ? 'Holding…' : 'Hold escrow'}
          </button>
        ) : null}
        {holdMutation.status === 'error' ? <ApiErrorNotice error={holdMutation.error} /> : null}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700 }}>{formatKobo(escrow.amountKobo)}</span>
        <AutoBadge value={escrow.status} ariaLabel={`Escrow status: ${escrow.status}`} />
      </div>
      <Timeline
        items={[
          {
            id: 'held',
            title: 'Held in escrow',
            date: new Date(escrow.heldAt).toLocaleDateString('en-NG', { dateStyle: 'medium' }),
            tone: escrow.status === 'held' ? 'warning' : 'default'
          },
          ...(escrow.resolvedAt
            ? [
                {
                  id: 'resolved',
                  title: escrow.status === 'released' ? 'Released to seller' : escrow.status === 'refunded' ? 'Refunded to buyer' : 'In dispute',
                  date: new Date(escrow.resolvedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' }),
                  tone: 'default' as const
                }
              ]
            : [])
        ]}
      />
    </div>
  );
}

function ShipmentPanel({ shipment }: { shipment: Shipment | null }) {
  if (!shipment) {
    return <p className="small muted">No shipment scheduled yet.</p>;
  }
  const failed = shipment.status === 'failed';
  const currentIndex = SHIPMENT_FLOW.indexOf(shipment.status as (typeof SHIPMENT_FLOW)[number]);
  const items = SHIPMENT_FLOW.slice(0, failed ? SHIPMENT_FLOW.length : Math.max(currentIndex + 1, 1)).map(
    (status, index) => ({
      id: status,
      title: status.replace(/_/g, ' '),
      tone: (index === currentIndex && !failed ? 'warning' : 'default') as 'warning' | 'default'
    })
  );
  if (failed) {
    items.push({ id: 'failed', title: 'failed', tone: 'default' });
  }
  return (
    <div className="stack">
      <p className="small muted">
        {shipment.carrier ? `Carrier: ${shipment.carrier}` : 'Carrier to be confirmed'}
        {shipment.trackingReference ? ` · Tracking: ${shipment.trackingReference}` : ''}
      </p>
      <Timeline items={items} />
      {failed && shipment.failureReason ? (
        <StatusBadge tone="critical">{shipment.failureReason}</StatusBadge>
      ) : null}
    </div>
  );
}

function InvoiceView({ invoice }: { invoice: Invoice }) {
  return (
    <div className="stack">
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <strong>{invoice.invoiceNumber}</strong>
        <AutoBadge value={invoice.status} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Unit price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((item, index) => (
              <tr key={`${item.description}-${index}`}>
                <td>{item.description}</td>
                <td>{item.quantity}</td>
                <td>{formatKobo(item.unitPriceKobo)}</td>
                <td>{formatKobo(item.totalKobo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="stack" style={{ alignItems: 'flex-end' }}>
        <span className="small muted">Subtotal: {formatKobo(invoice.subtotalKobo)}</span>
        <span className="small muted">
          VAT ({(VAT_RATE_BPS / 100).toFixed(1)}%): {formatKobo(invoice.vatKobo)}
        </span>
        <span style={{ fontWeight: 800 }}>Total: {formatKobo(invoice.totalKobo)}</span>
      </div>
    </div>
  );
}

/**
 * Order fulfilment depth (Wave P2a wiring): escrow status + timeline, VAT
 * invoice and shipment tracking for one marketplace order.
 */
export function OrderCommercePanel({ order }: { order: Order }) {
  const { userId, hydrated } = useAppState();
  const [open, setOpen] = useState(false);

  const escrowQuery = useApiQuery(
    open ? `order-escrow:${order.id}` : null,
    () => fetchOrderEscrow(order.id).then((res) => res.data),
    { enabled: open }
  );
  const shipmentQuery = useApiQuery(
    open ? `order-shipment:${order.id}` : null,
    () => fetchOrderShipment(order.id).then((res) => res.data),
    { enabled: open }
  );
  const invoicesQuery = useApiQuery(
    open && hydrated ? `invoices:buyer:${userId}` : null,
    () => listInvoices({ buyerId: userId }).then((res) => res.data),
    { fallbackData: [], enabled: open && hydrated }
  );

  const invoice = (invoicesQuery.data ?? []).find((entry) => entry.orderId === order.id) ?? null;

  return (
    <div style={{ marginTop: '0.5rem' }}>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? 'Hide fulfilment' : 'Track fulfilment'}
      </button>
      {open ? (
        <div className="grid grid-2" style={{ marginTop: '0.75rem' }}>
          <section aria-label="Escrow">
            <h4>Escrow</h4>
            {escrowQuery.error ? (
              <ApiErrorNotice error={escrowQuery.error} onRetry={escrowQuery.refresh} />
            ) : escrowQuery.isLoading ? (
              <p className="small muted">Loading escrow…</p>
            ) : (
              <EscrowPanel
                order={order}
                escrow={escrowQuery.data ?? null}
                onChanged={() => escrowQuery.refresh()}
              />
            )}
          </section>
          <section aria-label="Shipment">
            <h4>Shipment</h4>
            {shipmentQuery.error ? (
              <ApiErrorNotice error={shipmentQuery.error} onRetry={shipmentQuery.refresh} />
            ) : shipmentQuery.isLoading ? (
              <p className="small muted">Loading shipment…</p>
            ) : (
              <ShipmentPanel shipment={shipmentQuery.data ?? null} />
            )}
          </section>
          <section aria-label="Invoice" style={{ gridColumn: '1 / -1' }}>
            <h4>Invoice</h4>
            {invoice ? (
              <InvoiceView invoice={invoice} />
            ) : (
              <p className="small muted">No invoice issued for this order yet.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
