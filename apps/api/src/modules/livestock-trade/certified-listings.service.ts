import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type {
  CertifiedListing,
  CertifiedListingStatus,
  LivestockSubjectType,
  User
} from '@agric-platform/shared';
import { LIVESTOCK_CONSENT_DOMAIN } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  CERTIFIED_LISTING_REPOSITORY,
  LOT_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  LotRepository,
  OwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import type { CertifiedListingRepository } from '../../database/repositories/livestock-trade.repository.js';
import { PrivacyService } from '../privacy/privacy.service.js';
import { assertKobo, requireActor, resolveSubject } from './trade.utils.js';

export interface CreateCertifiedListingInput {
  subjectType: LivestockSubjectType;
  subjectId: string;
  askingPriceKobo?: number;
}

/** Buyer-safe public provenance summary (G18) — no PII. */
export interface CertifiedProvenanceSummary {
  listingId: string;
  certificationStatus: CertifiedListingStatus;
  subjectType: LivestockSubjectType;
  species: string;
  breed?: string;
  quantity?: number;
  ownershipDepth: number;
  state?: string;
}

/**
 * Lifecycle rules (blueprint F4): a listing starts as a draft, goes active
 * for marketplace discovery, and closes as sold or withdrawn. Admins may
 * additionally revoke certification (e.g. provenance fraud) from any
 * non-terminal state.
 */
export const LISTING_TRANSITIONS: Record<CertifiedListingStatus, readonly CertifiedListingStatus[]> = {
  draft: ['active', 'withdrawn', 'revoked'],
  active: ['sold', 'withdrawn', 'revoked'],
  sold: [],
  withdrawn: [],
  revoked: []
};

/**
 * Certified livestock listings (F4). Only the registry owner may certify
 * their own animals/lots; certification requires an active
 * livestock_records consent grant and captures a provenance snapshot
 * (ownership-transfer depth) at creation time.
 */
