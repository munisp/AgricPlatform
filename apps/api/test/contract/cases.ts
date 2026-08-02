import { expect } from 'vitest';
import type {
  Certificate,
  ConsentRecord,
  Course,
  Enrolment,
  ForumTopic,
  MarketplaceListing,
  Opportunity,
  Order,
  User
} from '@agric-platform/shared';
import type { TopicFlag } from '../../src/database/seed-data.js';
import type { RepositoryContractCase } from './repository.contract.js';
import type { CertificateCriteria } from '../../src/database/repositories/certificate.repository.js';
import type { ConsentCriteria } from '../../src/database/repositories/consent.repository.js';
import type { CourseCriteria } from '../../src/database/repositories/course.repository.js';
import type { EnrolmentCriteria } from '../../src/database/repositories/enrolment.repository.js';
import type { ForumTopicCriteria } from '../../src/database/repositories/forum-topic.repository.js';
import type { ListingCriteria } from '../../src/database/repositories/listing.repository.js';
import type { OpportunityCriteria } from '../../src/database/repositories/opportunity.repository.js';
import type { OrderCriteria } from '../../src/database/repositories/order.repository.js';
import type { TopicFlagCriteria } from '../../src/database/repositories/topic-flag.repository.js';
import type { UserCriteria } from '../../src/database/repositories/user.repository.js';

/**
 * Table of contract cases shared by the in-memory suite (always on) and the
 * pg suite (DATABASE_URL gated). `make` is bound per suite.
 */
