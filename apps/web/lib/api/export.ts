import { apiUrl, getAuthIdentity } from './client';
import type { QueryValue } from './client';
import { DEFAULT_TIMEOUT_MS } from './config';
import { NetworkError, TimeoutError, isApiErrorEnvelope, toApiError } from './errors';

export type AnalyticsExportFormat = 'csv' | 'pdf';

/**
 * Downloads an attachment endpoint as a file. The typed JSON client cannot be
 * used here (the endpoint streams an attachment), so this shares the client's
 * URL builder and auth headers and works on blobs.
 * Never fails silently: network/HTTP errors are thrown for the caller to
 * surface with an explicit retry.
 */
async function downloadAttachment(
  path: string,
  query: Record<string, QueryValue> | undefined,
  fileName: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new TimeoutError(DEFAULT_TIMEOUT_MS)), DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {};
  const identity = getAuthIdentity();
  if (identity?.token) {
    headers.Authorization = `Bearer ${identity.token}`;
  } else if (identity?.userId) {
    headers['x-user-id'] = identity.userId;
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path, query), {
      headers,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof TimeoutError) throw error;
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TimeoutError(DEFAULT_TIMEOUT_MS);
    }
    throw new NetworkError(error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let envelope: unknown = null;
    try {
      envelope = await response.json();
    } catch {
      // Non-JSON error body (proxy page, empty 502…)
    }
    if (isApiErrorEnvelope(envelope)) {
      throw toApiError(envelope);
    }
    throw toApiError({
      statusCode: response.status,
      error: response.statusText || 'HTTP Error',
      message: `Export failed with status ${response.status}`,
      path,
      timestamp: new Date().toISOString()
    });
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Delay revocation so the click navigation has started.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return fileName;
}

/** Downloads `GET /analytics/export?format=csv|pdf` as a file. */
export async function downloadAnalyticsExport(format: AnalyticsExportFormat): Promise<string> {
  return downloadAttachment('/analytics/export', { format }, `analytics-export.${format}`);
}

/**
 * Downloads `GET /analytics/marts/:mart/export?from&to` (lakehouse handoff
 * CSV). Admin only; audit-logged on the API. Matches the API's
 * Content-Disposition filename (`mart-<name>.csv`).
 */
export async function downloadMartExport(
  mart: string,
  range: { from?: string; to?: string } = {}
): Promise<string> {
  const fileName = `mart-${mart.replace(/_/g, '-')}.csv`;
  return downloadAttachment(
    `/analytics/marts/${encodeURIComponent(mart)}/export`,
    { from: range.from, to: range.to },
    fileName
  );
}
