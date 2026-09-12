import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CreditProfile, KycTier, VaultDocument } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  CREDIT_PROFILE_REPOSITORY,
  DOCUMENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import type { DocumentRepository } from '../../database/repositories/document.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { LearningService } from '../learning/learning.service.js';
import { UsersService } from '../users/users.service.js';

export interface UploadDocumentInput {
  userId: string;
  kind: VaultDocument['kind'];
  fileName: string;
}

export interface LenderMatch {
  lender: string;
  product: string;
  maxAmountNaira: number;
  eligible: boolean;
  reason: string;
  /**
   * Provenance label (WP-G15): the built-in catalogue is a hardcoded SAMPLE
   * — never a verified, live lender repository. A real repository is a
   * separate package; until one is wired every row is 'sample_catalogue'.
   */
  source: 'sample_catalogue';
  /** Always false for the sample catalogue — these are NOT vetted lenders. */
  verified: boolean;
}

export interface KycStatus {
  userId: string;
  tier: KycTier;
  nextTier?: KycTier;
  requirements: string[];
}

const KYC_REQUIREMENTS: Record<KycTier, string[]> = {
  tier_0: ['Verified phone number', 'National ID upload', 'State/LGA on profile'],
  tier_1: ['BVN or NIN verification', 'Farm photo evidence', 'One completed course'],
  tier_2: ['Land title or lease', 'Business plan', 'Six months of marketplace history'],
  tier_3: []
};

@Injectable()
export class FinanceService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly users: UsersService,
    private readonly learning: LearningService,
    @Inject(CREDIT_PROFILE_REPOSITORY) private readonly creditProfiles: CreditProfileRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository
  ) {}

  /** Credit readiness profile, recomputed from live signals. */
  async creditProfile(userId: string): Promise<CreditProfile> {
    await this.users.getById(userId);
    const [documents, enrolments, existing] = await Promise.all([
      this.documents.find({ userId }),
      this.learning.enrolmentsForUser(userId),
      this.creditProfiles.findByUserId(userId)
    ]);
    const completedCourses = enrolments.filter((e) => e.status === 'completed').length;
    const verifiedDocs = documents.filter((d) => d.status === 'verified').length;

    const trainingSignals = Math.min(30, completedCourses * 10);
    const transactionSignals = existing?.transactionSignals ?? 0;
    const productionSignals = Math.min(40, (existing?.productionSignals ?? 10) + verifiedDocs * 5);
    const score = Math.min(100, trainingSignals + transactionSignals + productionSignals + 10);

    const improvementActions: string[] = [];
    if (completedCourses === 0) improvementActions.push('Complete a learning academy course');
    if (verifiedDocs === 0) improvementActions.push('Upload and verify an identity document');
    if (!documents.some((d) => d.kind === 'land_title' && d.status === 'verified')) {
      improvementActions.push('Verify land title or lease');
    }

    const profile: CreditProfile = {
      userId,
      score,
      trainingSignals,
      transactionSignals,
      productionSignals,
      documentCount: documents.length,
      improvementActions
    };

    if (!existing || existing.score !== score || existing.documentCount !== documents.length) {
      await this.creditProfiles.upsert(profile);
      await this.events.publish('finance.credit_profile.updated', { userId, score }, userId);
    }
    return profile;
  }

  async uploadDocument(input: UploadDocumentInput): Promise<VaultDocument> {
    await this.users.getById(input.userId);
    const document: VaultDocument = {
      id: newId('doc'),
      userId: input.userId,
      kind: input.kind,
      fileName: input.fileName,
      status: 'uploaded',
      uploadedAt: new Date().toISOString()
    };
    const created = await this.documents.create(document);
    await this.events.publish(
      'finance.document.uploaded',
      { documentId: created.id, kind: created.kind },
      input.userId
    );
    await this.creditProfile(input.userId); // refresh document count
    return created;
  }

  async listDocuments(userId?: string, status?: VaultDocument['status']): Promise<VaultDocument[]> {
    return this.documents.find({ userId, status });
  }

  async setDocumentStatus(
    id: string,
    status: VaultDocument['status'],
    actorId: string
  ): Promise<VaultDocument> {
    const updated = await this.documents.update(id, { status });
    await this.events.publish('finance.document.reviewed', { documentId: id, status }, actorId);
    await this.creditProfile(updated.userId);
    return updated;
  }

  async kycStatus(userId: string): Promise<KycStatus> {
    const user = await this.users.getById(userId);
    const tiers: KycTier[] = ['tier_0', 'tier_1', 'tier_2', 'tier_3'];
    const index = tiers.indexOf(user.kycTier);
    return {
      userId,
      tier: user.kycTier,
      nextTier: tiers[index + 1],
      requirements: KYC_REQUIREMENTS[user.kycTier]
    };
  }

  /**
   * Lender matching against the credit profile (SAMPLE catalogue, no
   * network). Every row is explicitly labelled source 'sample_catalogue'
   * with verified: false — these are illustrative fixtures, not vetted
   * lenders. FAIL-CLOSED (WP-G15): in production the sample catalogue is
   * suppressed with 503 unless LENDER_CATALOGUE=sample is set explicitly
   * (demos/fixture seeding); serving unverified lenders as real matches in
   * prod would be fabricated financial guidance.
   */
  async lenderMatches(userId: string): Promise<LenderMatch[]> {
    if (
      isProduction() &&
      (process.env.LENDER_CATALOGUE ?? '').trim().toLowerCase() !== 'sample'
    ) {
      throw new ServiceUnavailableException(
        'Lender matching is unavailable: no verified lender repository is wired in production ' +
          'and the built-in catalogue is unverified sample data. Set LENDER_CATALOGUE=sample to ' +
          'explicitly serve the sample catalogue (clearly labelled, unverified).'
      );
    }
    const profile = await this.creditProfile(userId);
    return [
      {
        lender: 'NYFN Cooperative Credit Window',
        product: 'Input financing (per season)',
        maxAmountNaira: 500000,
        eligible: profile.score >= 40,
        reason: 'Requires credit score 40+ and verified membership',
        source: 'sample_catalogue',
        verified: false
      },
      {
        lender: 'Partner MFI Network',
        product: 'Asset financing (equipment)',
        maxAmountNaira: 3000000,
        eligible: profile.score >= 60 && profile.documentCount >= 2,
        reason: 'Requires credit score 60+ and two vault documents',
        source: 'sample_catalogue',
        verified: false
      },
      {
        lender: 'Commercial Agri Desk',
        product: 'Working capital line',
        maxAmountNaira: 10000000,
        eligible: profile.score >= 75,
        reason: 'Requires credit score 75+ and tier 2 KYC',
        source: 'sample_catalogue',
        verified: false
      }
    ];
  }
}