export function contractCases(
  bind: (name: string) => unknown
): Array<RepositoryContractCase<never, never>> {
  const cases: Array<RepositoryContractCase<any, any>> = [
    {
      name: 'user',
      make: () => bind('user') as any,
      primary: (): User => ({
        id: 'contract-user-1',
        phone: '+2348000000001',
        fullName: 'Contract Farmer',
        roles: ['farmer'],
        preferredLanguage: 'en',
        kycTier: 'tier_0',
        isVerified: false,
        createdAt: new Date().toISOString()
      }),
      secondary: (): User => ({
        id: 'contract-user-2',
        phone: '+2348000000002',
        fullName: 'Contract Buyer',
        roles: ['buyer'],
        preferredLanguage: 'ha',
        kycTier: 'tier_0',
        isVerified: false,
        createdAt: new Date().toISOString()
      }),
      matchCriteria: { role: 'farmer' } satisfies UserCriteria,
      patch: { fullName: 'Renamed Farmer' },
      assertPatched: (updated: User) => expect(updated.fullName).toBe('Renamed Farmer')
    },
    {
      name: 'course',
      make: () => bind('course') as any,
      primary: (): Course => ({
        id: 'contract-course-1',
        title: 'Contract Agronomy',
        category: 'agronomy',
        level: 'beginner',
        durationMinutes: 45,
        language: 'en',
        enrolmentCount: 0,
        offlineAvailable: false
      }),
      secondary: (): Course => ({
        id: 'contract-course-2',
        title: 'Contract Finance',
        category: 'finance',
        level: 'advanced',
        durationMinutes: 90,
        language: 'yo',
        enrolmentCount: 0,
        offlineAvailable: true
      }),
      matchCriteria: { category: 'agronomy' } satisfies CourseCriteria,
      patch: { enrolmentCount: 7 },
      assertPatched: (updated: Course) => expect(updated.enrolmentCount).toBe(7)
    },
    {
      name: 'enrolment',
      make: () => bind('enrolment') as any,
      primary: (): Enrolment => ({
        id: 'contract-enrolment-1',
        userId: 'contract-user-1',
        courseId: 'contract-parent-course',
        progressPercent: 10,
        status: 'enrolled',
        enrolledAt: new Date().toISOString()
      }),
      secondary: (): Enrolment => ({
        id: 'contract-enrolment-2',
        userId: 'contract-user-2',
        courseId: 'contract-parent-course',
        progressPercent: 100,
        status: 'completed',
        enrolledAt: new Date().toISOString()
      }),
      matchCriteria: { userId: 'contract-user-1' } satisfies EnrolmentCriteria,
      patch: { progressPercent: 55, status: 'in_progress' },
      assertPatched: (updated: Enrolment) => expect(updated.progressPercent).toBe(55)
    },
    {
      name: 'certificate',
      make: () => bind('certificate') as any,
      primary: (): Certificate => ({
        id: 'contract-cert-1',
        userId: 'contract-user-1',
        courseId: 'contract-parent-course',
        verificationCode: 'NYFN-CERT-2099-9001',
        issuedAt: new Date().toISOString(),
        verificationUrl: '/api/v1/certificates/verify/NYFN-CERT-2099-9001'
      }),
      secondary: (): Certificate => ({
        id: 'contract-cert-2',
        userId: 'contract-user-2',
        courseId: 'contract-parent-course',
        verificationCode: 'NYFN-CERT-2099-9002',
        issuedAt: new Date().toISOString(),
        verificationUrl: '/api/v1/certificates/verify/NYFN-CERT-2099-9002'
      }),
      matchCriteria: { verificationCode: 'NYFN-CERT-2099-9001' } satisfies CertificateCriteria,
      patch: { verificationUrl: '/changed' },
      assertPatched: (updated: Certificate) => expect(updated.verificationUrl).toBe('/changed')
    },
    {
      name: 'forum topic',
      make: () => bind('forumTopic') as any,
      primary: (): ForumTopic => ({
        id: 'contract-topic-1',
        title: 'Contract maize thread',
        category: 'crops',
        authorId: 'contract-user-1',
        state: 'Kano',
        crop: 'maize',
        replyCount: 0,
        createdAt: new Date().toISOString()
      }),
      secondary: (): ForumTopic => ({
        id: 'contract-topic-2',
        title: 'Contract poultry thread',
        category: 'livestock',
        authorId: 'contract-user-2',
        replyCount: 0,
        createdAt: new Date().toISOString()
      }),
      matchCriteria: { category: 'crops' } satisfies ForumTopicCriteria,
      patch: { replyCount: 3 },
      assertPatched: (updated: ForumTopic) => expect(updated.replyCount).toBe(3)
    },
    {
      name: 'topic flag',
      make: () => bind('topicFlag') as any,
      primary: (): TopicFlag => ({
        id: 'contract-flag-1',
        topicId: 'contract-parent-topic',
        reporterId: 'contract-user-2',
        reason: 'spam',
        status: 'open',
        createdAt: new Date().toISOString()
      }),
      secondary: (): TopicFlag => ({
        id: 'contract-flag-2',
        topicId: 'contract-parent-topic',
        reporterId: 'contract-user-1',
        reason: 'old',
        status: 'resolved',
        createdAt: new Date().toISOString()
      }),
      matchCriteria: { status: 'open' } satisfies TopicFlagCriteria,
      patch: { status: 'resolved' },
      assertPatched: (updated: TopicFlag) => expect(updated.status).toBe('resolved')
    },
    {
      name: 'opportunity',
      make: () => bind('opportunity') as any,
      primary: (): Opportunity => ({
        id: 'contract-opp-1',
        title: 'Contract grant',
        type: 'grant',
        description: 'Contract grant description',
        states: ['Kano'],
        valueChains: ['maize'],
        eligibility: [],
        deadline: new Date(Date.now() + 86400000).toISOString(),
        isActive: true
      }),
      secondary: (): Opportunity => ({
        id: 'contract-opp-2',
        title: 'Contract job',
        type: 'job',
        description: 'Contract job description',
        states: ['Lagos'],
        valueChains: ['poultry'],
        eligibility: [],
        deadline: new Date(Date.now() + 86400000).toISOString(),
        isActive: false
      }),
      matchCriteria: { type: 'grant' } satisfies OpportunityCriteria,
      patch: { isActive: false },
      assertPatched: (updated: Opportunity) => expect(updated.isActive).toBe(false)
    },
    {
      name: 'listing',
      make: () => bind('listing') as any,
      primary: (): MarketplaceListing => ({
        id: 'contract-listing-1',
        sellerId: 'contract-user-1',
        kind: 'produce',
        title: 'Contract maize lot',
        crop: 'maize',
        quantity: 10,
        unit: 'tonnes',
        priceNaira: 250000,
        location: { state: 'Kano', lga: 'Nassarawa' },
        isActive: true
      }),
      secondary: (): MarketplaceListing => ({
        id: 'contract-listing-2',
        sellerId: 'contract-user-2',
        kind: 'equipment',
        title: 'Contract tractor',
        quantity: 1,
        unit: 'unit',
        priceNaira: 5000000,
        location: { state: 'Lagos', lga: 'Ikeja' },
        isActive: false
      }),
      matchCriteria: { kind: 'produce' } satisfies ListingCriteria,
      patch: { priceNaira: 260000 },
      assertPatched: (updated: MarketplaceListing) => expect(updated.priceNaira).toBe(260000)
    },
    {
      name: 'order',
      make: () => bind('order') as any,
      primary: (): Order => ({
        id: 'contract-order-1',
        listingId: 'contract-parent-listing',
        buyerId: 'contract-user-2',
        sellerId: 'contract-user-1',
        quantity: 2,
        totalNaira: 500000,
        status: 'requested',
        escrowRequired: true,
        createdAt: new Date().toISOString()
      }),
      secondary: (): Order => ({
        id: 'contract-order-2',
        listingId: 'contract-parent-listing',
        buyerId: 'contract-user-1',
        sellerId: 'contract-user-2',
        quantity: 1,
        totalNaira: 100,
        status: 'completed',
        escrowRequired: false,
        createdAt: new Date().toISOString()
      }),
      matchCriteria: { buyerId: 'contract-user-2' } satisfies OrderCriteria,
      patch: { status: 'confirmed' },
      assertPatched: (updated: Order) => expect(updated.status).toBe('confirmed')
    },
    {
      name: 'consent',
      make: () => bind('consent') as any,
      primary: (): ConsentRecord => ({
        id: 'contract-consent-1',
        userId: 'contract-user-1',
        purpose: 'marketing_sms',
        granted: true,
        source: 'web',
        grantedAt: new Date().toISOString()
      }),
      secondary: (): ConsentRecord => ({
        id: 'contract-consent-2',
        userId: 'contract-user-2',
        purpose: 'data_sharing_partner',
        granted: false,
        source: 'agent',
        grantedAt: new Date().toISOString()
      }),
      matchCriteria: { userId: 'contract-user-1' } satisfies ConsentCriteria,
      patch: { granted: false, revokedAt: new Date().toISOString() },
      assertPatched: (updated: ConsentRecord) => expect(updated.granted).toBe(false)
    }
  ];
  return cases as Array<RepositoryContractCase<never, never>>;
}
