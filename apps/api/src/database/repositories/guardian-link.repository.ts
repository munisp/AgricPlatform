import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Shared-phone / assisted accounts (V-44, migration 087). identity.users.phone
 * stays mandatory+unique for SELF-SERVICE accounts; an assisted (phoneless or
 * shared-SIM) identity instead carries a synthetic internal phone
 * (`assisted:<id>`) and the real contact phone lives HERE, on the guardian
 * link — so two farmers share one contact phone with distinct identities.
 *
 * Every link requires a presence proof: the guardian (or custodian agent) was
 * physically present at onboarding and attested the dependent's identity.
 */
export type GuardianLinkKind = 'guardian' | 'agent_custody';

export interface PresenceProof {
  /** e.g. 'in_person_attestation', 'chapter_witness', 'agent_kyc_visit'. */
  method: string;
  /** Evidence reference (signed attestation id, visit log ref, ...). */
  ref: string;
  attestedAt: string;
}

export interface GuardianLink {
  id: string;
  /** The assisted/dependent account (identity.users.id). */
  dependentUserId: string;
  /** Guardian account (kind=guardian) — mutually exclusive with agent. */
  guardianUserId?: string;
  /** Custodian agent account (kind=agent_custody). */
  custodianAgentId?: string;
  kind: GuardianLinkKind;
  relationship: string;
  /** Shared contact phone for reaching the dependent (E.164). */
  contactPhone: string;
  presenceProof: PresenceProof;
  createdAt: string;
  revokedAt?: string;
}

export interface GuardianLinkCriteria {
  dependentUserId?: string;
  guardianUserId?: string;
  custodianAgentId?: string;
  contactPhone?: string;
}

export interface GuardianLinkRepository
  extends AsyncRepository<GuardianLink, GuardianLinkCriteria> {}

export function guardianLinkMatcher(criteria: GuardianLinkCriteria): (link: GuardianLink) => boolean {
  return (link) =>
    (!criteria.dependentUserId || link.dependentUserId === criteria.dependentUserId) &&
    (!criteria.guardianUserId || link.guardianUserId === criteria.guardianUserId) &&
    (!criteria.custodianAgentId || link.custodianAgentId === criteria.custodianAgentId) &&
    (!criteria.contactPhone || link.contactPhone === criteria.contactPhone);
}

export class InMemoryGuardianLinkRepository
  extends InMemoryRepository<GuardianLink, GuardianLinkCriteria>
  implements GuardianLinkRepository
{
  constructor(seed: readonly GuardianLink[] = []) {
    super(seed, guardianLinkMatcher);
  }
}

export function createInMemoryGuardianLinkRepository(): InMemoryGuardianLinkRepository {
  return new InMemoryGuardianLinkRepository();
}
