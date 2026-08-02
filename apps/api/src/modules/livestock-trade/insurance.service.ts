import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit
} from '@nestjs/common';
import type {
  InsuranceClaim,
  InsurancePolicy,
  InsurancePolicyStatus,
  LivestockRecallInitiatedPayload,
  LivestockSubjectType,
  User
} from '@agric-platform/shared';
import { LIVESTOCK_RECALL_INITIATED_EVENT } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  INSURANCE_CLAIM_REPOSITORY,
  INSURANCE_POLICY_REPOSITORY,
  LIVESTOCK_INSURANCE_PROVIDER,
  LOT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  LotRepository
} from '../../database/repositories/livestock.repository.js';
import type {
  InsuranceClaimRepository,
  InsurancePolicyRepository
} from '../../database/repositories/livestock-trade.repository.js';
import type { LivestockInsuranceProvider } from './provider-stubs.js';
import { assertKobo, requireActor, resolveSubject } from './trade.utils.js';

export interface QuotePolicyInput {
  subjectType: LivestockSubjectType;
  subjectId: string;
  premiumKobo: number;
  coverageKobo: number;
  startsAt?: string;
  endsAt?: string;
}

export interface SubmitClaimInput {
  policyId: string;
  animalIds: string[];
  amountKobo?: number;
  notes?: string;
}

/** Policy lifecycle: quote → bound → lapsed|cancelled (quote can cancel). */
export const POLICY_TRANSITIONS: Record<InsurancePolicyStatus, readonly InsurancePolicyStatus[]> = {
  quote: ['bound', 'cancelled'],
  bound: ['lapsed', 'cancelled'],
  lapsed: [],
  cancelled: []
};

/**
 * Livestock insurance flows (F5): quote → bind → lapse/cancel, claim
 * submission (submitted → assessed → paid/rejected) and recall-triggered
 * auto-claim drafts.
 *
 * The bind step delegates to the injected LivestockInsuranceProvider; the
 * default provider is a fail-closed stub (no underwriter configured), so
 * binding throws ProviderNotConfiguredError until a real driver ships.
 *
 * The recall hook subscribes to `livestock.recall.initiated` (published by
 * the L1b health wave) and drafts one claim per affected bound policy,
 * idempotent per (policyId, recallId). Every lookup is guarded so the
 * subscriber is safe before L1b lands and resilient to unknown IDs.
 */
