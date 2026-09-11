import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import type { EscrowRecord, LedgerJournalEntry, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import {
  COOP_POOL_REPOSITORY,
  ESCROW_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CoopPoolRepository
} from '../../database/repositories/coop-pool.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  buildSplitPostings,
  computeSharesBps,
  COOP_POOL_FLAG,
  memberPoolAccountCode,
  poolClearingAccountCode,
  poolSplitIdempotencyKey,
  splitPoolProceeds,
  type PoolContribution,
  type PoolListing,
  type PoolSplitMarker
} from './coop-pool.js';
import { assertKoboRepresentable, MarketplaceService } from './marketplace.service.js';
import { ESCROW_PAYOUT_DRIVER, type EscrowPayoutDriverPort } from './payout.driver.js';

export interface CreatePoolInput {
  cooperativeId: string;
  title: string;
  crop?: string;
  /** Naira per unit (kg); must be representable in whole kobo. */
  unitPriceNaira: number;
  location: { state: string; lga: string; ward?: string };
  minPoolQtyKg: number;
}

export interface PledgeInput {
  memberUserId: string;
  qtyKg: number;
  qualityGrade: string;
}

/** Member-visible share statement (GET /marketplace/pools/:id). */
export interface PoolStatement {
  pool: PoolListing;
  contributions: PoolContribution[];
  split?: PoolSplitMarker;
}

/**
 * Coop Pool & Split (Stage 27 Batch 1, Innovation 2): a cooperative pools
 * member harvest into one graded bulk listing; when the buyer's escrow is
 * RELEASED the proceeds split to member ledger sub-accounts by locked-in
 * basis-point shares.
 *
 * Money doctrine (mirrors the escrow state machine + payout rail):
 *   - settlement only ever runs for a provider-released escrow
 *     (verify-before-credit; the escrow release itself is the guarded
 *     claim-CAS through EscrowService), and the pay-provider settlement leg
 *     stays behind the existing payout rail: a wired STUB driver — or no
 *     driver in production — fails closed with 503 PAYOUT_UNAVAILABLE and
 *     the pool stays 'locked' with NO member credited;
 *   - the split is claimed by an exactly-once marker row
 *     (marketplace.pool_split_markers, targetless ON CONFLICT DO NOTHING);
 *     on PostgreSQL the marker, the pool status CAS, the balanced ledger
 *     journal with ALL member credit postings, the contribution payouts and
 *     the marketplace.pool.settled outbox event commit in ONE transaction
 *     (PgCoopPoolRepository.settleSplit) with in-transaction invariant
 *     checks (finance.transfer_is_balanced + Σ credits === escrow amount);
 *   - the journal is balanced by construction: DR the pool escrow-clearing
 *     account, CR each member sub-account; Σ credits === escrow release
 *     amount (integer kobo, largest-remainder rounding).
 */
