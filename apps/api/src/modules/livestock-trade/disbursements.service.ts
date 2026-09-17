import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  DisbursementMilestone,
  DonorDisbursement,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { DISBURSEMENT_REPOSITORY } from '../../database/persistence.tokens.js';
import type { DisbursementRepository } from '../../database/repositories/livestock-trade.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { assertKobo, assertRole, requireActor } from './trade.utils.js';

/**
 * V-56 disbursement ledger leg (escrow-ledger.ts pattern). Until this wave a
 * release moved donor money with NO double-entry journal — invisible to the
 * trial balance. Pooled accounts (no per-beneficiary proliferation):
 *
 *   schedule: commitment only, no journal (no funds have moved);
 *   release:  DR livestock:disbursement:programme_spend (expense — donor
 *             programme funds consumed)
 *             CR livestock:disbursement:donor_float    (asset — funds paid
 *             out of the platform-held donor float)
 *   confirm:  beneficiary acknowledgement, no journal.
 *
 * The leg is idempotency-keyed per disbursement, so the release CAS replay
 * path and any consumer re-drive can never double-post.
 */
export const DISBURSEMENT_DONOR_FLOAT_ACCOUNT = 'livestock:disbursement:donor_float';
export const DISBURSEMENT_PROGRAMME_SPEND_ACCOUNT = 'livestock:disbursement:programme_spend';
export const DISBURSEMENT_RELEASE_REFERENCE_TYPE = 'livestock_disbursement_release';

export function disbursementReleaseLedgerKey(disbursementId: string): string {
  return `livestock-disbursement:released:${disbursementId}`;
}

export interface ScheduleDisbursementInput {
  programmeId: string;
  milestone: DisbursementMilestone;
  amountKobo: number;
  beneficiaryUserId: string;
}

/**
 * Donor disbursements (F5): programme-linked milestone payments.
 * Lifecycle scheduled → released → confirmed. The
 * (programmeId, milestone, beneficiaryUserId) triple is unique, so a
 * milestone can never be scheduled — and therefore paid — twice; release
 * is idempotent (re-releasing an already released disbursement replays the
 * current state without side effects).
 */