@Injectable()
export class InsuranceService implements OnModuleInit {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(INSURANCE_POLICY_REPOSITORY)
    private readonly policies: InsurancePolicyRepository,
    @Inject(INSURANCE_CLAIM_REPOSITORY)
    private readonly claims: InsuranceClaimRepository,
    @Inject(LIVESTOCK_INSURANCE_PROVIDER)
    private readonly provider: LivestockInsuranceProvider
  ) {}

  onModuleInit(): void {
    this.events.on(LIVESTOCK_RECALL_INITIATED_EVENT, (event) => {
      void this.handleRecallInitiated(event.payload as LivestockRecallInitiatedPayload).catch(
        (error: unknown) =>
          this.logger.warn(
            `recall auto-claim handling failed: ${error instanceof Error ? error.message : String(error)}`
          )
      );
    });
  }

  /** Creates a quote for a subject the caller owns (or admin on behalf). */
  async quote(actor: User | null, input: QuotePolicyInput): Promise<InsurancePolicy> {
    const caller = requireActor(actor);
    assertKobo(input.premiumKobo, 'premiumKobo');
    assertKobo(input.coverageKobo, 'coverageKobo');
    const subject = await resolveSubject(this.animals, this.lots, input.subjectType, input.subjectId);
    if (subject.ownerUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('You may only insure your own livestock');
    }
    const now = new Date().toISOString();
    const policy: InsurancePolicy = {
      id: newId('policy'),
      holderUserId: subject.ownerUserId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      species: subject.species,
      premiumKobo: input.premiumKobo,
      coverageKobo: input.coverageKobo,
      status: 'quote',
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.policies.create(policy);
    await this.events.publish(
      'livestock_trade.policy.quoted',
      { policyId: created.id, subjectId: input.subjectId, coverageKobo: input.coverageKobo },
      caller.id
    );
    return created;
  }

  /** quote → bound. Insurer-role (or admin) only; delegates to the
   * underwriter provider, which fails closed without configuration. */
  async bind(actor: User | null, policyId: string): Promise<InsurancePolicy> {
    const caller = requireActor(actor);
    if (!caller.roles.includes('insurer') && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only an insurer (or admin) can bind a policy');
    }
    const policy = await this.policies.getById(policyId);
    if (policy.status !== 'quote') {
      throw new BadRequestException(`Policy '${policyId}' is ${policy.status}; only quotes can be bound`);
    }
    // Fail-closed provider call: throws ProviderNotConfiguredError in the
    // default stub configuration, before any state change.
    await this.provider.bindPolicy(policy);
    const updated = await this.policies.update(policyId, {
      status: 'bound',
      insurerUserId: caller.roles.includes('insurer') ? caller.id : policy.insurerUserId,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.policy_bound',
      entityType: 'insurance_policy',
      entityId: policyId,
      metadata: { subjectId: policy.subjectId, coverageKobo: policy.coverageKobo }
    });
    await this.events.publish(
      'livestock_trade.policy.bound',
      { policyId, subjectId: policy.subjectId },
      caller.id
    );
    return updated;
  }

  /** bound → lapsed (insurer of record or admin). */
  async lapse(actor: User | null, policyId: string): Promise<InsurancePolicy> {
    return this.transitionPolicy(actor, policyId, 'lapsed');
  }

  /** quote|bound → cancelled (holder, insurer of record or admin). */
  async cancel(actor: User | null, policyId: string): Promise<InsurancePolicy> {
    const caller = requireActor(actor);
    const policy = await this.policies.getById(policyId);
    const allowed =
      caller.id === policy.holderUserId ||
      caller.id === policy.insurerUserId ||
      caller.roles.includes('admin');
    if (!allowed) {
      throw new ForbiddenException('Only the policy holder, insurer or admin can cancel');
    }
    return this.transitionPolicy(caller, policyId, 'cancelled');
  }

  private async transitionPolicy(
    actor: User | null,
    policyId: string,
    to: InsurancePolicyStatus
  ): Promise<InsurancePolicy> {
    const caller = requireActor(actor);
    const policy = await this.policies.getById(policyId);
    if (to === 'lapsed' && caller.id !== policy.insurerUserId && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the insurer of record (or admin) can lapse a policy');
    }
    const allowedTransitions = POLICY_TRANSITIONS[policy.status];
    if (!allowedTransitions.includes(to)) {
      throw new BadRequestException(
        `Invalid policy transition from '${policy.status}' to '${to}'`
      );
    }
    const updated = await this.policies.update(policyId, {
      status: to,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: `livestock_trade.policy_${to}`,
      entityType: 'insurance_policy',
      entityId: policyId,
      metadata: { from: policy.status, to }
    });
    return updated;
  }

  async listMine(actor: User | null): Promise<InsurancePolicy[]> {
    const caller = requireActor(actor);
    return this.policies.find({ holderUserId: caller.id });
  }

  async getPolicy(actor: User | null, id: string): Promise<InsurancePolicy> {
    const caller = requireActor(actor);
    const policy = await this.policies.getById(id);
    const allowed =
      caller.id === policy.holderUserId ||
      caller.id === policy.insurerUserId ||
      caller.roles.includes('admin') ||
      caller.roles.includes('insurer');
    if (!allowed) {
      throw new ForbiddenException('You may only view your own policies');
    }
    return policy;
  }

  /** Manual claim submission (holder only, policy must be bound). */
  async submitClaim(actor: User | null, input: SubmitClaimInput): Promise<InsuranceClaim> {
    const caller = requireActor(actor);
    const policy = await this.policies.getById(input.policyId);
    if (policy.holderUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the policy holder can submit a claim');
    }
    if (policy.status !== 'bound') {
      throw new BadRequestException(`Policy '${input.policyId}' is ${policy.status}; claims require a bound policy`);
    }
    if (input.animalIds.length === 0) {
      throw new BadRequestException('A claim must reference at least one animal');
    }
    if (input.amountKobo !== undefined) {
      assertKobo(input.amountKobo, 'amountKobo');
      if (input.amountKobo > policy.coverageKobo) {
        throw new BadRequestException('Claim amount exceeds the policy coverage');
      }
    }
    const now = new Date().toISOString();
    const claim: InsuranceClaim = {
      id: newId('claim'),
      policyId: input.policyId,
      claimantUserId: policy.holderUserId,
      trigger: 'manual',
      animalIds: [...input.animalIds],
      amountKobo: input.amountKobo,
      status: 'submitted',
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.claims.create(claim);
    await this.events.publish(
      'livestock_trade.claim.submitted',
      { claimId: created.id, policyId: input.policyId },
      caller.id
    );
    return created;
  }

  /** submitted → assessed (insurer of record or admin). */
  async assessClaim(
    actor: User | null,
    claimId: string,
    input: { amountKobo?: number; notes?: string }
  ): Promise<InsuranceClaim> {
    const caller = requireActor(actor);
    const claim = await this.claims.getById(claimId);
    const policy = await this.policies.getById(claim.policyId);
    this.assertClaimAssessor(caller, policy);
    if (claim.status !== 'submitted') {
      throw new BadRequestException(`Claim '${claimId}' is ${claim.status}; only submitted claims can be assessed`);
    }
    if (input.amountKobo !== undefined) {
      assertKobo(input.amountKobo, 'amountKobo', { allowZero: true });
      if (input.amountKobo > policy.coverageKobo) {
        throw new BadRequestException('Assessed amount exceeds the policy coverage');
      }
    }
    const updated = await this.claims.update(claimId, {
      status: 'assessed',
      amountKobo: input.amountKobo ?? claim.amountKobo,
      notes: input.notes ?? claim.notes,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.claim_assessed',
      entityType: 'insurance_claim',
      entityId: claimId,
      metadata: { policyId: claim.policyId }
    });
    return updated;
  }

  /** assessed → paid|rejected (insurer of record or admin). */
  async settleClaim(
    actor: User | null,
    claimId: string,
    outcome: 'paid' | 'rejected'
  ): Promise<InsuranceClaim> {
    const caller = requireActor(actor);
    const claim = await this.claims.getById(claimId);
    const policy = await this.policies.getById(claim.policyId);
    this.assertClaimAssessor(caller, policy);
    if (claim.status !== 'assessed') {
      throw new BadRequestException(`Claim '${claimId}' is ${claim.status}; only assessed claims can be settled`);
    }
    const updated = await this.claims.update(claimId, {
      status: outcome,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: `livestock_trade.claim_${outcome}`,
      entityType: 'insurance_claim',
      entityId: claimId,
      metadata: { policyId: claim.policyId, amountKobo: claim.amountKobo }
    });
    await this.events.publish(
      'livestock_trade.claim.settled',
      { claimId, policyId: claim.policyId, outcome },
      caller.id
    );
    return updated;
  }

  async listClaimsForPolicy(actor: User | null, policyId: string): Promise<InsuranceClaim[]> {
    const caller = requireActor(actor);
    const policy = await this.policies.getById(policyId);
    const allowed =
      caller.id === policy.holderUserId ||
      caller.id === policy.insurerUserId ||
      caller.roles.includes('admin') ||
      caller.roles.includes('insurer');
    if (!allowed) {
      throw new ForbiddenException('You may only view claims on your own policies');
    }
    return this.claims.find({ policyId });
  }

  /**
   * Recall hook (L1b integration point): drafts one 'recall' claim per
   * bound policy whose subject overlaps the recalled animals. Lot policies
   * match when any recalled animal is a lot member. Duplicate
   * (policyId, recallId) drafts are skipped silently (idempotent).
   */
  async handleRecallInitiated(payload: LivestockRecallInitiatedPayload): Promise<InsuranceClaim[]> {
    if (!payload || typeof payload.recallId !== 'string' || !Array.isArray(payload.animalIds)) {
      this.logger.warn('ignoring malformed livestock.recall.initiated payload');
      return [];
    }
    const recalled = new Set(payload.animalIds);
    const drafted: InsuranceClaim[] = [];
    const bound = await this.policies.find({ status: 'bound' });
    for (const policy of bound) {
      const overlap = await this.recallOverlap(policy, recalled);
      if (overlap.length === 0) {
        continue;
      }
      const now = new Date().toISOString();
      const claim: InsuranceClaim = {
        id: newId('claim'),
        policyId: policy.id,
        claimantUserId: policy.holderUserId,
        trigger: 'recall',
        recallId: payload.recallId,
        animalIds: overlap,
        status: 'draft',
        notes: `Auto-drafted from recall '${payload.recallId}'`,
        createdAt: now,
        updatedAt: now
      };
      try {
        drafted.push(await this.claims.create(claim));
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          throw error;
        }
        // Duplicate recall event: (policyId, recallId) already drafted.
      }
    }
    if (drafted.length > 0) {
      await this.events.publish('livestock_trade.claim.auto_drafted', {
        recallId: payload.recallId,
        claimIds: drafted.map((claim) => claim.id)
      });
    }
    return drafted;
  }

  private async recallOverlap(policy: InsurancePolicy, recalled: ReadonlySet<string>): Promise<string[]> {
    if (policy.subjectType === 'animal') {
      return recalled.has(policy.subjectId) ? [policy.subjectId] : [];
    }
    try {
      const members = await this.lots.listAnimalIds(policy.subjectId);
      return members.filter((animalId) => recalled.has(animalId));
    } catch {
      // Unknown/gone lot: guard so the subscriber never throws on bad data.
      return [];
    }
  }

  private assertClaimAssessor(caller: User, policy: InsurancePolicy): void {
    const allowed =
      caller.id === policy.insurerUserId ||
      caller.roles.includes('admin') ||
      (caller.roles.includes('insurer') && policy.insurerUserId === undefined);
    if (!allowed) {
      throw new ForbiddenException('Only the insurer of record (or admin) can settle claims');
    }
  }
}
