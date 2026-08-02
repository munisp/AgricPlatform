import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  LivestockLien,
  LivestockSubjectType,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  LIEN_REPOSITORY,
  LOT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  LotRepository
} from '../../database/repositories/livestock.repository.js';
import type { LienRepository } from '../../database/repositories/livestock-trade.repository.js';
import { assertKobo, assertRole, requireActor, resolveSubject } from './trade.utils.js';

export interface RegisterLienInput {
  subjectType: LivestockSubjectType;
  subjectId: string;
  principalKobo: number;
  terms: string;
}

/**
 * Lender liens over livestock collateral (F5).
 *
 * ⚖ LEGAL ACTIVATION REQUIRED: registering, discharging and (especially)
 * enforcing liens over livestock has secured-transaction and
 * collateral-registry implications under Nigerian law (e.g. SECURED
 * TRANSACTIONS IN MOVABLE ASSETS ACT, 2017 / state collateral registries).
 * This service — and the transfer-blocking guard fed from it — must not be
 * activated in production without qualified Nigerian legal/regulatory
 * review. See docs note in the module README-equivalent comment block of
 * the livestock-trade module.
 */
@Injectable()
export class LiensService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(LIEN_REPOSITORY) private readonly liens: LienRepository
  ) {}

  /** Registers an active lien. Lender-role callers only (or admin); the
   * subject owner becomes the borrower of record. At most one active lien
   * per subject (409 otherwise). */
  async register(actor: User | null, input: RegisterLienInput): Promise<LivestockLien> {
    const caller = assertRole(actor, ['lender']);
    assertKobo(input.principalKobo, 'principalKobo');
    if (!input.terms.trim()) {
      throw new BadRequestException('Lien terms are required');
    }
    const subject = await resolveSubject(this.animals, this.lots, input.subjectType, input.subjectId);
    const now = new Date().toISOString();
    const lien: LivestockLien = {
      id: newId('lien'),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      lenderUserId: caller.id,
      borrowerUserId: subject.ownerUserId,
      principalKobo: input.principalKobo,
      terms: input.terms,
      status: 'active',
      registeredAt: now,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.liens.create(lien);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.lien_registered',
      entityType: 'lien',
      entityId: created.id,
      metadata: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        borrowerUserId: subject.ownerUserId,
        principalKobo: input.principalKobo
      }
    });
    await this.events.publish(
      'livestock_trade.lien.registered',
      { lienId: created.id, subjectType: input.subjectType, subjectId: input.subjectId },
      caller.id
    );
    return created;
  }

  /** active → discharged (lender of record or admin). */
  async discharge(actor: User | null, id: string): Promise<LivestockLien> {
    const caller = requireActor(actor);
    const lien = await this.liens.getById(id);
    this.assertLienParty(caller, lien);
    if (lien.status !== 'active') {
      throw new BadRequestException(`Lien '${id}' is ${lien.status}; only active liens can be discharged`);
    }
    const now = new Date().toISOString();
    const updated = await this.liens.update(id, {
      status: 'discharged',
      dischargedAt: now,
      updatedAt: now
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.lien_discharged',
      entityType: 'lien',
      entityId: id,
      metadata: { subjectId: lien.subjectId }
    });
    await this.events.publish(
      'livestock_trade.lien.discharged',
      { lienId: id, subjectType: lien.subjectType, subjectId: lien.subjectId },
      caller.id
    );
    return updated;
  }

  /** active → defaulted (lender of record or admin). */
  async markDefaulted(actor: User | null, id: string): Promise<LivestockLien> {
    const caller = requireActor(actor);
    const lien = await this.liens.getById(id);
    this.assertLienParty(caller, lien);
    if (lien.status !== 'active') {
      throw new BadRequestException(`Lien '${id}' is ${lien.status}; only active liens can default`);
    }
    const updated = await this.liens.update(id, {
      status: 'defaulted',
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.lien_defaulted',
      entityType: 'lien',
      entityId: id,
      metadata: { subjectId: lien.subjectId }
    });
    await this.events.publish(
      'livestock_trade.lien.defaulted',
      { lienId: id, subjectType: lien.subjectType, subjectId: lien.subjectId },
      caller.id
    );
    return updated;
  }

  /** Liens the caller registered (lender view). */
  async listMine(actor: User | null): Promise<LivestockLien[]> {
    const caller = assertRole(actor, ['lender']);
    return this.liens.find({ lenderUserId: caller.id });
  }

  /** Lien history for a subject: visible to the subject owner, admins and
   * lender-role users (credit due diligence). */
  async listForSubject(
    actor: User | null,
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<LivestockLien[]> {
    const caller = requireActor(actor);
    const subject = await resolveSubject(this.animals, this.lots, subjectType, subjectId);
    const privileged =
      caller.id === subject.ownerUserId ||
      caller.roles.includes('admin') ||
      caller.roles.includes('lender');
    if (!privileged) {
      throw new ForbiddenException('You may only view liens on your own livestock');
    }
    return this.liens.find({ subjectType, subjectId });
  }

  private assertLienParty(caller: User, lien: LivestockLien): void {
    if (caller.id !== lien.lenderUserId && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the registering lender (or admin) can update this lien');
    }
  }
}
