import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit
} from '@nestjs/common';
import type { AuditAnchor } from '@agric-platform/shared';
import { AUDIT_ANCHOR_REPOSITORY, AUDIT_REPOSITORY } from '../database/persistence.tokens.js';
import type { AuditAnchorRepository } from '../database/repositories/audit-anchor.repository.js';
import type { AuditRepository } from '../database/repositories/audit.repository.js';
import { GENESIS_HASH, hashAuditAnchor } from './audit-chain.js';
import { createAnchorSink, type AuditAnchorSink } from './audit-anchor-sink.js';

/** Why an anchor's tip no longer matches the live chain (truncation gap). */
export type AnchorGapReason =
  /** The event the anchor notarized is gone from the chain. */
  | 'anchor_tip_missing'
  /** The notarized event exists but its stored hash no longer matches. */
  | 'anchor_tip_hash_mismatch'
  /** The chain holds fewer events than the anchor notarized. */
  | 'event_count_regression';

/** Structured detail of a detected truncation gap (Stage 23). */
export interface AnchorGap {
  reason: AnchorGapReason;
  anchorId: string;
  anchoredThroughEventId: string | null;
  anchoredTipHash: string;
  anchoredEventCount: number;
  actualEventCount: number;
  currentTipEventId?: string;
  currentTipHash?: string;
}

export interface AuditAnchorVerification {
  valid: boolean;
  /** Number of anchors whose link/hash recomputed cleanly. */
  checked: number;
  /** Id of the first anchor whose link or hash check failed. */
  brokenAnchorAt?: string;
  /** Truncation gap between the latest anchor and the live tail. */
  gap?: AnchorGap;
}

/**
 * Anchoring checkpoints for the tamper-evident audit chain (Stage 23) —
 * closes the residual documented by migration 043: deleting the last N
 * events used to leave a valid shorter chain. An anchor notarizes the chain
 * tip (event id + tip hash + event count); anchors form their own hash
 * chain, so verifyAnchors() detects (b) anchor-chain tampering and (c) a
 * truncation gap between the latest anchor and the live tail, in addition
 * to (a) the event-chain fork/break detection AuditService.verify() has.
 *
 * Isolation guarantees: anchoring NEVER runs on the audit append path and
 * never crashes boot — it is triggered only on demand
 * (POST /api/v1/admin/audit-log/anchors), by an external scheduler calling
 * that endpoint, or by the opt-in AUDIT_ANCHOR_INTERVAL_MS timer (default
 * off). No new REQUIRED env: with no configuration the service anchors on
 * demand only and writes no sink. Interval failures are logged, never
 * thrown.
 *
 * Honest bound: anchors in the same database bound the truncation window
 * but do not eliminate it (a DB-write attacker can delete anchors too).
 * AUDIT_ANCHOR_SINK=file:<path> ships every anchor off-box as JSONL; a
 * fully external anchor (independent log service / timestamping authority)
 * is an ops follow-up.
 */