@Injectable()
export class CertifiedListingsService {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(OWNERSHIP_TRANSFER_REPOSITORY)
    private readonly transfers: OwnershipTransferRepository,
    @Inject(CERTIFIED_LISTING_REPOSITORY)
    private readonly listings: CertifiedListingRepository
  ) {}

  async create(actor: User | null, input: CreateCertifiedListingInput): Promise<CertifiedListing> {
    const caller = requireActor(actor);
    const subject = await resolveSubject(this.animals, this.lots, input.subjectType, input.subjectId);
    if (subject.ownerUserId !== caller.id) {
      throw new ForbiddenException('Only the owner can certify their own animals or lots');
    }
    if (input.askingPriceKobo !== undefined) {
      assertKobo(input.askingPriceKobo, 'askingPriceKobo', { allowZero: true });
    }
    const consent = (await this.privacy.consentsFor(caller.id)).find(
      (record) =>
        record.purpose === LIVESTOCK_CONSENT_DOMAIN && record.granted && !record.revokedAt
    );
    if (!consent) {
      throw new BadRequestException(
        'Livestock certification requires an active livestock_records consent grant (enrol first)'
      );
    }
    const duplicate = await this.listings.findOne({ subjectType: input.subjectType, subjectId: input.subjectId });
    if (duplicate && (duplicate.status === 'draft' || duplicate.status === 'active')) {
      throw new ConflictException(
        `Subject '${input.subjectId}' already has a ${duplicate.status} certified listing`
      );
    }
    const ownershipDepth =
      input.subjectType === 'animal'
        ? (await this.transfers.find({ animalId: input.subjectId })).length
        : 0;
    const now = new Date().toISOString();
    const listing: CertifiedListing = {
      id: newId('listing'),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      sellerUserId: caller.id,
      species: subject.species,
      breed: subject.breed,
      quantity: subject.quantity,
      askingPriceKobo: input.askingPriceKobo,
      status: 'draft',
      provenance: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        species: subject.species,
        breed: subject.breed,
        ownershipDepth,
        consentGranted: true
      },
      createdAt: now,
      updatedAt: now
    };
    const created = await this.listings.create(listing);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.listing_certified',
      entityType: 'certified_listing',
      entityId: created.id,
      metadata: { subjectType: input.subjectType, subjectId: input.subjectId, ownershipDepth }
    });
    await this.events.publish(
      'livestock_trade.listing.created',
      { listingId: created.id, subjectType: input.subjectType, subjectId: input.subjectId },
      caller.id
    );
    return created;
  }

  async listMine(actor: User | null): Promise<CertifiedListing[]> {
    const caller = requireActor(actor);
    return this.listings.find({ sellerUserId: caller.id });
  }

  /**
   * Public, buyer-safe provenance summary (G18): certification status,
   * species, ownership depth and state — exactly what a certified-listing
   * badge may show a buyer. No seller identity or subject id is exposed.
   * Draft/withdrawn listings were never (or are no longer) on the market,
   * so they 404 here rather than leak existence; `revoked` stays visible —
   * a buyer MUST be able to discover that a certification was pulled.
   */
  async provenanceSummary(id: string): Promise<CertifiedProvenanceSummary> {
    const listing = await this.listings.getById(id);
    if (listing.status === 'draft' || listing.status === 'withdrawn') {
      throw new NotFoundException(`Certified listing '${id}' was not found`);
    }
    let state: string | undefined;
    try {
      state = (
        await resolveSubject(this.animals, this.lots, listing.subjectType, listing.subjectId)
      ).state;
    } catch {
      // Subject left the registry (archived animal) — state is optional.
      state = undefined;
    }
    return {
      listingId: listing.id,
      certificationStatus: listing.status,
      subjectType: listing.subjectType,
      species: listing.species,
      breed: listing.breed,
      quantity: listing.quantity,
      ownershipDepth: listing.provenance.ownershipDepth,
      state
    };
  }

  /** Active listings are discoverable by any authenticated user; anything
   * else is owner-or-admin only. */
  async getById(actor: User | null, id: string): Promise<CertifiedListing> {
    const listing = await this.listings.getById(id);
    if (listing.status !== 'active') {
      assertSelfOrAdmin(actor, listing.sellerUserId);
    } else {
      requireActor(actor);
    }
    return listing;
  }

  /** draft → active (owner or admin). */
  async activate(actor: User | null, id: string): Promise<CertifiedListing> {
    return this.transition(actor, id, 'active');
  }

  /** active → sold (owner or admin). */
  async markSold(actor: User | null, id: string): Promise<CertifiedListing> {
    return this.transition(actor, id, 'sold');
  }

  /** draft|active → withdrawn (owner or admin). */
  async withdraw(actor: User | null, id: string): Promise<CertifiedListing> {
    return this.transition(actor, id, 'withdrawn');
  }

  /** Admin-only certification revocation with a mandatory reason. */
  async revoke(actor: User | null, id: string, reason: string): Promise<CertifiedListing> {
    const caller = requireActor(actor);
    if (!caller.roles.includes('admin')) {
      throw new ForbiddenException('Only an administrator can revoke a certification');
    }
    if (!reason.trim()) {
      throw new BadRequestException('A revocation reason is required');
    }
    const listing = await this.listings.getById(id);
    const updated = await this.applyTransition(listing, 'revoked', caller, {
      revokedByUserId: caller.id,
      revokedAt: new Date().toISOString(),
      revocationReason: reason
    });
    return updated;
  }

  private async transition(
    actor: User | null,
    id: string,
    to: CertifiedListingStatus
  ): Promise<CertifiedListing> {
    const caller = requireActor(actor);
    const listing = await this.listings.getById(id);
    assertSelfOrAdmin(caller, listing.sellerUserId);
    return this.applyTransition(listing, to, caller, {});
  }

  private async applyTransition(
    listing: CertifiedListing,
    to: CertifiedListingStatus,
    caller: User,
    extra: Partial<CertifiedListing>
  ): Promise<CertifiedListing> {
    const allowed = LISTING_TRANSITIONS[listing.status];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Invalid listing transition from '${listing.status}' to '${to}'`
      );
    }
    const updated = await this.listings.update(listing.id, {
      status: to,
      ...extra,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: `livestock_trade.listing_${to === 'active' ? 'activated' : to}`,
      entityType: 'certified_listing',
      entityId: listing.id,
      metadata: { from: listing.status, to }
    });
    await this.events.publish(
      'livestock_trade.listing.transitioned',
      { listingId: listing.id, from: listing.status, to },
      caller.id
    );
    return updated;
  }
}
