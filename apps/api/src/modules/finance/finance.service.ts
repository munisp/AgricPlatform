import { Injectable } from '@nestjs/common';
import type { CreditProfile, KycTier, VaultDocument } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { seedCreditProfiles, seedVaultDocuments } from '../../database/seed-data.js';
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
  private readonly creditProfiles: InMemoryRepository<CreditProfile & { id: string }>;
  private readonly documents = new InMemoryRepository<VaultDocument>(seedVaultDocuments);

  constructor(
    private readonly events: DomainEventsService,
    private readonly users: UsersService,
    private readonly learning: LearningService
  ) {
    this.creditProfiles = new InMemoryRepository(
      seedCreditProfiles.map((profile) => ({ ...profile, id: profile.userId }))
    );
  }

  /** Credit readiness profile, recomputed from live signals. */
  creditProfile(userId: string): CreditProfile {
    this.users.getById(userId);
    const documents = this.documents.find((d) => d.userId === userId);
    const completedCourses = this.learning
      .enrolmentsForUser(userId)
      .filter((e) => e.status === 'completed').length;
    const verifiedDocs = documents.filter((d) => d.status === 'verified').length;

    const existing = this.creditProfiles.findById(userId);
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
      const stored = { ...profile, id: userId };
      if (existing) {
        this.creditProfiles.update(userId, stored);
      } else {
        this.creditProfiles.create(stored);
      }
      this.events.publish('finance.credit_profile.updated', { userId, score }, userId);
    }
    return profile;
  }

  uploadDocument(input: UploadDocumentInput): VaultDocument {
    this.users.getById(input.userId);
    const document: VaultDocument = {
      id: newId('doc'),
      userId: input.userId,
      kind: input.kind,
      fileName: input.fileName,
      status: 'uploaded',
      uploadedAt: new Date().toISOString()
    };
    const created = this.documents.create(document);
    this.events.publish(
      'finance.document.uploaded',
      { documentId: created.id, kind: created.kind },
      input.userId
    );
    this.creditProfile(input.userId); // refresh document count
    return created;
  }

  listDocuments(userId?: string, status?: VaultDocument['status']): VaultDocument[] {
    return this.documents.find(
      (d) => (!userId || d.userId === userId) && (!status || d.status === status)
    );
  }

  setDocumentStatus(id: string, status: VaultDocument['status'], actorId: string): VaultDocument {
    const updated = this.documents.update(id, { status });
    this.events.publish('finance.document.reviewed', { documentId: id, status }, actorId);
    this.creditProfile(updated.userId);
    return updated;
  }

  kycStatus(userId: string): KycStatus {
    const user = this.users.getById(userId);
    const tiers: KycTier[] = ['tier_0', 'tier_1', 'tier_2', 'tier_3'];
    const index = tiers.indexOf(user.kycTier);
    return {
      userId,
      tier: user.kycTier,
      nextTier: tiers[index + 1],
      requirements: KYC_REQUIREMENTS[user.kycTier]
    };
  }

  /** Lender matching against the credit profile (stub lenders, no network). */
  lenderMatches(userId: string): LenderMatch[] {
    const profile = this.creditProfile(userId);
    return [
      {
        lender: 'NYFN Cooperative Credit Window',
        product: 'Input financing (per season)',
        maxAmountNaira: 500000,
        eligible: profile.score >= 40,
        reason: 'Requires credit score 40+ and verified membership'
      },
      {
        lender: 'Partner MFI Network',
        product: 'Asset financing (equipment)',
        maxAmountNaira: 3000000,
        eligible: profile.score >= 60 && profile.documentCount >= 2,
        reason: 'Requires credit score 60+ and two vault documents'
      },
      {
        lender: 'Commercial Agri Desk',
        product: 'Working capital line',
        maxAmountNaira: 10000000,
        eligible: profile.score >= 75,
        reason: 'Requires credit score 75+ and tier 2 KYC'
      }
    ];
  }
}