@Injectable()
export class AuditAnchorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditAnchorService.name);
  private timer?: NodeJS.Timeout;
  private sinkResolved = false;
  private sink: AuditAnchorSink | null = null;

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audits: AuditRepository,
    @Inject(AUDIT_ANCHOR_REPOSITORY) private readonly anchors: AuditAnchorRepository,
    // @Optional: tests inject env/sink directly; Nest leaves the defaults
    // (process.env, lazily-created sink) in place at runtime.
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env,
    @Optional() private readonly sinkOverride?: AuditAnchorSink | null
  ) {}

  onModuleInit(): void {
    // Default off: no timer unless AUDIT_ANCHOR_INTERVAL_MS is a positive
    // number. A malformed value disables the scheduler with a warning —
    // anchoring config must never crash boot.
    const raw = this.env.AUDIT_ANCHOR_INTERVAL_MS;
    if (raw === undefined || raw.trim() === '') {
      return;
    }
    const intervalMs = Number(raw);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      this.logger.warn(
        `AUDIT_ANCHOR_INTERVAL_MS='${raw}' is not a positive number — anchor scheduler disabled`
      );
      return;
    }
    this.logger.log(`Audit anchoring scheduler enabled (every ${intervalMs}ms)`);
    this.timer = setInterval(() => {
      void this.createAnchor().catch((error) =>
        this.logger.warn(`Scheduled audit anchor failed: ${(error as Error).message}`)
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Notarizes the current chain tip. Reads the tip + count, links a new
   * anchor to the previous one (atomically inside the repository), then
   * appends it to the configured external sink. A sink failure throws AFTER
   * the anchor is persisted — the operator must know the off-box copy is
   * missing (fail loudly); the interval path logs it instead.
   */
  async createAnchor(): Promise<AuditAnchor> {
    const events = await this.audits.list();
    const tip = events[events.length - 1];
    const anchor = await this.anchors.append({
      // uuid (no prefix): audit.anchors.id is a uuid column (migration 047).
      id: randomUUID(),
      anchoredThroughEventId: tip?.id ?? null,
      tipHash: tip?.hash ?? GENESIS_HASH,
      eventCount: events.length,
      createdAt: new Date().toISOString()
    });
    const sink = this.resolveSink();
    if (sink) {
      sink.append(anchor);
    }
    return anchor;
  }

  async listAnchors(): Promise<AuditAnchor[]> {
    return this.anchors.list();
  }

  /**
   * Verifies the anchor chain and its coverage of the live event chain.
   *
   * (b) Anchor-chain break: every anchor's prevAnchorHash must match the
   *     running anchor tail (genesis for the first) and its payload must
   *     recompute to anchorHash — rewritten/deleted/reordered anchors fail
   *     here with brokenAnchorAt.
   * (c) Truncation gap: the latest anchor's notarized tip must still exist
   *     in the live chain with the same hash, and the chain must hold at
   *     least as many events as the anchor counted — a TRUNCATE/DELETE of
   *     the tail (even with a valid re-extension) is reported as a gap.
   */
  async verifyAnchors(): Promise<AuditAnchorVerification> {
    const anchors = await this.anchors.list();
    let expected = GENESIS_HASH;
    let checked = 0;
    for (const anchor of anchors) {
      if (anchor.prevAnchorHash !== expected) {
        return { valid: false, checked, brokenAnchorAt: anchor.id };
      }
      const { anchorHash, ...unsigned } = anchor;
      if (hashAuditAnchor(unsigned, anchor.prevAnchorHash) !== anchorHash) {
        return { valid: false, checked, brokenAnchorAt: anchor.id };
      }
      expected = anchor.anchorHash;
      checked += 1;
    }
    const latest = anchors[anchors.length - 1];
    if (!latest) {
      return { valid: true, checked };
    }
    const gap = await this.detectGap(latest);
    return gap ? { valid: false, checked, gap } : { valid: true, checked };
  }

  /** Compares the latest anchor's notarized tip with the live chain. */
  private async detectGap(latest: AuditAnchor): Promise<AnchorGap | undefined> {
    const events = await this.audits.list();
    const currentTip = events[events.length - 1];
    const base = {
      anchorId: latest.id,
      anchoredThroughEventId: latest.anchoredThroughEventId,
      anchoredTipHash: latest.tipHash,
      anchoredEventCount: latest.eventCount,
      actualEventCount: events.length,
      ...(currentTip
        ? { currentTipEventId: currentTip.id, currentTipHash: currentTip.hash }
        : {})
    };
    if (events.length < latest.eventCount) {
      return { reason: 'event_count_regression', ...base };
    }
    if (latest.anchoredThroughEventId === null) {
      // Genesis anchor over an empty chain: any events present were appended
      // after the anchor, which is normal — nothing to compare.
      return undefined;
    }
    const tipIndex = events.findIndex((event) => event.id === latest.anchoredThroughEventId);
    if (tipIndex < 0) {
      return { reason: 'anchor_tip_missing', ...base };
    }
    if (events[tipIndex].hash !== latest.tipHash) {
      return { reason: 'anchor_tip_hash_mismatch', ...base };
    }
    return undefined;
  }

  /** Lazily resolves the configured sink so a bad scheme fails on first anchor attempt, never at boot. */
  private resolveSink(): AuditAnchorSink | null {
    if (this.sinkOverride !== undefined) {
      return this.sinkOverride;
    }
    if (!this.sinkResolved) {
      this.sink = createAnchorSink(this.env);
      this.sinkResolved = true;
    }
    return this.sink;
  }
}