@Injectable()
export class DisbursementsService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(DISBURSEMENT_REPOSITORY)
    private readonly disbursements: DisbursementRepository,
    private readonly ledger: LedgerService
  ) {}

  async schedule(actor: User | null, input: ScheduleDisbursementInput): Promise<DonorDisbursement> {
    const caller = assertRole(actor, ['donor']);
    assertKobo(input.amountKobo, 'amountKobo');
    if (!input.programmeId.trim()) {
      throw new BadRequestException('programmeId is required');
    }
    await this.users.getById(input.beneficiaryUserId);
    const now = new Date().toISOString();
    const disbursement: DonorDisbursement = {
      id: newId('disbursement'),
      donorUserId: caller.id,
      programmeId: input.programmeId,
      milestone: input.milestone,
      amountKobo: input.amountKobo,
      beneficiaryUserId: input.beneficiaryUserId,
      status: 'scheduled',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.disbursements.create(disbursement);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.disbursement_scheduled',
      entityType: 'disbursement',
      entityId: created.id,
      metadata: {
        programmeId: input.programmeId,
        milestone: input.milestone,
        beneficiaryUserId: input.beneficiaryUserId,
        amountKobo: input.amountKobo
      }
    });
    return created;
  }

  /**
   * Posts the release ledger leg (V-56). Idempotent per disbursement: the
   * CAS replay path re-drives it so a crash between the status claim and the
   * original posting still converges the books (escrow terminal-replay
   * pattern), and a double-drive can never post twice.
   */
  private async postReleaseLedgerLeg(
    disbursement: DonorDisbursement,
    actorId: string
  ): Promise<void> {
    await this.ledger.ensureAccount({
      code: DISBURSEMENT_DONOR_FLOAT_ACCOUNT,
      type: 'asset'
    });
    await this.ledger.ensureAccount({
      code: DISBURSEMENT_PROGRAMME_SPEND_ACCOUNT,
      type: 'expense'
    });
    await this.ledger.postEntry(
      {
        idempotencyKey: disbursementReleaseLedgerKey(disbursement.id),
        referenceType: DISBURSEMENT_RELEASE_REFERENCE_TYPE,
        referenceId: disbursement.id,
        description:
          `Livestock donor disbursement ${disbursement.id} released ` +
          `(${disbursement.amountKobo} kobo, milestone '${disbursement.milestone}', ` +
          `programme '${disbursement.programmeId}')`,
        postings: [
          {
            accountCode: DISBURSEMENT_PROGRAMME_SPEND_ACCOUNT,
            direction: 'debit',
            amountKobo: disbursement.amountKobo
          },
          {
            accountCode: DISBURSEMENT_DONOR_FLOAT_ACCOUNT,
            direction: 'credit',
            amountKobo: disbursement.amountKobo
          }
        ]
      },
      actorId
    );
  }

  /** scheduled → released. Idempotent: an already released disbursement is
   * returned unchanged (no double payment, no duplicate event). The status
   * claim is a guarded CAS (V-56): two concurrent releases serialise on
   * {status:'scheduled'} and exactly one publishes the event / pays out. */
  async release(actor: User | null, id: string): Promise<DonorDisbursement> {
    const caller = requireActor(actor);
    const disbursement = await this.disbursements.getById(id);
    if (disbursement.donorUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the scheduling donor (or admin) can release funds');
    }
    if (disbursement.status === 'released') {
      // Idempotent replay; re-drive the ledger leg in case a prior attempt
      // crashed between the CAS claim and the posting.
      await this.postReleaseLedgerLeg(disbursement, caller.id);
      return disbursement;
    }
    if (disbursement.status !== 'scheduled') {
      throw new BadRequestException(
        `Disbursement '${id}' is ${disbursement.status}; only scheduled disbursements can be released`
      );
    }
    const now = new Date().toISOString();
    let updated: DonorDisbursement;
    try {
      updated = await this.disbursements.updateExpected(
        id,
        {
          status: 'released',
          releasedAt: now,
          updatedAt: now
        },
        { status: 'scheduled' }
      );
    } catch (error) {
      // Adopt-on-conflict: a concurrent release claimed the row first —
      // converge on the winner's state instead of double-paying.
      if (error instanceof ConflictException) {
        const winner = await this.disbursements.getById(id);
        if (winner.status === 'released') {
          await this.postReleaseLedgerLeg(winner, caller.id);
          return winner;
        }
      }
      throw error;
    }
    await this.postReleaseLedgerLeg(updated, caller.id);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.disbursement_released',
      entityType: 'disbursement',
      entityId: id,
      metadata: {
        programmeId: disbursement.programmeId,
        milestone: disbursement.milestone,
        beneficiaryUserId: disbursement.beneficiaryUserId,
        amountKobo: disbursement.amountKobo
      }
    });
    await this.events.publish(
      'livestock_trade.disbursement.released',
      {
        disbursementId: id,
        programmeId: disbursement.programmeId,
        milestone: disbursement.milestone,
        beneficiaryUserId: disbursement.beneficiaryUserId,
        amountKobo: disbursement.amountKobo
      },
      caller.id
    );
    return updated;
  }

  /** released → confirmed (beneficiary confirms receipt, or admin). */
  async confirm(actor: User | null, id: string): Promise<DonorDisbursement> {
    const caller = requireActor(actor);
    const disbursement = await this.disbursements.getById(id);
    assertSelfOrAdmin(caller, disbursement.beneficiaryUserId);
    if (disbursement.status !== 'released') {
      throw new BadRequestException(
        `Disbursement '${id}' is ${disbursement.status}; only released disbursements can be confirmed`
      );
    }
    const now = new Date().toISOString();
    const updated = await this.disbursements.update(id, {
      status: 'confirmed',
      confirmedAt: now,
      updatedAt: now
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.disbursement_confirmed',
      entityType: 'disbursement',
      entityId: id,
      metadata: { beneficiaryUserId: disbursement.beneficiaryUserId }
    });
    return updated;
  }

  /** Disbursements the caller scheduled (donor view; admin sees all via criteria). */
  async listMine(actor: User | null): Promise<DonorDisbursement[]> {
    const caller = assertRole(actor, ['donor']);
    return this.disbursements.find({ donorUserId: caller.id });
  }

  async listForBeneficiary(actor: User | null, beneficiaryUserId: string): Promise<DonorDisbursement[]> {
    assertSelfOrAdmin(actor, beneficiaryUserId);
    return this.disbursements.find({ beneficiaryUserId });
  }
}
