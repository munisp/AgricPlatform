import { Global, Module } from '@nestjs/common';
import type pg from 'pg';
import { PgPoolProvider } from './pg/pg-pool.provider.js';
import {
  ADVISORY_REPOSITORY,
  ANNOUNCEMENT_REPOSITORY,
  APPLICATION_REPOSITORY,
  AUDIT_REPOSITORY,
  CAMPUS_CLUB_MEMBERSHIP_REPOSITORY,
  CAMPUS_CLUB_REPOSITORY,
  CERTIFICATE_REPOSITORY,
  CHAPTER_EVENT_REPOSITORY,
  CHAPTER_REPOSITORY,
  COHORT_THREAD_POST_REPOSITORY,
  COHORT_THREAD_REPOSITORY,
  CONSENT_REPOSITORY,
  COURSE_REPOSITORY,
  CREDIT_PROFILE_REPOSITORY,
  DELETION_REQUEST_REPOSITORY,
  DELIVERY_LOG_REPOSITORY,
  DOCUMENT_REPOSITORY,
  ENROLMENT_REPOSITORY,
  EVENT_RSVP_REPOSITORY,
  FORUM_TOPIC_REPOSITORY,
  JUDGE_ASSIGNMENT_REPOSITORY,
  JUDGE_SCORE_REPOSITORY,
  KNOWLEDGE_RESOURCE_REPOSITORY,
  LISTING_REPOSITORY,
  MENTOR_REQUEST_REPOSITORY,
  MILESTONE_PROGRESS_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OPPORTUNITY_REPOSITORY,
  ORDER_REPOSITORY,
  OUTBOX_REPOSITORY,
  PATHWAY_ENROLMENT_REPOSITORY,
  PATHWAY_STAGE_REPOSITORY,
  PATHWAY_TEMPLATE_REPOSITORY,
  PG_POOL,
  PODCAST_EPISODE_REPOSITORY,
  PROFILE_REPOSITORY,
  PROGRAMME_COHORT_REPOSITORY,
  PROGRAMME_ENROLMENT_REPOSITORY,
  PROGRAMME_MILESTONE_REPOSITORY,
  REVIEW_REPOSITORY,
  RUBRIC_CRITERION_REPOSITORY,
  SEARCH_QUERY_REPOSITORY,
  SERVICE_BOOKING_REPOSITORY,
  SERVICE_OFFERING_REPOSITORY,
  SERVICE_REVIEW_REPOSITORY,
  STAGE_PROGRESS_REPOSITORY,
  SUPPLIER_REPOSITORY,
  TOPIC_FLAG_REPOSITORY,
  USER_REPOSITORY,
  COMMODITY_PRICE_REPOSITORY,
  CREDIT_SCORE_REPOSITORY,
  ESCROW_REPOSITORY,
  INVOICE_REPOSITORY,
  LEDGER_ACCOUNT_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  LENDER_REPOSITORY,
  LOAN_APPLICATION_REPOSITORY,
  REPAYMENT_SCHEDULE_REPOSITORY,
  SHIPMENT_REPOSITORY,
  WEBINAR_REGISTRATION_REPOSITORY,
  WEBINAR_REPOSITORY
} from './persistence.tokens.js';
import { createInMemoryAdvisoryRepository } from './repositories/advisory.repository.js';
import { createPgAdvisoryRepository } from './repositories/advisory.pg-repository.js';
import { createInMemoryAnnouncementRepository } from './repositories/announcement.repository.js';
import { createInMemoryApplicationRepository } from './repositories/application.repository.js';
import { createInMemoryAuditRepository } from './repositories/audit.repository.js';
import { createInMemoryCertificateRepository } from './repositories/certificate.repository.js';
import { createInMemoryChapterEventRepository } from './repositories/chapter-event.repository.js';
import { createInMemoryChapterRepository } from './repositories/chapter.repository.js';
import {
  createPgAnnouncementRepository,
  createPgChapterEventRepository,
  createPgChapterRepository,
  createPgEventRsvpRepository
} from './repositories/chapters.pg-repository.js';
import { createInMemoryConsentRepository } from './repositories/consent.repository.js';
import { createInMemoryCourseRepository } from './repositories/course.repository.js';
import { createInMemoryCreditProfileRepository } from './repositories/credit-profile.repository.js';
import { createInMemoryDeletionRequestRepository } from './repositories/deletion-request.repository.js';
import { createInMemoryDeliveryLogRepository } from './repositories/delivery-log.repository.js';
import { createInMemoryDocumentRepository } from './repositories/document.repository.js';
import { createInMemoryEnrolmentRepository } from './repositories/enrolment.repository.js';
import { createInMemoryEventRsvpRepository } from './repositories/event-rsvp.repository.js';
import { createInMemoryForumTopicRepository } from './repositories/forum-topic.repository.js';
import {
  createPgCreditProfileRepository,
  createPgDocumentRepository
} from './repositories/finance.pg-repository.js';
import {
  createPgCertificateRepository,
  createPgCourseRepository,
  createPgEnrolmentRepository
} from './repositories/learning.pg-repository.js';
import { createInMemoryListingRepository } from './repositories/listing.repository.js';
import {
  createPgListingRepository,
  createPgOrderRepository,
  createPgReviewRepository
} from './repositories/marketplace.pg-repository.js';
import { createInMemoryMentorRequestRepository } from './repositories/mentor-request.repository.js';
import { createInMemoryNotificationPreferenceRepository } from './repositories/notification-preference.repository.js';
import { createInMemoryNotificationRepository } from './repositories/notification.repository.js';
import {
  createPgDeliveryLogRepository,
  createPgNotificationPreferenceRepository,
  createPgNotificationRepository
} from './repositories/notifications.pg-repository.js';
import { createInMemoryOpportunityRepository } from './repositories/opportunity.repository.js';
import {
  createPgApplicationRepository,
  createPgOpportunityRepository
} from './repositories/opportunities.pg-repository.js';
import { createInMemoryOrderRepository } from './repositories/order.repository.js';
import { createInMemoryOutboxRepository } from './repositories/outbox.repository.js';
import { createInMemoryProfileRepository } from './repositories/profile.repository.js';
import { createPgProfileRepository } from './repositories/profile.pg-repository.js';
import {
  createPgConsentRepository,
  createPgDeletionRequestRepository
} from './repositories/privacy.pg-repository.js';
import {
  createPgAuditRepository,
  createPgOutboxRepository
} from './repositories/core.pg-repository.js';
import { createInMemoryReviewRepository } from './repositories/review.repository.js';
import {
  createPgForumTopicRepository,
  createPgMentorRequestRepository,
  createPgTopicFlagRepository
} from './repositories/community.pg-repository.js';
import { createInMemoryTopicFlagRepository } from './repositories/topic-flag.repository.js';
import { createInMemoryUserRepository } from './repositories/user.repository.js';
import { createPgUserRepository } from './repositories/user.pg-repository.js';
import { createInMemoryCommodityPriceRepository } from './repositories/commodity-price.repository.js';
import { createPgCommodityPriceRepository } from './repositories/commodity-price.pg-repository.js';
// Engagement wave (P2b) repositories.
import {
  createInMemoryCampusClubMembershipRepository,
  createInMemoryCampusClubRepository
} from './repositories/campus-club.repository.js';
import {
  createInMemoryCohortThreadPostRepository,
  createInMemoryCohortThreadRepository
} from './repositories/cohort-thread.repository.js';
import {
  createInMemoryJudgeAssignmentRepository,
  createInMemoryJudgeScoreRepository,
  createInMemoryRubricCriterionRepository
} from './repositories/judging.repository.js';
import {
  createInMemoryKnowledgeResourceRepository,
  createInMemoryPodcastEpisodeRepository
} from './repositories/knowledge.repository.js';
import {
  createPgKnowledgeResourceRepository,
  createPgPodcastEpisodeRepository,
  createPgWebinarRegistrationRepository,
  createPgWebinarRepository
} from './repositories/knowledge.pg-repository.js';
import {
  createInMemoryPathwayEnrolmentRepository,
  createInMemoryStageProgressRepository
} from './repositories/pathway-enrolment.repository.js';
import {
  createInMemoryPathwayStageRepository,
  createInMemoryPathwayTemplateRepository
} from './repositories/pathway.repository.js';
import {
  createPgCampusClubMembershipRepository,
  createPgCampusClubRepository,
  createPgPathwayEnrolmentRepository,
  createPgPathwayStageRepository,
  createPgPathwayTemplateRepository,
  createPgStageProgressRepository
} from './repositories/pathways.pg-repository.js';
import { createInMemoryProgrammeCohortRepository } from './repositories/programme-cohort.repository.js';
import { createInMemoryProgrammeEnrolmentRepository } from './repositories/programme-enrolment.repository.js';
import {
  createInMemoryMilestoneProgressRepository,
  createInMemoryProgrammeMilestoneRepository
} from './repositories/programme-milestone.repository.js';
import {
  createPgCohortThreadPostRepository,
  createPgCohortThreadRepository,
  createPgJudgeAssignmentRepository,
  createPgJudgeScoreRepository,
  createPgMilestoneProgressRepository,
  createPgProgrammeCohortRepository,
  createPgProgrammeEnrolmentRepository,
  createPgProgrammeMilestoneRepository,
  createPgRubricCriterionRepository
} from './repositories/programmes.pg-repository.js';
import { createInMemorySearchQueryRepository } from './repositories/search-query.repository.js';
import { createPgSearchQueryRepository } from './repositories/search.pg-repository.js';
import { createInMemoryServiceBookingRepository } from './repositories/service-booking.repository.js';
import { createInMemoryServiceOfferingRepository } from './repositories/service-offering.repository.js';
import { createInMemoryServiceReviewRepository } from './repositories/service-review.repository.js';
import {
  createPgServiceBookingRepository,
  createPgServiceOfferingRepository,
  createPgServiceReviewRepository,
  createPgSupplierRepository
} from './repositories/services-marketplace.pg-repository.js';
import { createInMemorySupplierRepository } from './repositories/supplier.repository.js';
import {
  createInMemoryWebinarRegistrationRepository,
  createInMemoryWebinarRepository
} from './repositories/webinar.repository.js';
// Commerce & finance wave (P2a) repositories.
import { createInMemoryEscrowRepository } from './repositories/escrow.repository.js';
import { createInMemoryInvoiceRepository } from './repositories/invoice.repository.js';
import { createInMemoryShipmentRepository } from './repositories/shipment.repository.js';
import {
  createPgEscrowRepository,
  createPgInvoiceRepository,
  createPgShipmentRepository
} from './repositories/commerce.pg-repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from './repositories/ledger.repository.js';
import {
  createPgCreditScoreRepository,
  createPgLedgerAccountRepository,
  createPgLedgerEntryRepository
} from './repositories/ledger.pg-repository.js';
import { createInMemoryCreditScoreRepository } from './repositories/credit-score.repository.js';
import { createInMemoryLenderRepository } from './repositories/lender.repository.js';
import {
  createInMemoryLoanApplicationRepository,
  createInMemoryRepaymentScheduleRepository
} from './repositories/loan.repository.js';
import {
  createPgLenderRepository,
  createPgLoanApplicationRepository,
  createPgRepaymentScheduleRepository
} from './repositories/credit.pg-repository.js';
// Wave P5d: partner API persistence (additive).
import {
  API_KEY_REPOSITORY,
  PARTNER_CLIENT_REPOSITORY,
  WEBHOOK_SUBSCRIPTION_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryApiKeyRepository,
  createInMemoryPartnerClientRepository,
  createInMemoryWebhookSubscriptionRepository
} from './repositories/partner-api.repository.js';
import {
  createPgApiKeyRepository,
  createPgPartnerClientRepository,
  createPgWebhookSubscriptionRepository
} from './repositories/partner-api.pg-repository.js';

