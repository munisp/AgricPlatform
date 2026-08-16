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
 * append path and boot are never affected). Supported scheme:
 *   file:<path>  — append each anchor as one JSON line to <path>.
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
  /** Synchronously persists one anchor. Throws on failure (fail loudly). */
  append(anchor: AuditAnchor): void;
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
  const scheme = spec.split(':', 1)[0];
  return new FailingAnchorSink(
    `unsupported AUDIT_ANCHOR_SINK scheme '${scheme}' — supported schemes: file:<path>`
  );
}
