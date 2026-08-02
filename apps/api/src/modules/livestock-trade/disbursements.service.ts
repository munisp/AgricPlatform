import {
  BadRequestException,
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
import { UsersService } from '../users/users.service.js';
import { assertKobo, assertRole, requireActor } from './trade.utils.js';

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
    private readonly disbursements: DisbursementRepository
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

  /** scheduled → released. Idempotent: an already released disbursement is
   * returned unchanged (no double payment, no duplicate event). */
  async release(actor: User | null, id: string): Promise<DonorDisbursement> {
    const caller = requireActor(actor);
    const disbursement = await this.disbursements.getById(id);
    if (disbursement.donorUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the scheduling donor (or admin) can release funds');
    }
    if (disbursement.status === 'released') {
      return disbursement;
    }
    if (disbursement.status !== 'scheduled') {
      throw new BadRequestException(
        `Disbursement '${id}' is ${disbursement.status}; only scheduled disbursements can be released`
      );
    }
    const now = new Date().toISOString();
    const updated = await this.disbursements.update(id, {
      status: 'released',
      releasedAt: now,
      updatedAt: now
    });
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