@Injectable()
export class CoopPoolService implements OnModuleInit {
  private readonly logger = new Logger(CoopPoolService.name);
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly events: DomainEventsService,
    private readonly flags: FeatureFlagsService,
    private readonly ledger: LedgerService,
    private readonly marketplace: MarketplaceService,
    @Inject(COOP_POOL_REPOSITORY) private readonly pools: CoopPoolRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Optional() @Inject(ESCROW_PAYOUT_DRIVER) private readonly payoutDriver?: EscrowPayoutDriverPort,
    @Optional() private readonly audit?: AuditService,
    @Optional() telemetry?: TelemetryService
  ) {
    // No-op-safe fallback for direct construction (unit tests), same as
    // DomainEventsService.
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /**
   * Outbox consumer: an escrow reaching RELEASED settles the locked pool
   * behind its listing. Fail-closed: any failure leaves the pool 'locked'
   * (nothing partial commits) and is logged + audited for ops retry via
   * POST /marketplace/pools/:id/settle; the listener never rethrows into
   * the event fan-out.
   */
  onModuleInit(): void {
    this.events.on('marketplace.escrow.status_changed', (event: DomainEvent) => {
      void this.onEscrowStatusChanged(event).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`pool settle on escrow release failed: ${message}`);
        this.telemetry.increment('marketplace.pool_settle.failures', 1, {
          reason: error instanceof Error ? error.name : 'unknown'
        });
        await this.audit
          ?.record({
            actorId: 'system',
            action: 'marketplace.pool.settle_failed',
            entityType: 'pool_listing',
            entityId: 'unknown',
            metadata: { eventId: event.id, error: message }
          })
          .catch(() => undefined);
      });
    });
  }

  private async onEscrowStatusChanged(event: DomainEvent): Promise<void> {
    const payload = event.payload as { escrowId?: string; orderId?: string; to?: string };
    if (payload?.to !== 'released' || !payload.orderId || !payload.escrowId) {
      return;
    }
    // Fail-closed flag gate for the consumer path (the HTTP guard covers
    // the endpoints; the listener must not settle while the flag is off).
    if (!(await this.flags.isEnabled(COOP_POOL_FLAG))) {
      return;
    }
    const order = await this.orders.findById(payload.orderId);
    if (!order) {
      return;
    }
    const pool = await this.pools.findOne({ listingId: order.listingId, status: 'locked' });
    if (!pool) {
      return; // not a pool-backed listing — nothing to split
    }
    await this.settle(pool.id, 'system', payload.escrowId);
  }

  /** Cooperative admin opens a pool (status 'open', accepting pledges). */
  async createPool(actor: User | null, input: CreatePoolInput): Promise<PoolListing> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    assertKoboRepresentable(input.unitPriceNaira);
    if (!Number.isSafeInteger(input.minPoolQtyKg) || input.minPoolQtyKg <= 0) {
      throw new BadRequestException('minPoolQtyKg must be a positive integer');
    }
    const now = new Date().toISOString();
    const pool: PoolListing = {
      id: newId('pool'),
      cooperativeId: input.cooperativeId,
      title: input.title,
      crop: input.crop,
      unitPriceKobo: input.unitPriceNaira * 100,
      location: input.location,
      minPoolQtyKg: input.minPoolQtyKg,
      totalQtyKg: 0,
      status: 'open',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.pools.create(pool);
    // Clearing account up-front so settlement never invents accounts.
    await this.ledger.ensureAccount({
      code: poolClearingAccountCode(created.id),
      type: 'asset',
      ownerId: input.cooperativeId
    });
    await this.events.publish(
      'marketplace.pool.created',
      { poolId: created.id, cooperativeId: created.cooperativeId },
      actor.id
    );
    this.telemetry.increment('marketplace.pools_total', 1);
    return created;
  }

  /** Cooperative admin pledges a member's harvest into an open pool. */
  async pledge(actor: User | null, poolId: string, input: PledgeInput): Promise<PoolContribution> {
    const pool = await this.pools.getById(poolId);
    this.assertPoolOperator(actor, pool);
    if (pool.status !== 'open' && pool.status !== 'draft') {
      throw new ConflictException(`Pool '${poolId}' is '${pool.status}'; pledges close at lock`);
    }
    if (!Number.isSafeInteger(input.qtyKg) || input.qtyKg <= 0) {
      throw new BadRequestException('qtyKg must be a positive integer');
    }
    if (!input.qualityGrade?.trim()) {
      throw new BadRequestException('qualityGrade is required');
    }
    // Member sub-account up-front (same doctrine as agent-banking wallets):
    // every later posting finds its account.
    const ledgerAccountCode = memberPoolAccountCode(input.memberUserId);
    await this.ledger.ensureAccount({
      code: ledgerAccountCode,
      type: 'asset',
      ownerId: input.memberUserId
    });
    const now = new Date().toISOString();
    const contribution: PoolContribution = {
      id: newId('poolctb'),
      poolId,
      memberUserId: input.memberUserId,
      qtyKg: input.qtyKg,
      qualityGrade: input.qualityGrade.trim(),
      ledgerAccountCode,
      status: 'pledged',
      createdAt: now,
      updatedAt: now
    };
    // The (pool_id, member_user_id) UNIQUE index makes pledge retries safe:
    // a same-member replay surfaces 409 from the repository.
    const created = await this.pools.addContribution(contribution);
    await this.events.publish(
      'marketplace.pool.contribution_pledged',
      { poolId, contributionId: created.id, memberUserId: created.memberUserId, qtyKg: created.qtyKg },
      actor.id
    );
    return created;
  }

  /**
   * Lock: computes each member's share_bps (largest-remainder, Σ = 10000),
   * marks pledged contributions delivered, and opens the escrow-backed bulk
   * listing (one counterparty for the buyer). Guarded CAS so concurrent
   * locks cannot double-list.
   */
  async lock(actor: User | null, poolId: string): Promise<PoolListing> {
    const pool = await this.pools.getById(poolId);
    this.assertPoolOperator(actor, pool);
    if (pool.status === 'locked') {
      return pool; // idempotent replay of a lock retry
    }
    if (pool.status !== 'open' && pool.status !== 'draft') {
      throw new ConflictException(`Pool '${poolId}' is '${pool.status}'; only open pools lock`);
    }
    const contributions = (await this.pools.listContributions({ poolId })).filter(
      (contribution) => contribution.status !== 'rejected'
    );
    if (contributions.length === 0) {
      throw new BadRequestException(`Pool '${poolId}' has no contributions to lock`);
    }
    const totalQtyKg = contributions.reduce((sum, contribution) => sum + contribution.qtyKg, 0);
    if (totalQtyKg < pool.minPoolQtyKg) {
      throw new BadRequestException(
        `Pool '${poolId}' is ${totalQtyKg} kg short of its ${pool.minPoolQtyKg} kg minimum; ` +
          'refusing to lock an under-subscribed pool'
      );
    }
    const shares = computeSharesBps(contributions);
    const listing = await this.marketplace.createListing({
      sellerId: pool.cooperativeId,
      kind: 'produce',
      title: pool.title,
      crop: pool.crop,
      quantity: totalQtyKg,
      unit: 'kg',
      priceNaira: pool.unitPriceKobo / 100,
      location: pool.location ?? { state: 'NG', lga: 'NG' }
    });
    const now = new Date().toISOString();
    for (const contribution of contributions) {
      await this.pools.updateContribution(contribution.id, {
        shareBps: shares.get(contribution.id),
        status: 'delivered'
      });
    }
    const locked = await this.pools.updateExpected(
      poolId,
      { status: 'locked', listingId: listing.id, totalQtyKg, lockedAt: now },
      { status: pool.status }
    );
    await this.events.publish(
      'marketplace.pool.locked',
      {
        poolId,
        listingId: listing.id,
        totalQtyKg,
        memberCount: contributions.length,
        shares: contributions.map((contribution) => ({
          contributionId: contribution.id,
          memberUserId: contribution.memberUserId,
          shareBps: shares.get(contribution.id)
        }))
      },
      actor.id
    );
    return locked;
  }

  /**
   * Settlement (internal — invoked on the escrow RELEASED outbox event, or
   * by an admin retrying). Splits the released escrow amount to member
   * ledger accounts by locked shares; exactly-once via the split marker and
   * the ledger idempotency key; balanced and atomic per the class header.
   * Idempotent replay: an already-settled pool returns its statement.
   */
  async settle(poolId: string, actorId: string, escrowIdHint?: string): Promise<PoolStatement> {
    const started = performance.now();
    const pool = await this.pools.getById(poolId);
    if (pool.status === 'settled') {
      return this.getStatement(poolId); // idempotent replay
    }
    if (pool.status !== 'locked') {
      throw new ConflictException(
        `Pool '${poolId}' is '${pool.status}'; only locked pools settle (escrow-backed listing first)`
      );
    }
    const existingMarker = await this.pools.splitMarkerFor(poolId);
    if (existingMarker) {
      // A committed marker proves the split journal committed (same
      // transaction on pg); never double-credit — replay the statement.
      return this.getStatement(poolId);
    }
    // Fail-closed rail gate BEFORE any credit: the pay-provider settlement
    // leg stays behind the existing payout rail.
    this.assertSplitRailAvailable(poolId);
    const escrow = await this.escrowForSettlement(pool, escrowIdHint);
    const contributions = (await this.pools.listContributions({ poolId })).filter(
      (contribution) => contribution.status === 'delivered'
    );
    if (contributions.length === 0) {
      throw new ConflictException(`Pool '${poolId}' has no delivered contributions to pay out`);
    }
    // Integer-kobo split; throws if any member would receive 0 kobo.
    const allocations = splitPoolProceeds(escrow.amountKobo, contributions);
    return this.telemetry.withSpan(
      'marketplace.pool.settle',
      { pool_id: poolId, member_count: allocations.length },
      async () => {
        const now = new Date().toISOString();
        const idempotencyKey = poolSplitIdempotencyKey(poolId);
        const postings = buildSplitPostings(poolId, escrow.amountKobo, allocations);
        const eventPayload = {
          poolId,
          escrowId: escrow.id,
          ledgerEntryId: '',
          totalKobo: escrow.amountKobo,
          memberCount: allocations.length,
          postings: allocations.map((allocation) => ({
            contributionId: allocation.contributionId,
            memberUserId: allocation.memberUserId,
            accountCode: allocation.ledgerAccountCode,
            shareBps: allocation.shareBps,
            amountKobo: allocation.amountKobo
          }))
        };
        if (this.pools.transactionalSplit && this.pools.settleSplit) {
          // PostgreSQL: marker + CAS + journal + payouts + outbox, ONE tx.
          const entry: LedgerJournalEntry = {
            id: randomUUID(),
            idempotencyKey,
            referenceType: 'marketplace_pool_split',
            referenceId: poolId,
            description: `Coop pool split of escrow ${escrow.id} across ${allocations.length} members`,
            postedAt: now,
            postings
          };
          eventPayload.ledgerEntryId = entry.id;
          const event = this.events.build('marketplace.pool.settled', eventPayload, actorId);
          const marker: PoolSplitMarker = {
            poolId,
            escrowId: escrow.id,
            ledgerEntryId: entry.id,
            totalKobo: escrow.amountKobo,
            memberCount: allocations.length,
            idempotencyKey,
            createdAt: now
          };
          const result = await this.pools.settleSplit({
            poolId,
            marker,
            entry,
            escrowId: escrow.id,
            payouts: allocations.map((allocation) => ({
              contributionId: allocation.contributionId,
              amountKobo: allocation.amountKobo
            })),
            event
          });
          if (result === 'replay') {
            return this.getStatement(poolId);
          }
          this.events.emit(event); // committed in the tx; fan out now
          await this.recordSettlementTelemetry(poolId, escrow, allocations.length, started, actorId, entry.id);
          return this.getStatement(poolId);
        }
        // In-memory / development path (synchronous — the sequence below is
        // effectively atomic): the ledger idempotency key is the first
        // exactly-once line, the marker claim the second.
        const posted = await this.ledger.postEntry(
          {
            idempotencyKey,
            referenceType: 'marketplace_pool_split',
            referenceId: poolId,
            description: `Coop pool split of escrow ${escrow.id} across ${allocations.length} members`,
            postings
          },
          actorId
        );
        eventPayload.ledgerEntryId = posted.id;
        const marker: PoolSplitMarker = {
          poolId,
          escrowId: escrow.id,
          ledgerEntryId: posted.id,
          totalKobo: escrow.amountKobo,
          memberCount: allocations.length,
          idempotencyKey,
          createdAt: now
        };
        const claimed = await this.pools.claimSplitMarker(marker);
        if (!claimed) {
          return this.getStatement(poolId); // a concurrent settle won
        }
        try {
          await this.pools.updateExpected(
            poolId,
            { status: 'settled', settledAt: now },
            { status: 'locked' }
          );
          for (const allocation of allocations) {
            await this.pools.updateContribution(allocation.contributionId, {
              status: 'paid',
              amountKobo: allocation.amountKobo
            });
          }
        } catch (error) {
          // Leave the marker committed (the journal IS committed — the
          // ledger posting succeeded); a retry replays through the marker
          // short-circuit above instead of double-crediting.
          await this.audit?.record({
            actorId,
            action: 'marketplace.pool.settle_finalize_failed',
            entityType: 'pool_listing',
            entityId: poolId,
            metadata: {
              ledgerEntryId: posted.id,
              error: error instanceof Error ? error.message : String(error)
            }
          });
          throw error;
        }
        await this.events.publish('marketplace.pool.settled', eventPayload, actorId);
        await this.recordSettlementTelemetry(poolId, escrow, allocations.length, started, actorId, posted.id);
        return this.getStatement(poolId);
      }
    );
  }

  /** Member-visible share statement. */
  async getStatement(poolId: string): Promise<PoolStatement> {
    const pool = await this.pools.getById(poolId);
    const contributions = await this.pools.listContributions({ poolId });
    const split = await this.pools.splitMarkerFor(poolId);
    return { pool, contributions, split };
  }

  /** Read-side authorization: pool operator, contributing member, or admin. */
  assertStatementAccess(actor: User | null, statement: PoolStatement): User {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    const isOperator =
      actor.roles.includes('admin') ||
      (actor.roles.includes('chapter_lead') && actor.id === statement.pool.cooperativeId);
    const isMember = statement.contributions.some(
      (contribution) => contribution.memberUserId === actor.id
    );
    if (!isOperator && !isMember) {
      throw new NotFoundException(`Pool '${statement.pool.id}' not found`); // 404, not 403: no existence leak
    }
    return actor;
  }

  /** The cooperative that owns the pool, or an admin. */
  private assertPoolOperator(actor: User | null, pool: PoolListing): asserts actor is User {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    if (actor.roles.includes('admin')) {
      return;
    }
    if (!actor.roles.includes('chapter_lead') || actor.id !== pool.cooperativeId) {
      throw new NotFoundException(`Pool '${pool.id}' not found`); // 404, not 403: no existence leak
    }
  }

  /**
   * Fail-closed settlement rail gate (spec: "with stub payment driver,
   * settle returns 503 PAYOUT_UNAVAILABLE, pool stays locked, no partial
   * member credits"). A wired stub driver never splits; without any driver
   * the ledger-only split is a non-production convenience only (mirrors the
   * escrow declarative path) and fails closed in production.
   */
  private assertSplitRailAvailable(poolId: string): void {
    const unavailable =
      this.payoutDriver?.name === 'stub' || (!this.payoutDriver && isProduction());
    if (unavailable) {
      void this.audit?.record({
        actorId: 'system',
        action: 'marketplace.pool.payout_unavailable',
        entityType: 'pool_listing',
        entityId: poolId,
        metadata: { driver: this.payoutDriver?.name ?? 'none', production: isProduction() }
      });
      throw new ServiceUnavailableException(
        `PAYOUT_UNAVAILABLE: pool settlement requires the live escrow payout rail ` +
          `(driver: ${this.payoutDriver?.name ?? 'none'}); pool '${poolId}' stays ` +
          `'locked' — no member was credited.`
      );
    }
  }

  /** Locates the single RELEASED escrow backing the pool's listing. */
  private async escrowForSettlement(pool: PoolListing, hint?: string): Promise<EscrowRecord> {
    if (!pool.listingId) {
      throw new ConflictException(`Pool '${pool.id}' has no listing; lock the pool first`);
    }
    const orders = await this.orders.find({ listingId: pool.listingId });
    const escrows: EscrowRecord[] = [];
    for (const order of orders) {
      const escrow = await this.escrows.findOne({ orderId: order.id });
      if (escrow) {
        escrows.push(escrow);
      }
    }
    const candidates = hint ? escrows.filter((escrow) => escrow.id === hint) : escrows;
    if (hint && candidates.length === 0) {
      throw new ConflictException(
        `Escrow '${hint}' does not back pool '${pool.id}' (listing ${pool.listingId})`
      );
    }
    const released = candidates.filter((escrow) => escrow.status === 'released');
    if (released.length === 0) {
      throw new ConflictException(
        `No RELEASED escrow backs pool '${pool.id}' yet; the split settles only after escrow release`
      );
    }
    if (released.length > 1) {
      throw new ConflictException(
        `Multiple released escrows back pool '${pool.id}'; refusing to guess — settle with an explicit escrow reference`
      );
    }
    return released[0];
  }

  private async recordSettlementTelemetry(
    poolId: string,
    escrow: EscrowRecord,
    memberCount: number,
    started: number,
    actorId: string,
    ledgerEntryId: string
  ): Promise<void> {
    this.telemetry.increment('marketplace.pool_settlement_kobo_total', escrow.amountKobo, {
      pool_id: poolId
    });
    this.telemetry.record('marketplace.pool_settle_latency_ms', performance.now() - started, {
      pool_id: poolId
    });
    await this.audit?.record({
      actorId,
      action: 'marketplace.pool.settled',
      entityType: 'pool_listing',
      entityId: poolId,
      metadata: { escrowId: escrow.id, totalKobo: escrow.amountKobo, memberCount, ledgerEntryId }
    });
  }
}
