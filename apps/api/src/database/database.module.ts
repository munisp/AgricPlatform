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
  WEBINAR_REPOSITORY,
  EXTERNAL_ACCOUNT_LINK_REPOSITORY,
  FARM_RECORD_REPOSITORY,
  IMPORT_BATCH_REPOSITORY,
  IMPORT_RECORD_REPOSITORY,
  INBOUND_EVENT_REPOSITORY,
  RECOMMENDATION_FEEDBACK_REPOSITORY,
  ANALYTICS_MART_REPOSITORY,
  WEBHOOK_DEDUPE_STORE,
  ANALYTICS_STAR_REPOSITORY
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
import {
  createPgRecommendationFeedbackRepository,
  createPgSearchQueryRepository
} from './repositories/search.pg-repository.js';
import { createInMemoryRecommendationFeedbackRepository } from './repositories/recommendation-feedback.repository.js';
import { createInMemoryAnalyticsMartRepository } from './repositories/analytics-mart.repository.js';
import { createPgAnalyticsMartRepository } from './repositories/analytics-mart.pg-repository.js';
import { createInMemoryAnalyticsStarRepository } from './repositories/analytics-star.repository.js';
import { createPgAnalyticsStarRepository } from './repositories/analytics-star.pg-repository.js';
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
// Phase-3 federated integration wave (P5a) repositories.
import {
  createInMemoryExternalAccountLinkRepository,
  createInMemoryFarmRecordRepository,
  createInMemoryImportBatchRepository,
  createInMemoryImportRecordRepository,
  createInMemoryInboundEventRepository
} from './repositories/phase3.repository.js';
import {
  createPgExternalAccountLinkRepository,
  createPgFarmRecordRepository,
  createPgImportBatchRepository,
  createPgImportRecordRepository,
  createPgInboundEventRepository,
  createPgWebhookDedupeStore
} from './repositories/phase3.pg-repository.js';
import { createInMemoryWebhookDedupeStore } from './repositories/webhook-dedupe.repository.js';
// USSD channel + lightweight-channel depth wave (P5b) repositories.
import { createInMemoryUssdSessionRepository } from './repositories/ussd-session.repository.js';
import { createPgUssdSessionRepository } from './repositories/ussd-session.pg-repository.js';
import { createInMemoryPinProfileRepository } from './repositories/pin-profile.repository.js';
import { createPgPinProfileRepository } from './repositories/pin-profile.pg-repository.js';
import {
  PIN_PROFILE_REPOSITORY,
  USSD_SESSION_REPOSITORY
} from './persistence.tokens.js';
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
// Wave P6a: IVR voice channel persistence (additive).
import { IVR_CALL_REPOSITORY } from './persistence.tokens.js';
import { createInMemoryIvrCallRepository } from './repositories/ivr-call.repository.js';
import { createPgIvrCallRepository } from './repositories/ivr-call.pg-repository.js';
// Wave L1a: ALTP livestock core persistence (additive).
import {
  ANIMAL_REPOSITORY,
  LOT_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY,
  PASTORALIST_PROFILE_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository,
  createInMemoryPastoralistProfileRepository
} from './repositories/livestock.repository.js';
import {
  createPgAnimalRepository,
  createPgLotRepository,
  createPgOwnershipTransferRepository,
  createPgPastoralistProfileRepository
} from './repositories/livestock.pg-repository.js';
// Wave L1b: ALTP livestock health/traceability persistence (additive).
import {
  DISEASE_FLAG_REPOSITORY,
  HEALTH_RECORD_REPOSITORY,
  MOVEMENT_PERMIT_REPOSITORY,
  MOVEMENT_REPOSITORY,
  RECALL_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryDiseaseFlagRepository,
  createInMemoryHealthRecordRepository,
  createInMemoryMovementPermitRepository,
  createInMemoryMovementRepository,
  createInMemoryRecallRepository
} from './repositories/livestock-health.repository.js';
import {
  createPgDiseaseFlagRepository,
  createPgHealthRecordRepository,
  createPgMovementPermitRepository,
  createPgMovementRepository,
  createPgRecallRepository
} from './repositories/livestock-health.pg-repository.js';
// Wave L1c: ALTP trade/finance/compliance persistence (additive).
import {
  AGGREGATION_POINT_REPOSITORY,
  CERTIFIED_LISTING_REPOSITORY,
  COLD_CHAIN_LOG_REPOSITORY,
  DISBURSEMENT_REPOSITORY,
  EXPORT_DOCUMENT_REPOSITORY,
  INSURANCE_CLAIM_REPOSITORY,
  INSURANCE_POLICY_REPOSITORY,
  LIEN_REPOSITORY,
  LIVESTOCK_TRANSFER_GUARD,
  OFFTAKE_CONTRACT_REPOSITORY,
  OFFTAKE_TEMPLATE_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryAggregationPointRepository,
  createInMemoryCertifiedListingRepository,
  createInMemoryColdChainLogRepository,
  createInMemoryDisbursementRepository,
  createInMemoryExportDocumentRepository,
  createInMemoryInsuranceClaimRepository,
  createInMemoryInsurancePolicyRepository,
  createInMemoryLienRepository,
  createInMemoryOfftakeContractRepository,
  createInMemoryOfftakeTemplateRepository,
  createLienTransferGuard
} from './repositories/livestock-trade.repository.js';
import {
  createPgAggregationPointRepository,
  createPgCertifiedListingRepository,
  createPgColdChainLogRepository,
  createPgDisbursementRepository,
  createPgExportDocumentRepository,
  createPgInsuranceClaimRepository,
  createPgInsurancePolicyRepository,
  createPgLienRepository,
  createPgOfftakeContractRepository,
  createPgOfftakeTemplateRepository
} from './repositories/livestock-trade.pg-repository.js';
// Wave P: platform foundation persistence (additive).
import {
  AUTH_SESSION_REPOSITORY,
  FEATURE_FLAG_REPOSITORY,
  PROCESSED_EVENT_REPOSITORY
} from './persistence.tokens.js';
import { createInMemoryAuthSessionRepository } from './repositories/auth-session.repository.js';
import { createPgAuthSessionRepository } from './repositories/auth-session.pg-repository.js';
import { createInMemoryFeatureFlagRepository } from './repositories/feature-flag.repository.js';
import { createInMemoryProcessedEventRepository } from './repositories/processed-event.repository.js';
import {
  createPgFeatureFlagRepository,
  createPgProcessedEventRepository
} from './repositories/platform.pg-repository.js';
// Wave M: marketplace commerce depth persistence (additive).
import {
  BUYER_GROUP_MEMBERSHIP_REPOSITORY,
  BUYER_GROUP_REPOSITORY,
  DRAFT_ORDER_REPOSITORY,
  LISTING_VARIANT_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  PRICE_LIST_ENTRY_REPOSITORY,
  PRICE_LIST_REPOSITORY,
  PRODUCT_REVIEW_REPOSITORY,
  PROMOTION_REDEMPTION_REPOSITORY,
  PROMOTION_REPOSITORY,
  RETURN_REQUEST_REPOSITORY,
  SELLER_RATING_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createInMemoryBuyerGroupRepository,
  createInMemoryDraftOrderRepository,
  createInMemoryListingVariantRepository,
  createInMemoryOrderExtensionRepository,
  createInMemoryPriceListEntryRepository,
  createInMemoryPriceListRepository,
  createInMemoryProductReviewRepository,
  createInMemoryPromotionRedemptionRepository,
  createInMemoryPromotionRepository,
  createInMemoryReturnRequestRepository,
  createInMemorySellerRatingRepository
} from './repositories/commerce-depth.repository.js';
import {
  createPgBuyerGroupMembershipRepository,
  createPgBuyerGroupRepository,
  createPgDraftOrderRepository,
  createPgListingVariantRepository,
  createPgOrderExtensionRepository,
  createPgPriceListEntryRepository,
  createPgPriceListRepository,
  createPgProductReviewRepository,
  createPgPromotionRedemptionRepository,
  createPgPromotionRepository,
  createPgReturnRequestRepository,
  createPgSellerRatingRepository
} from './repositories/commerce-depth.pg-repository.js';
// Wave COMP: NDPA 2023 compliance tooling persistence (additive).
import {
  COMPLIANCE_CONSENT_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
  RETENTION_POLICY_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryComplianceConsentRepository,
  createInMemoryDataSubjectRequestRepository,
  createInMemoryRetentionPolicyRepository
} from './repositories/compliance.repository.js';
import {
  createPgComplianceConsentRepository,
  createPgDataSubjectRequestRepository,
  createPgRetentionPolicyRepository
} from './repositories/compliance.pg-repository.js';

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
      // In-memory mode attaches the listing repository so placeOrder can
      // decrement stock with the same compare-and-set guard as the pg path.
      useFactory: (pool: pg.Pool | null, listings: unknown) =>
        pool
          ? createPgOrderRepository(pool)
          : createInMemoryOrderRepository(listings as Parameters<typeof createInMemoryOrderRepository>[0]),
      inject: [PG_POOL, LISTING_REPOSITORY]
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
    // Phase-3 federated integration wave (P5a) providers.
    {
      provide: EXTERNAL_ACCOUNT_LINK_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgExternalAccountLinkRepository(pool) : createInMemoryExternalAccountLinkRepository(),
      inject: [PG_POOL]
    },
    {
      provide: FARM_RECORD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgFarmRecordRepository(pool) : createInMemoryFarmRecordRepository(),
      inject: [PG_POOL]
    },
    {
      provide: IMPORT_BATCH_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgImportBatchRepository(pool) : createInMemoryImportBatchRepository(),
      inject: [PG_POOL]
    },
    {
      provide: IMPORT_RECORD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgImportRecordRepository(pool) : createInMemoryImportRecordRepository(),
      inject: [PG_POOL]
    },
    {
      provide: INBOUND_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgInboundEventRepository(pool) : createInMemoryInboundEventRepository(),
      inject: [PG_POOL]
    },
    {
      // Durable provider-webhook dedupe (funds-integrity wave): pg mode
      // persists receipts in integrations.inbound_events; in-memory mode
      // keeps the bounded replay cache for development.
      provide: WEBHOOK_DEDUPE_STORE,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgWebhookDedupeStore(pool) : createInMemoryWebhookDedupeStore(),
      inject: [PG_POOL]
    },
    // USSD channel + lightweight-channel depth wave (P5b) providers.
    {
      provide: USSD_SESSION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgUssdSessionRepository(pool) : createInMemoryUssdSessionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PIN_PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPinProfileRepository(pool) : createInMemoryPinProfileRepository(),
      inject: [PG_POOL]
    },
    // Wave P5c: recommendation feedback events.
    {
      provide: RECOMMENDATION_FEEDBACK_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgRecommendationFeedbackRepository(pool)
          : createInMemoryRecommendationFeedbackRepository(),
      inject: [PG_POOL]
    },
    // Wave P5c: lakehouse-ready analytics data marts.
    {
      provide: ANALYTICS_MART_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnalyticsMartRepository(pool) : createInMemoryAnalyticsMartRepository(),
      inject: [PG_POOL]
    },
    // Wave B: analytics star-schema marts (analytics schema, migration 019).
    {
      provide: ANALYTICS_STAR_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnalyticsStarRepository(pool) : createInMemoryAnalyticsStarRepository(),
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
    },
    // Wave P6a: IVR voice channel (appended).
    {
      provide: IVR_CALL_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgIvrCallRepository(pool) : createInMemoryIvrCallRepository(),
      inject: [PG_POOL]
    },
    // Wave L1a: ALTP livestock core (appended).
    {
      provide: OWNERSHIP_TRANSFER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOwnershipTransferRepository(pool) : createInMemoryOwnershipTransferRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ANIMAL_REPOSITORY,
      useFactory: (pool: pg.Pool | null, transfers: unknown) =>
        pool
          ? createPgAnimalRepository(pool)
          : createInMemoryAnimalRepository(
              transfers as Parameters<typeof createInMemoryAnimalRepository>[0]
            ),
      inject: [PG_POOL, OWNERSHIP_TRANSFER_REPOSITORY]
    },
    {
      provide: LOT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgLotRepository(pool) : createInMemoryLotRepository()),
      inject: [PG_POOL]
    },
    {
      provide: PASTORALIST_PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPastoralistProfileRepository(pool) : createInMemoryPastoralistProfileRepository(),
      inject: [PG_POOL]
    },
    // Wave L1b: ALTP livestock health/traceability (appended).
    {
      provide: HEALTH_RECORD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgHealthRecordRepository(pool) : createInMemoryHealthRecordRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MOVEMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMovementRepository(pool) : createInMemoryMovementRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MOVEMENT_PERMIT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMovementPermitRepository(pool) : createInMemoryMovementPermitRepository(),
      inject: [PG_POOL]
    },
    {
      provide: RECALL_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRecallRepository(pool) : createInMemoryRecallRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DISEASE_FLAG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDiseaseFlagRepository(pool) : createInMemoryDiseaseFlagRepository(),
      inject: [PG_POOL]
    },
    // Wave L1c: ALTP trade/finance/compliance (appended).
    {
      provide: CERTIFIED_LISTING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCertifiedListingRepository(pool) : createInMemoryCertifiedListingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: OFFTAKE_TEMPLATE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOfftakeTemplateRepository(pool) : createInMemoryOfftakeTemplateRepository(),
      inject: [PG_POOL]
    },
    {
      provide: OFFTAKE_CONTRACT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOfftakeContractRepository(pool) : createInMemoryOfftakeContractRepository(),
      inject: [PG_POOL]
    },
    {
      provide: EXPORT_DOCUMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgExportDocumentRepository(pool) : createInMemoryExportDocumentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LIEN_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgLienRepository(pool) : createInMemoryLienRepository()),
      inject: [PG_POOL]
    },
    {
      provide: INSURANCE_POLICY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgInsurancePolicyRepository(pool) : createInMemoryInsurancePolicyRepository(),
      inject: [PG_POOL]
    },
    {
      provide: INSURANCE_CLAIM_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgInsuranceClaimRepository(pool) : createInMemoryInsuranceClaimRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DISBURSEMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDisbursementRepository(pool) : createInMemoryDisbursementRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGGREGATION_POINT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAggregationPointRepository(pool) : createInMemoryAggregationPointRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COLD_CHAIN_LOG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgColdChainLogRepository(pool) : createInMemoryColdChainLogRepository(),
      inject: [PG_POOL]
    },
    // Lien-backed transfer guard consulted (optionally) by
    // LivestockService.transferAnimal; registered here so the livestock core
    // module resolves it without importing the trade module (no cycle).
    {
      provide: LIVESTOCK_TRANSFER_GUARD,
      useFactory: (liens: unknown) =>
        createLienTransferGuard(liens as Parameters<typeof createLienTransferGuard>[0]),
      inject: [LIEN_REPOSITORY]
    },
    // Wave P: platform foundation (appended).
    {
      provide: AUTH_SESSION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAuthSessionRepository(pool) : createInMemoryAuthSessionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: FEATURE_FLAG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgFeatureFlagRepository(pool) : createInMemoryFeatureFlagRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROCESSED_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProcessedEventRepository(pool) : createInMemoryProcessedEventRepository(),
      inject: [PG_POOL]
    },
    // Wave M: marketplace commerce depth providers (additive).
    {
      provide: LISTING_VARIANT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgListingVariantRepository(pool) : createInMemoryListingVariantRepository(),
      inject: [PG_POOL]
    },
    {
      provide: BUYER_GROUP_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgBuyerGroupRepository(pool) : createInMemoryBuyerGroupRepository(),
      inject: [PG_POOL]
    },
    {
      provide: BUYER_GROUP_MEMBERSHIP_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgBuyerGroupMembershipRepository(pool) : createInMemoryBuyerGroupMembershipRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PRICE_LIST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPriceListRepository(pool) : createInMemoryPriceListRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PRICE_LIST_ENTRY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPriceListEntryRepository(pool) : createInMemoryPriceListEntryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROMOTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPromotionRepository(pool) : createInMemoryPromotionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROMOTION_REDEMPTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgPromotionRedemptionRepository(pool) : createInMemoryPromotionRedemptionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ORDER_EXTENSION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOrderExtensionRepository(pool) : createInMemoryOrderExtensionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: RETURN_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgReturnRequestRepository(pool) : createInMemoryReturnRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DRAFT_ORDER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDraftOrderRepository(pool) : createInMemoryDraftOrderRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PRODUCT_REVIEW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProductReviewRepository(pool) : createInMemoryProductReviewRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SELLER_RATING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgSellerRatingRepository(pool) : createInMemorySellerRatingRepository(),
      inject: [PG_POOL]
    },
    // Wave COMP: NDPA 2023 compliance tooling providers (additive).
    {
      provide: COMPLIANCE_CONSENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgComplianceConsentRepository(pool) : createInMemoryComplianceConsentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DATA_SUBJECT_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDataSubjectRequestRepository(pool) : createInMemoryDataSubjectRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: RETENTION_POLICY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRetentionPolicyRepository(pool) : createInMemoryRetentionPolicyRepository(),
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
    EXTERNAL_ACCOUNT_LINK_REPOSITORY,
    FARM_RECORD_REPOSITORY,
    IMPORT_BATCH_REPOSITORY,
    IMPORT_RECORD_REPOSITORY,
    INBOUND_EVENT_REPOSITORY,
    WEBHOOK_DEDUPE_STORE,
    USSD_SESSION_REPOSITORY,
    PIN_PROFILE_REPOSITORY,
    RECOMMENDATION_FEEDBACK_REPOSITORY,
    ANALYTICS_MART_REPOSITORY,
    PARTNER_CLIENT_REPOSITORY,
    API_KEY_REPOSITORY,
    WEBHOOK_SUBSCRIPTION_REPOSITORY,
    IVR_CALL_REPOSITORY,
    ANIMAL_REPOSITORY,
    LOT_REPOSITORY,
    OWNERSHIP_TRANSFER_REPOSITORY,
    PASTORALIST_PROFILE_REPOSITORY,
    HEALTH_RECORD_REPOSITORY,
    MOVEMENT_REPOSITORY,
    MOVEMENT_PERMIT_REPOSITORY,
    RECALL_REPOSITORY,
    DISEASE_FLAG_REPOSITORY,
    CERTIFIED_LISTING_REPOSITORY,
    OFFTAKE_TEMPLATE_REPOSITORY,
    OFFTAKE_CONTRACT_REPOSITORY,
    EXPORT_DOCUMENT_REPOSITORY,
    LIEN_REPOSITORY,
    INSURANCE_POLICY_REPOSITORY,
    INSURANCE_CLAIM_REPOSITORY,
    DISBURSEMENT_REPOSITORY,
    AGGREGATION_POINT_REPOSITORY,
    COLD_CHAIN_LOG_REPOSITORY,
    LIVESTOCK_TRANSFER_GUARD,
    LISTING_VARIANT_REPOSITORY,
    BUYER_GROUP_REPOSITORY,
    BUYER_GROUP_MEMBERSHIP_REPOSITORY,
    PRICE_LIST_REPOSITORY,
    PRICE_LIST_ENTRY_REPOSITORY,
    PROMOTION_REPOSITORY,
    PROMOTION_REDEMPTION_REPOSITORY,
    ORDER_EXTENSION_REPOSITORY,
    RETURN_REQUEST_REPOSITORY,
    DRAFT_ORDER_REPOSITORY,
    PRODUCT_REVIEW_REPOSITORY,
    SELLER_RATING_REPOSITORY,
    AUTH_SESSION_REPOSITORY,
    FEATURE_FLAG_REPOSITORY,
    PROCESSED_EVENT_REPOSITORY,
    ANALYTICS_STAR_REPOSITORY,
    COMPLIANCE_CONSENT_REPOSITORY,
    DATA_SUBJECT_REQUEST_REPOSITORY,
    RETENTION_POLICY_REPOSITORY
  ]
})
export class DatabaseModule {}
