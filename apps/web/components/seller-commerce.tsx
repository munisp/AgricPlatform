'use client';

import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchSellerAnalytics, listPromotions, listReturns } from '@/lib/api/endpoints';
import { demoPromotions, demoReturnRequests, demoSellerAnalytics } from '@/lib/content';
import { T, useT } from '@/lib/i18n';
import { AutoBadge, Card, EmptyState, formatKobo } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Wave M seller dashboard: revenue, order counts by status, fulfilment /
 * dispute / return rates, top variants, promotions and the return queue.
 * Party-scoped at the API (sellers see their own numbers; admins see all).
 */
export function SellerAnalyticsPanel() {
  const { userId } = useAppState();
  const { t } = useT();
  const query = useApiQuery(
    `commerce:seller-analytics:${userId}`,
    () => fetchSellerAnalytics(userId).then((res) => res.data),
    { fallbackData: demoSellerAnalytics, staleTimeMs: 60_000 }
  );
  const analytics = query.data ?? demoSellerAnalytics;
  return (
    <div className="stack">
      {query.source === 'fallback' && query.error ? (
        <OfflineDataNotice>
          <T k="commerce.offlineNotice" />
        </OfflineDataNotice>
      ) : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <div className="grid grid-3">
          <Card title={<T k="commerce.revenueLabel" />}>
            <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>{formatKobo(analytics.revenueKobo)}</p>
          </Card>
          <Card title={<T k="commerce.ordersLabel" />}>
            <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>{analytics.totalOrders}</p>
            <ul className="small muted" aria-label="Orders by status">
              {Object.entries(analytics.orderCounts).map(([status, count]) => (
                <li key={status}>
                  {status}: {count}
                </li>
              ))}
            </ul>
          </Card>
          <Card title={<T k="commerce.ratingLabel" />}>
            <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>
              {analytics.sellerRating ? `${analytics.sellerRating.average} / 5` : '—'}
            </p>
            <p className="small muted">{analytics.sellerRating?.reviewCount ?? 0} reviews</p>
          </Card>
          <Card title={<T k="commerce.fulfilmentLabel" />}>
            <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>{formatPercent(analytics.fulfilmentRate)}</p>
          </Card>
          <Card title={<T k="commerce.disputeLabel" />}>
            <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>{formatPercent(analytics.disputeRate)}</p>
          </Card>
          <Card title={<T k="commerce.returnLabel" />}>
            <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>{formatPercent(analytics.returnRate)}</p>
          </Card>
        </div>
        <Card title={<T k="commerce.topVariantsTitle" />}>
          {analytics.topVariants.length === 0 ? (
            <EmptyState title={t('commerce.noVariants')} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Variant</th>
                  <th scope="col">Units</th>
                  <th scope="col">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {analytics.topVariants.map((variant) => (
                  <tr key={variant.variantId}>
                    <td>{variant.sku}</td>
                    <td>{variant.name}</td>
                    <td>{variant.unitsSold}</td>
                    <td>{formatKobo(variant.revenueKobo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </QueryState>
    </div>
  );
}

export function PromotionsPanel() {
  const { t } = useT();
  const query = useApiQuery('commerce:promotions', () => listPromotions().then((res) => res.data), {
    fallbackData: demoPromotions,
    staleTimeMs: 60_000
  });
  const promotions = query.data ?? demoPromotions;
  return (
    <div className="stack">
      {query.source === 'fallback' && query.error ? (
        <OfflineDataNotice>
          <T k="commerce.offlineNotice" />
        </OfflineDataNotice>
      ) : null}
      {promotions.length === 0 ? (
        <EmptyState title={t('commerce.noPromotions')} />
      ) : (
        <ul className="stack" aria-label="Promotions">
          {promotions.map((promotion) => (
            <li key={promotion.id} className="cluster" style={{ justifyContent: 'space-between' }}>
              <span>
                <strong>{promotion.name}</strong>{' '}
                <span className="small muted">
                  {promotion.code ? `${promotion.code} · ` : ''}
                  {promotion.kind === 'percentage'
                    ? `${promotion.value / 100}% off`
                    : `${formatKobo(promotion.value)} off`}
                  {promotion.usageLimit ? ` · ${promotion.usedCount}/${promotion.usageLimit} used` : ''}
                </span>
              </span>
              <AutoBadge
                value={promotion.isActive ? (promotion.automatic ? 'automatic' : 'coupon') : 'inactive'}
                ariaLabel={`Promotion ${promotion.name}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReturnsQueuePanel() {
  const { t } = useT();
  const query = useApiQuery('commerce:returns', () => listReturns().then((res) => res.data), {
    fallbackData: demoReturnRequests,
    staleTimeMs: 30_000
  });
  const returns = query.data ?? demoReturnRequests;
  return (
    <div className="stack">
      {query.source === 'fallback' && query.error ? (
        <OfflineDataNotice>
          <T k="commerce.offlineNotice" />
        </OfflineDataNotice>
      ) : null}
      {returns.length === 0 ? (
        <EmptyState title={t('commerce.noReturns')} />
      ) : (
        <ul className="stack" aria-label="Return requests">
          {returns.map((request) => (
            <li key={request.id} className="cluster" style={{ justifyContent: 'space-between' }}>
              <span>
                <strong>{request.reason}</strong>{' '}
                <span className="small muted">
                  {request.orderId} · {new Date(request.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                </span>
              </span>
              <AutoBadge value={request.status} ariaLabel={`Return status: ${request.status}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
