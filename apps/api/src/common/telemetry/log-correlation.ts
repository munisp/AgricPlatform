import { trace } from '@opentelemetry/api';
import { TENANT_ATTRIBUTE, TenantContext } from './tenant-context.js';

/**
 * Log correlation (integration map §2). pino `mixin` adding trace/span ids
 * (from the active OTel span) and the tenant id (from TenantContext) to every
 * log line emitted inside a traced request. Wired in
 * `common/logging/logging.module.ts` as `pinoHttp.mixin`.
 *
 * Returns an empty object when no span is active or telemetry is disabled
 * (the OTel API is a no-op without the SDK), and never throws — logging must
 * not break because observability did.
 */
export function telemetryLogMixin(): Record<string, unknown> {
  try {
    const out: Record<string, unknown> = {};
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext && trace.isSpanContextValid(spanContext)) {
      out['trace_id'] = spanContext.traceId;
      out['span_id'] = spanContext.spanId;
    }
    const tenantId = TenantContext.currentTenantId();
    if (tenantId) {
      out[TENANT_ATTRIBUTE] = tenantId;
    }
    return out;
  } catch {
    return {};
  }
}
