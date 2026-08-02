import { apiUrl, getAuthIdentity } from './client';
import { DEFAULT_TIMEOUT_MS } from './config';
import { NetworkError, TimeoutError, isApiErrorEnvelope, toApiError } from './errors';

export type AnalyticsExportFormat = 'csv' | 'pdf';

/**
 * Downloads `GET /analytics/export?format=csv|pdf` as a file. The typed JSON
 * client cannot be used here (the endpoint streams an attachment), so this
 * shares the client's URL builder and auth headers and works on blobs.
 * Never fails silently: network/HTTP errors are thrown for the caller to
 * surface with an explicit retry.
 */
export async function downloadAnalyticsExport(format: AnalyticsExportFormat): Promise<string> {
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
    response = await fetch(apiUrl('/analytics/export', { format }), {
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
      path: '/analytics/export',
      timestamp: new Date().toISOString()
    });
  }

  const blob = await response.blob();
  const fileName = `analytics-export.${format}`;
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
