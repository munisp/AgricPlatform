import { appendFileSync } from 'node:fs';
import type { AuditAnchor } from '@agric-platform/shared';

/**
 * External anchor sink (Stage 23). Anchors that live ONLY in the same
 * database as the audit chain bound the truncation window to the last
 * checkpoint but do not eliminate it — an attacker with DB write can delete
 * the anchors too. The sink ships every anchor off-box as one JSON line
 * (append-only JSONL) so an external log aggregator (or, eventually, an
 * independent timestamping authority — an ops follow-up) holds evidence the
 * database attacker cannot rewrite.
 *
 * Configuration: AUDIT_ANCHOR_SINK. Unset = no sink (default; the audit
 * append path and boot are never affected). Supported schemes:
 *   file:<path>            — append each anchor as one JSON line to <path>.
 *   http(s)://<endpoint>   — POST each anchor as one JSON document to the
 *                            endpoint (L-18: optional remote sink, e.g. an
 *                            independent log service / timestamping
 *                            authority that a DB-write attacker cannot
 *                            rewrite). 5s timeout; non-2xx fails loudly.
 *
 * An unknown scheme is a configuration error, but it is surfaced LAZILY on
 * the first anchor attempt (FailingAnchorSink.append throws), never at boot:
 * a misconfigured optional sink must not crash the API.
 */

/** Configuration error raised on the first anchor attempt (never at boot). */
export class AnchorSinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorSinkConfigError';
  }
}

export interface AuditAnchorSink {
  /**
   * Persists one anchor. Throws/rejects on failure (fail loudly) — a sink
   * failure must never be swallowed, it means the off-box evidence copy is
   * missing. Async for the remote (http) sink; sync for file.
   */
  append(anchor: AuditAnchor): void | Promise<void>;
}

/**
 * Append-only JSONL file sink. One JSON object per line with a fixed key
 * order so shipped lines diff/grep stably; sync I/O keeps the semantics
 * obvious (the anchor is durably appended before createAnchor returns).
 */
export class FileAnchorSink implements AuditAnchorSink {
  constructor(private readonly path: string) {}

  append(anchor: AuditAnchor): void {
    const line = JSON.stringify({
      id: anchor.id,
      anchoredThroughEventId: anchor.anchoredThroughEventId,
      tipHash: anchor.tipHash,
      eventCount: anchor.eventCount,
      prevAnchorHash: anchor.prevAnchorHash,
      anchorHash: anchor.anchorHash,
      createdAt: anchor.createdAt
    });
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }
}

/**
 * Remote HTTP sink (L-18): POSTs each anchor as one JSON document (same
 * fixed key order as the file sink) to an independent log/timestamping
 * endpoint. Fails loudly on non-2xx or network error — a missing off-box
 * copy is exactly what the operator must notice.
 */
export class HttpAnchorSink implements AuditAnchorSink {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 5_000
  ) {}

  async append(anchor: AuditAnchor): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: anchor.id,
          anchoredThroughEventId: anchor.anchoredThroughEventId,
          tipHash: anchor.tipHash,
          eventCount: anchor.eventCount,
          prevAnchorHash: anchor.prevAnchorHash,
          anchorHash: anchor.anchorHash,
          createdAt: anchor.createdAt
        }),
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(
        `audit anchor sink ${this.url} unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`audit anchor sink ${this.url} answered HTTP ${response.status}`);
    }
  }
}

/** Sink for unsupported/malformed AUDIT_ANCHOR_SINK values: fails on first use. */
export class FailingAnchorSink implements AuditAnchorSink {
  constructor(private readonly reason: string) {}

  append(): void {
    throw new AnchorSinkConfigError(this.reason);
  }
}

export function createAnchorSink(env: NodeJS.ProcessEnv): AuditAnchorSink | null {
  const spec = env.AUDIT_ANCHOR_SINK?.trim();
  if (!spec) {
    return null;
  }
  if (spec.startsWith('file:')) {
    const path = spec.slice('file:'.length).trim();
    if (!path) {
      return new FailingAnchorSink('AUDIT_ANCHOR_SINK=file: requires a non-empty path');
    }
    return new FileAnchorSink(path);
  }
  if (spec.startsWith('https://') || spec.startsWith('http://')) {
    return new HttpAnchorSink(spec);
  }
  const scheme = spec.split(':', 1)[0];
  return new FailingAnchorSink(
    `unsupported AUDIT_ANCHOR_SINK scheme '${scheme}' — supported schemes: file:<path>, http(s)://<endpoint>`
  );
}
