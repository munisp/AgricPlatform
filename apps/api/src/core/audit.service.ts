import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditEvent } from '@agric-platform/shared';
import { newId } from '../common/async-repository.js';
import { AUDIT_REPOSITORY } from '../database/persistence.tokens.js';
import type { AuditCriteria, AuditRepository } from '../database/repositories/audit.repository.js';
import type { AuditAnchorVerification } from './audit-anchor.service.js';
import { GENESIS_HASH, hashAuditEvent } from './audit-chain.js';

export { canonicalJSON, GENESIS_HASH, hashAuditEvent, linkAuditEvent } from './audit-chain.js';

export interface RecordAuditInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  /** Correlates the record with the HTTP request that caused it. */
  requestId?: string;
}

export interface AuditVerification {
  valid: boolean;
  /** Id of the first event whose hash/link check failed. */
  brokenAt?: string;
  /** Number of events verified in this walk (Wave P). */
  checked?: number;
  /**
   * Anchoring checkpoint verification (Stage 23): anchor-chain integrity plus
   * the truncation-gap check against the live tail. Present when an
   * AuditAnchorService is wired (always in the deployed app); `valid` above
   * is then the AND of the event-chain and anchor checks.
   */
  anchors?: AuditAnchorVerification;
}

/**
 * Audit log for admin and sensitive operations (NDPR/NDPA requirement).
 * Persists through the injected AuditRepository (in-memory by default,
 * admin.audit_events in PostgreSQL).
 *
 * Tamper evidence (observability plan §A.6): every record carries
 * `prevHash`/`hash` forming a hash chain (genesis = 64 zeros); `verify()`
 * re-walks the chain and reports the first broken link.
 *
 * Fork safety (audit C2-11): chain extension is atomic inside the
 * repository's `append()` — the tail is read and linked in the same
 * serialized step (UNIQUE(prev_hash) + guarded INSERT on PostgreSQL, a
 * synchronous link-and-push in memory). This service intentionally keeps NO
 * per-process tail cache: under the multi-replica HPA every replica used to
 * hold an independent lastHash and fork the chain. Restarts and concurrent
 * writers now all extend the same persisted chain.
 *
 * Anchoring checkpoints (Stage 23, migration 047): AuditAnchorService
 * periodically/on-demand notarizes the chain tip (event id + tip hash +
 * count) into the audit.anchors chain, so a deleted/re-extended tail is
 * detected by the combined verification (see AdminService.verifyAuditLog).
 * Anchors in the same database only BOUND the truncation window — a
 * DB-write attacker can delete anchors too; AUDIT_ANCHOR_SINK ships anchors
 * off-box, and a fully external anchor is an ops follow-up.
 */
/** L-17: chain verification walks the log in bounded pages of this size. */
export const AUDIT_VERIFY_BATCH_SIZE = 500;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private verifyTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audits: AuditRepository
  ) {}

  async record(input: RecordAuditInput): Promise<AuditEvent> {
    const unsigned: Omit<AuditEvent, 'prevHash' | 'hash'> = {
      id: newId('audit'),
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
      ...(input.requestId ? { requestId: input.requestId } : {})
    };
    // Atomic chain extension (prevHash + hash) happens inside the repository.
    return this.audits.append(unsigned);
  }

  async list(filter?: AuditCriteria): Promise<AuditEvent[]> {
    return this.audits.list(filter);
  }

  /**
   * Re-walks the persisted chain. An event is broken when it lacks hash
   * fields, its prevHash does not match the running tail, or its payload no
   * longer hashes to the stored value (i.e. it was tampered with). A forked
   * history (two events claiming the same prevHash) is detected the same
   * way: the second branch's prevHash cannot match the running tail.
   *
   * Wave P: optional [fromId, toId] range bounds the walk to a contiguous
   * slice. Inside a range the first event's prevHash is trusted (it links
   * to history outside the slice); every later link and every payload hash
   * is still verified, and the first broken link is reported.
   */
  async verify(range?: { fromId?: string; toId?: string }): Promise<AuditVerification> {
    // L-17: chunked walk (bounded pages) instead of materializing the whole
    // append-only log — a full-table list() here was itself the audit-log
    // DoS vector once the table grows.
    const started = !range?.fromId;
    let expected: string | null = started ? GENESIS_HASH : null;
    let begun = started;
    let checked = 0;
    let offset = 0;
    for (;;) {
      const batch = await this.audits.listPage(offset, AUDIT_VERIFY_BATCH_SIZE);
      if (batch.length === 0) {
        break;
      }
      for (const event of batch) {
        if (!begun) {
          if (range?.toId && event.id === range.toId) {
            // toId precedes fromId: empty range (matches the legacy
            // slice-based semantics — nothing to check).
            return { valid: true, checked: 0 };
          }
          if (event.id !== range?.fromId) {
            continue;
          }
          begun = true;
          // Ranged walks trust the slice head's link to prior history.
          expected = event.prevHash ?? GENESIS_HASH;
        }
        if (!event.hash || !event.prevHash) {
          return { valid: false, brokenAt: event.id, checked };
        }
        if (event.prevHash !== expected) {
          return { valid: false, brokenAt: event.id, checked };
        }
        const { hash, ...unsigned } = event;
        if (hashAuditEvent(unsigned, event.prevHash) !== event.hash) {
          return { valid: false, brokenAt: event.id, checked };
        }
        expected = event.hash;
        checked += 1;
        if (range?.toId && event.id === range.toId) {
          return { valid: true, checked };
        }
      }
      offset += batch.length;
      if (batch.length < AUDIT_VERIFY_BATCH_SIZE) {
        break;
      }
    }
    if (!begun && range?.fromId) {
      return { valid: false, brokenAt: range.fromId, checked: 0 };
    }
    if (range?.toId) {
      return { valid: false, brokenAt: range.toId, checked: 0 };
    }
    return { valid: true, checked };
  }

  /**
   * L-17 scheduled verify hook: when AUDIT_CHAIN_VERIFY_INTERVAL_MS is set
   * (>0), re-walk the chain on that cadence and log loudly on tamper
   * evidence. Disabled by default (the admin endpoint remains the on-demand
   * path); a broken chain logs at error level for alerting.
   */
  onModuleInit(): void {
    const intervalMs = Number(process.env.AUDIT_CHAIN_VERIFY_INTERVAL_MS ?? 0);
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      this.verifyTimer = setInterval(() => {
        void this.verify()
          .then((result) => {
            if (!result.valid) {
              this.logger.error(
                `audit chain verification FAILED at event ${result.brokenAt ?? 'unknown'} after ${result.checked} events — investigate tampering immediately`
              );
            } else {
              this.logger.log(`audit chain verified (${result.checked} events)`);
            }
          })
          .catch((error: unknown) => {
            this.logger.error(
              `audit chain verification errored: ${error instanceof Error ? error.message : String(error)}`
            );
          });
      }, intervalMs);
      this.verifyTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.verifyTimer) {
      clearInterval(this.verifyTimer);
    }
  }
}
