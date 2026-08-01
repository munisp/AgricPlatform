import { SkeletonBlock } from '@/components/api-state';

/** Route-level loading state (used by each route's loading.tsx). */
export function RouteLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="container">
      <p className="kicker" role="status">
        {label}
      </p>
      <div className="grid grid-2" style={{ marginTop: '1rem' }}>
        <SkeletonBlock lines={4} />
        <SkeletonBlock lines={4} />
      </div>
    </div>
  );
}
