import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  CreditProfile,
  CreditSignal,
  KycRequirement,
  KycTier,
  LenderMatch,
  VaultDocument
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  CREDIT_PROFILE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  LENDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import type { DocumentRepository } from '../../database/repositories/document.repository.js';
import type { LenderRepository } from '../../database/repositories/lender.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { LearningService } from '../learning/learning.service.js';
import { UsersService } from '../users/users.service.js';

const KYC_FLOW: Record<KycTier, KycRequirement[]> = {
  tier_0: [
    { tier: 'tier_1', requirement: 'Verify your phone number with an OTP' },
    { tier: 'tier_1', requirement: 'Add your state and LGA to your profile' }
  ],
  tier_1: [
    { tier: 'tier_2', requirement: 'Upload a national ID or voter card' },
    { tier: 'tier_2', requirement: 'Complete one learning course' }
  ],
  tier_2: [
    { tier: 'tier_3', requirement: 'Upload a land title or farm photo' },
    { tier: 'tier_3', requirement: 'Complete three learning courses' },
    { tier: 'tier_3', requirement: 'Add a business plan for your farm enterprise' }
  ],
  tier_3: []
};

const TIER_SCORE: Record<KycTier, number> = {
  tier_0: 0,
  tier_1: 25,
  tier_2: 50,
  tier_3: 75
};

export interface UploadDocumentInput {
  userId: string;
  kind: VaultDocument['kind'];
  fileName: string;
  storageRef?: string;
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly users: UsersService,
    private readonly learning: LearningService,
    @Inject(CREDIT_PROFILE_REPOSITORY) private readonly creditProfiles: CreditProfileRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(LENDER_REPOSITORY) private readonly lenders: LenderRepository
  ) {}

  /** Recomputes the member credit-readiness profile from live signals. */
  async creditProfile(userId: string): Promise<CreditProfile> {
    const user = await this.users.getById(userId);
    const completedCourses = await this.learning.enrolmentsForUser(userId);
    const documents = await this.documents.find({ userId });

    const signals: CreditSignal[] = [
      {
        key: 'kyc',
        label: 'Identity verification',
        score: TIER_SCORE[user.kycTier],
        maxScore: 75,
        detail: `Current KYC tier: ${user.kycTier.replace('_', ' ')}`
      },
      {
        key: 'learning',
        label: 'Learning progress',
        score: Math.min(completedCourses.filter((e) => e.status === 'completed').length * 10, 30),
        maxScore: 30,
        detail: `${completedCourses.filter((e) => e.status === 'completed').length} courses completed`
      },
      {
        key: 'documents',
        label: 'Document vault',
        score: Math.min(documents.filter((d) => d.status === 'verified').length * 10, 30),
        maxScore: 30,
        detail: `${documents.filter((d) => d.status === 'verified').length} verified documents`
      },
      {
        key: 'verification',
        label: 'Account verification',
        score: user.isVerified ? 15 : 0,
        maxScore: 15,
        detail: user.isVerified ? 'Phone verified' : 'Phone verification pending'
      }
    ];

    const total = signals.reduce((sum, signal) => sum + signal.score, 0);
    const tier: CreditProfile['tier'] =
      total >= 100 ? 'excellent' : total >= 70 ? 'good' : total >= 40 ? 'building' : 'starting';

    const profile: CreditProfile = {
      userId,
      score: total,
      tier,
      signals,
      computedAt: new Date().toISOString()
    };
    await this.creditProfiles.upsert(profile);
    await this.events.publish(
      'finance.credit_profile.computed',
      { userId, score: total, tier },
      userId
    );
    return profile;
  }

  async kycStatus(userId: string): Promise<{ tier: KycTier; requirements: KycRequirement[] }> {
    const user = await this.users.getById(userId);
    return { tier: user.kycTier, requirements: KYC_FLOW[user.kycTier] };
  }

  /**
   * Lender matches for the member's current credit profile.
   *
   * WP-G15: the built-in catalogue entries are SAMPLE data (`source:
   * 'sample_catalogue'`, `verified: false`) — honest fixtures for
   * development and demos. In production they are suppressed by default
   * (503, fail closed) so an unverified lender can never be presented as a
   * real offer; LENDER_CATALOGUE=sample explicitly opts back in (e.g. a
   * reviewed demo environment). Lenders loaded from a real catalogue
   * integration carry `source: 'integrated'` and are served in any
   * environment.
   */
  async lenderMatches(userId: string): Promise<LenderMatch[]> {
    const profile = await this.creditProfile(userId);
    const lenders = await this.lenders.find({ active: true });
    const sample = lenders.filter((lender) => lender.source === 'sample_catalogue');
    if (isProduction() && sample.length > 0 && process.env.LENDER_CATALOGUE !== 'sample') {
      throw new ServiceUnavailableException(
        'Lender matching is not live: the built-in lender catalogue is unverified sample data ' +
          'and is suppressed in production (LENDER_CATALOGUE=sample opts back in for demos).'
      );
    }
    return lenders.map((lender) => ({
      lender,
      eligible: profile.score >= lender.minScore,
      fitScore: Math.max(0, Math.min(100, 100 - (lender.minScore - profile.score)))
    }));
  }

  async listDocuments(userId?: string, status?: VaultDocument['status']): Promise<VaultDocument[]> {
    return this.documents.find({ userId, status });
  }

  async uploadDocument(input: UploadDocumentInput): Promise<VaultDocument> {
    const document: VaultDocument = {
      id: newId('document'),
      userId: input.userId,
      kind: input.kind,
      fileName: input.fileName,
      storageRef: input.storageRef,
      status: 'uploaded',
      uploadedAt: new Date().toISOString()
    };
    const created = await this.documents.create(document);
    await this.events.publish(
      'finance.document.uploaded',
      { documentId: created.id, kind: created.kind },
      input.userId
    );
    return created;
  }

  async setDocumentStatus(
    id: string,
    status: VaultDocument['status'],
    reviewerId: string
  ): Promise<VaultDocument> {
    if (status === 'uploaded') {
      throw new BadRequestException('A document cannot transition back to uploaded');
    }
    const updated = await this.documents.update(id, {
      status,
      ...(status === 'verified' ? { verifiedAt: new Date().toISOString() } : {})
    });
    await this.events.publish(
      'finance.document.reviewed',
      { documentId: id, status, reviewerId },
      reviewerId
    );
    return updated;
  }
}