/**
 * Global persistence module. Repository tokens resolve to the pg
 * implementations when PG_POOL is live (DATABASE_URL configured) and to the
 * in-memory implementations otherwise. Services depend only on the port
 * interfaces.
 */
@Global()
@Module({
  providers: [
    PgPoolProvider,
    { provide: PG_POOL, useFactory: (provider: PgPoolProvider) => provider.pool, inject: [PgPoolProvider] },
    {
      provide: USER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgUserRepository(pool) : createInMemoryUserRepository()),
      inject: [PG_POOL]
    },
    {
      provide: PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgProfileRepository(pool) : createInMemoryProfileRepository()),
      inject: [PG_POOL]
    },
    {
      provide: CONSENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgConsentRepository(pool) : createInMemoryConsentRepository()),
      inject: [PG_POOL]
    },
    {
      provide: DELETION_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDeletionRequestRepository(pool) : createInMemoryDeletionRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COURSE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgCourseRepository(pool) : createInMemoryCourseRepository()),
      inject: [PG_POOL]
    },
    {
      provide: ENROLMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null, certificates: unknown) =>
        pool
          ? createPgEnrolmentRepository(pool)
          : createInMemoryEnrolmentRepository(
              certificates as Parameters<typeof createInMemoryEnrolmentRepository>[0]
            ),
      inject: [PG_POOL, CERTIFICATE_REPOSITORY]
    },
    {
      provide: CERTIFICATE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCertificateRepository(pool) : createInMemoryCertificateRepository(),
      inject: [PG_POOL]
    },
    {
      provide: FORUM_TOPIC_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgForumTopicRepository(pool) : createInMemoryForumTopicRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MENTOR_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMentorRequestRepository(pool) : createInMemoryMentorRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: TOPIC_FLAG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgTopicFlagRepository(pool) : createInMemoryTopicFlagRepository(),
      inject: [PG_POOL]
    },
    {
      provide: OPPORTUNITY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOpportunityRepository(pool) : createInMemoryOpportunityRepository(),
      inject: [PG_POOL]
    },
    {
      provide: APPLICATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null, opportunities: unknown) =>
        pool
          ? createPgApplicationRepository(pool)
          : createInMemoryApplicationRepository(
              opportunities as Parameters<typeof createInMemoryApplicationRepository>[0]
            ),
      inject: [PG_POOL, OPPORTUNITY_REPOSITORY]
    },
    {
      provide: CHAPTER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgChapterRepository(pool) : createInMemoryChapterRepository()),
      inject: [PG_POOL]
    },
    {
      provide: CHAPTER_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgChapterEventRepository(pool) : createInMemoryChapterEventRepository(),
      inject: [PG_POOL]
    },
    {
      provide: EVENT_RSVP_REPOSITORY,
      useFactory: (pool: pg.Pool | null, events: unknown) =>
        pool
          ? createPgEventRsvpRepository(pool)
          : createInMemoryEventRsvpRepository(
              events as Parameters<typeof createInMemoryEventRsvpRepository>[0]
            ),
      inject: [PG_POOL, CHAPTER_EVENT_REPOSITORY]
    },
    {
      provide: ANNOUNCEMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnnouncementRepository(pool) : createInMemoryAnnouncementRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ADVISORY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAdvisoryRepository(pool) : createInMemoryAdvisoryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LISTING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgListingRepository(pool) : createInMemoryListingRepository()),
      inject: [PG_POOL]
    },
    {
      provide: ORDER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgOrderRepository(pool) : createInMemoryOrderRepository()),
      inject: [PG_POOL]
    },
    {
      provide: REVIEW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgReviewRepository(pool) : createInMemoryReviewRepository()),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditProfileRepository(pool) : createInMemoryCreditProfileRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DOCUMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDocumentRepository(pool) : createInMemoryDocumentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null, deliveryLog: unknown) =>
        pool
          ? createPgNotificationRepository(pool)
          : createInMemoryNotificationRepository(
              deliveryLog as Parameters<typeof createInMemoryNotificationRepository>[0]
            ),
      inject: [PG_POOL, DELIVERY_LOG_REPOSITORY]
    },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgNotificationPreferenceRepository(pool) : createInMemoryNotificationPreferenceRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DELIVERY_LOG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDeliveryLogRepository(pool) : createInMemoryDeliveryLogRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AUDIT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgAuditRepository(pool) : createInMemoryAuditRepository()),
      inject: [PG_POOL]
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgOutboxRepository(pool) : createInMemoryOutboxRepository()),
      inject: [PG_POOL]
    },
    {
      provide: COMMODITY_PRICE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCommodityPriceRepository(pool) : createInMemoryCommodityPriceRepository(),
      inject: [PG_POOL]
    },
    // Engagement wave (P2b) providers.
    {
      provide: SUPPLIER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgSupplierRepository(pool) : createInMemorySupplierRepository()),
      inject: [PG_POOL]
    },
    {
      provide: SERVICE_OFFERING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgServiceOfferingRepository(pool) : createInMemoryServiceOfferingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SERVICE_BOOKING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgServiceBookingRepository(pool) : createInMemoryServiceBookingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SERVICE_REVIEW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgServiceReviewRepository(pool) : createInMemoryServiceReviewRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROGRAMME_COHORT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProgrammeCohortRepository(pool) : createInMemoryProgrammeCohortRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROGRAMME_ENROLMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProgrammeEnrolmentRepository(pool) : createInMemoryProgrammeEnrolmentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROGRAMME_MILESTONE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProgrammeMilestoneRepository(pool) : createInMemoryProgrammeMilestoneRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MILESTONE_PROGRESS_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMilestoneProgressRepository(pool) : createInMemoryMilestoneProgressRepository(),
      inject: [PG_POOL]
    },
    {
      provide: RUBRIC_CRITERION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRubricCriterionRepository(pool) : createInMemoryRubricCriterionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: JUDGE_ASSIGNMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgJudgeAssignmentRepository(pool) : createInMemoryJudgeAssignmentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: JUDGE_SCORE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgJudgeScoreRepository(pool) : createInMemoryJudgeScoreRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COHORT_THREAD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCohortThreadRepository(pool) : createInMemoryCohortThreadRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COHORT_THREAD_POST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCohortThreadPostRepository(pool) : createInMemoryCohortThreadPostRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PATHWAY_TEMPLATE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPathwayTemplateRepository(pool) : createInMemoryPathwayTemplateRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PATHWAY_STAGE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPathwayStageRepository(pool) : createInMemoryPathwayStageRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PATHWAY_ENROLMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPathwayEnrolmentRepository(pool) : createInMemoryPathwayEnrolmentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: STAGE_PROGRESS_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgStageProgressRepository(pool) : createInMemoryStageProgressRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CAMPUS_CLUB_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCampusClubRepository(pool) : createInMemoryCampusClubRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CAMPUS_CLUB_MEMBERSHIP_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCampusClubMembershipRepository(pool) : createInMemoryCampusClubMembershipRepository(),
      inject: [PG_POOL]
    },
    {
      provide: KNOWLEDGE_RESOURCE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgKnowledgeResourceRepository(pool) : createInMemoryKnowledgeResourceRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PODCAST_EPISODE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPodcastEpisodeRepository(pool) : createInMemoryPodcastEpisodeRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WEBINAR_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgWebinarRepository(pool) : createInMemoryWebinarRepository()),
      inject: [PG_POOL]
    },
    {
      provide: WEBINAR_REGISTRATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgWebinarRegistrationRepository(pool) : createInMemoryWebinarRegistrationRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SEARCH_QUERY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgSearchQueryRepository(pool) : createInMemorySearchQueryRepository(),
      inject: [PG_POOL]
    },
    // Commerce & finance wave (P2a) providers.
    {
      provide: ESCROW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgEscrowRepository(pool) : createInMemoryEscrowRepository()),
      inject: [PG_POOL]
    },
    {
      provide: INVOICE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgInvoiceRepository(pool) : createInMemoryInvoiceRepository()),
      inject: [PG_POOL]
    },
    {
      provide: SHIPMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgShipmentRepository(pool) : createInMemoryShipmentRepository()),
      inject: [PG_POOL]
    },
    {
      provide: LEDGER_ACCOUNT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLedgerAccountRepository(pool) : createInMemoryLedgerAccountRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LEDGER_ENTRY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLedgerEntryRepository(pool) : createInMemoryLedgerEntryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_SCORE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditScoreRepository(pool) : createInMemoryCreditScoreRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LENDER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgLenderRepository(pool) : createInMemoryLenderRepository()),
      inject: [PG_POOL]
    },
    {
      provide: LOAN_APPLICATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLoanApplicationRepository(pool) : createInMemoryLoanApplicationRepository(),
      inject: [PG_POOL]
    },
    {
      provide: REPAYMENT_SCHEDULE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRepaymentScheduleRepository(pool) : createInMemoryRepaymentScheduleRepository(),
      inject: [PG_POOL]
    },
    // Wave P5d: partner API repositories (appended; see partner-api module).
    {
      provide: PARTNER_CLIENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPartnerClientRepository(pool) : createInMemoryPartnerClientRepository(),
      inject: [PG_POOL]
    },
    {
      provide: API_KEY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgApiKeyRepository(pool) : createInMemoryApiKeyRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WEBHOOK_SUBSCRIPTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgWebhookSubscriptionRepository(pool)
          : createInMemoryWebhookSubscriptionRepository(),
      inject: [PG_POOL]
    }
  ],
  exports: [
    PG_POOL,
    USER_REPOSITORY,
    PROFILE_REPOSITORY,
    CONSENT_REPOSITORY,
    DELETION_REQUEST_REPOSITORY,
    COURSE_REPOSITORY,
    ENROLMENT_REPOSITORY,
    CERTIFICATE_REPOSITORY,
    FORUM_TOPIC_REPOSITORY,
    MENTOR_REQUEST_REPOSITORY,
    TOPIC_FLAG_REPOSITORY,
    OPPORTUNITY_REPOSITORY,
    APPLICATION_REPOSITORY,
    CHAPTER_REPOSITORY,
    CHAPTER_EVENT_REPOSITORY,
    EVENT_RSVP_REPOSITORY,
    ANNOUNCEMENT_REPOSITORY,
    ADVISORY_REPOSITORY,
    LISTING_REPOSITORY,
    ORDER_REPOSITORY,
    REVIEW_REPOSITORY,
    CREDIT_PROFILE_REPOSITORY,
    DOCUMENT_REPOSITORY,
    NOTIFICATION_REPOSITORY,
    NOTIFICATION_PREFERENCE_REPOSITORY,
    DELIVERY_LOG_REPOSITORY,
    AUDIT_REPOSITORY,
    OUTBOX_REPOSITORY,
    COMMODITY_PRICE_REPOSITORY,
    SUPPLIER_REPOSITORY,
    SERVICE_OFFERING_REPOSITORY,
    SERVICE_BOOKING_REPOSITORY,
    SERVICE_REVIEW_REPOSITORY,
    PROGRAMME_COHORT_REPOSITORY,
    PROGRAMME_ENROLMENT_REPOSITORY,
    PROGRAMME_MILESTONE_REPOSITORY,
    MILESTONE_PROGRESS_REPOSITORY,
    RUBRIC_CRITERION_REPOSITORY,
    JUDGE_ASSIGNMENT_REPOSITORY,
    JUDGE_SCORE_REPOSITORY,
    COHORT_THREAD_REPOSITORY,
    COHORT_THREAD_POST_REPOSITORY,
    PATHWAY_TEMPLATE_REPOSITORY,
    PATHWAY_STAGE_REPOSITORY,
    PATHWAY_ENROLMENT_REPOSITORY,
    STAGE_PROGRESS_REPOSITORY,
    CAMPUS_CLUB_REPOSITORY,
    CAMPUS_CLUB_MEMBERSHIP_REPOSITORY,
    KNOWLEDGE_RESOURCE_REPOSITORY,
    PODCAST_EPISODE_REPOSITORY,
    WEBINAR_REPOSITORY,
    WEBINAR_REGISTRATION_REPOSITORY,
    SEARCH_QUERY_REPOSITORY,
    CREDIT_SCORE_REPOSITORY,
    ESCROW_REPOSITORY,
    INVOICE_REPOSITORY,
    LEDGER_ACCOUNT_REPOSITORY,
    LEDGER_ENTRY_REPOSITORY,
    LENDER_REPOSITORY,
    LOAN_APPLICATION_REPOSITORY,
    REPAYMENT_SCHEDULE_REPOSITORY,
    SHIPMENT_REPOSITORY,
    PARTNER_CLIENT_REPOSITORY,
    API_KEY_REPOSITORY,
    WEBHOOK_SUBSCRIPTION_REPOSITORY
  ]
})
export class DatabaseModule {}
