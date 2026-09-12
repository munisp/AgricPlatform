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
  BRIDGE_SYNC_STATE_REPOSITORY,
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
  createInMemoryEquipmentBookingRepository,
  createInMemoryEquipmentListingRepository
} from './repositories/mechanization.repository.js';
import {
  createPgEquipmentBookingRepository,
  createPgEquipmentListingRepository
} from './repositories/mechanization.pg-repository.js';
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
// WP-G20: bridge sync-state (Moodle/Discourse/Directus scheduled sync).
import { createInMemoryBridgeSyncStateRepository } from './repositories/bridge-sync-state.repository.js';
import { createPgBridgeSyncStateRepository } from './repositories/bridge-sync-state.pg-repository.js';
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
  PARTNER_MEMBER_REPOSITORY,
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
// Stage 24: partner tenant binding persistence (additive).
import {
  createInMemoryPartnerMemberRepository,
  createPgPartnerMemberRepository
} from './repositories/partner-member.repository.js';
// Wave P6a: IVR voice channel persistence (additive).
import { IVR_CALL_REPOSITORY } from './persistence.tokens.js';
import { createInMemoryIvrCallRepository } from './repositories/ivr-call.repository.js';
import { createPgIvrCallRepository } from './repositories/ivr-call.pg-repository.js';
// Wave VOICE: voice agronomist persistence (additive).
import {
  AGENT_CASE_REPOSITORY,
  VOICE_SESSION_REPOSITORY,
  VOICE_TURN_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryAgentCaseRepository,
  createInMemoryVoiceSessionRepository,
  createInMemoryVoiceTurnRepository
} from './repositories/voice.repository.js';
import {
  createPgAgentCaseRepository,
  createPgVoiceSessionRepository,
  createPgVoiceTurnRepository
} from './repositories/voice.pg-repository.js';
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
// Wave SYNCSRV: record-level offline sync protocol v1 persistence (additive).
import {
  ENTITY_VERSION_REPOSITORY,
  SYNC_CURSOR_REPOSITORY,
  SYNC_MUTATION_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryEntityVersionRepository,
  createInMemorySyncCursorRepository,
  createInMemorySyncMutationRepository
} from './repositories/sync.repository.js';
import {
  createPgEntityVersionRepository,
  createPgSyncCursorRepository,
  createPgSyncMutationRepository
} from './repositories/sync.pg-repository.js';
// Wave FARMS: farms & crop-production persistence (additive).
import {
  CROP_PLANTING_REPOSITORY,
  FARM_EXPENSE_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  HARVEST_RECORD_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryCropPlantingRepository,
  createInMemoryFarmExpenseRepository,
  createInMemoryFarmPlotRepository,
  createInMemoryHarvestRecordRepository
} from './repositories/farms.repository.js';
import {
  createPgCropPlantingRepository,
  createPgFarmExpenseRepository,
  createPgFarmPlotRepository,
  createPgHarvestRecordRepository
} from './repositories/farms.pg-repository.js';
// Wave AGENTS: field-agent (enumerator) persistence (additive).
import {
  AGENT_ACTIVITY_LOG_REPOSITORY,
  AGENT_ASSIGNMENT_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryAgentActivityLogRepository,
  createInMemoryAgentAssignmentRepository
} from './repositories/field-agents.repository.js';
import {
  createPgAgentActivityLogRepository,
  createPgAgentAssignmentRepository
} from './repositories/field-agents.pg-repository.js';
// Wave GEO: geospatial pack persistence (additive).
import {
  GEO_BOUNDARY_REPOSITORY,
  H3_INDEX_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryGeoBoundaryRepository,
  createInMemoryH3IndexRepository
} from './repositories/geo.repository.js';
import {
  createPgGeoBoundaryRepository,
  createPgH3IndexRepository
} from './repositories/geo.pg-repository.js';
// Wave CREDIT: microfinance suite persistence (additive).
import {
  CREDIT_COLLATERAL_REPOSITORY,
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY,
  CREDIT_GUARANTOR_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_PRODUCT_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  CREDIT_SAVINGS_TRANSACTION_REPOSITORY,
  GEO_CREDIT_SHADOW_REPOSITORY,
  SEASONAL_SCHEDULE_REPOSITORY,
  EQUIPMENT_LISTING_REPOSITORY,
  EQUIPMENT_BOOKING_REPOSITORY,
  PARAMETRIC_PRODUCT_REPOSITORY,
  PARAMETRIC_POLICY_REPOSITORY,
  PARAMETRIC_TRIGGER_EVENT_REPOSITORY,
  PARAMETRIC_PAYOUT_REPOSITORY,
  // Stage 27 (Insurance-in-the-Bag, additive).
  VOUCHER_PROGRAMME_RIDER_REPOSITORY,
  VOUCHER_COVER_REPOSITORY,
  // Wave VSLACARBON (additive).
  VSLA_GROUP_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_CYCLE_REPOSITORY,
  VSLA_CONTRIBUTION_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY,
  VSLA_SHARE_OUT_PLAN_REPOSITORY,
  VSLA_LOAN_REPOSITORY,
  VSLA_LOAN_REPAYMENT_REPOSITORY,
  CARBON_PLOT_REPOSITORY,
  CARBON_EVIDENCE_REPOSITORY,
  CARBON_ESTIMATE_REPOSITORY,
  // Wave LIVESTOCK-PASSPORT (additive): digital livestock passport.
  LIVESTOCK_PASSPORT_REPOSITORY,
  LIVESTOCK_PASSPORT_EVENT_REPOSITORY,
  LIVESTOCK_PASSPORT_TRANSFER_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryCreditCollateralRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGroupRepository,
  createInMemoryCreditGuarantorRepository,
  createInMemoryCreditLoanRepository,
  createInMemoryCreditProductRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository
} from './repositories/credit-suite.repository.js';
import {
  createPgCreditCollateralRepository,
  createPgCreditGroupMemberRepository,
  createPgCreditGroupRepository,
  createPgCreditGuarantorRepository,
  createPgCreditLoanRepository,
  createPgCreditProductRepository,
  createPgCreditRepaymentRepository,
  createPgCreditSavingsAccountRepository,
  createPgCreditSavingsTransactionRepository
} from './repositories/credit-suite.pg-repository.js';
// Wave EUDR: traceability passport persistence (additive).
import {
  COMMODITY_LOT_REPOSITORY,
  CUSTODY_EVENT_REPOSITORY,
  LOT_PLOT_LINK_REPOSITORY,
  TRACEABILITY_SHIPMENT_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryCommodityLotRepository,
  createInMemoryCustodyEventRepository,
  createInMemoryLotPlotLinkRepository,
  createInMemoryTraceabilityShipmentRepository
} from './repositories/traceability.repository.js';
import {
  createPgCommodityLotRepository,
  createPgCustodyEventRepository,
  createPgLotPlotLinkRepository,
  createPgTraceabilityShipmentRepository
} from './repositories/traceability.pg-repository.js';
import { createInMemoryGeoCreditShadowRepository } from './repositories/geo-credit-shadow.repository.js';
import { createPgGeoCreditShadowRepository } from './repositories/geo-credit-shadow.pg-repository.js';
// SeasonSync (innovation wave 27): pinned seasonal repayment schedules.
import { createInMemorySeasonalScheduleRepository } from './repositories/seasonal-schedule.repository.js';
import { createPgSeasonalScheduleRepository } from './repositories/seasonal-schedule.pg-repository.js';
// Wave AGENTBANK: agent banking persistence (additive).
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  AGENT_FLOAT_TOPUP_REPOSITORY,
  AGENT_TRANSACTION_REPOSITORY,
  AGENT_VOUCHER_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createInMemoryAgentFloatTopUpRepository,
  createInMemoryAgentTransactionRepository,
  createInMemoryAgentVoucherRepository
} from './repositories/agent-banking.repository.js';
import {
  createPgAgentBankingAgentRepository,
  createPgAgentFloatTopUpRepository,
  createPgAgentTransactionRepository,
  createPgAgentVoucherRepository
} from './repositories/agent-banking.pg-repository.js';
// Wave-INSURANCE (additive): parametric insurance rail repositories.
import {
  createInMemoryParametricProductRepository,
  createInMemoryParametricPolicyRepository,
  createInMemoryParametricTriggerEventRepository,
  createInMemoryParametricPayoutRepository,
  createInMemoryVoucherProgrammeRiderRepository,
  createInMemoryVoucherCoverRepository
} from './repositories/insurance.repository.js';
import {
  createPgParametricProductRepository,
  createPgParametricPolicyRepository,
  createPgParametricTriggerEventRepository,
  createPgParametricPayoutRepository,
  createPgVoucherProgrammeRiderRepository,
  createPgVoucherCoverRepository
} from './repositories/insurance.pg-repository.js';
// Wave VSLACARBON (additive): VSLA groups + carbon MRV repositories.
import {
  createInMemoryVslaGroupRepository,
  createInMemoryVslaMemberRepository,
  createInMemoryVslaCycleRepository,
  createInMemoryVslaContributionRepository,
  createInMemoryVslaShareOutRepository,
  createInMemoryVslaShareOutPlanRepository,
  createInMemoryVslaLoanRepository,
  createInMemoryVslaLoanRepaymentRepository,
  createInMemoryCarbonPlotRepository,
  createInMemoryCarbonEvidenceRepository,
  createInMemoryCarbonEstimateRepository
} from './repositories/vsla-carbon.repository.js';
import {
  createPgVslaGroupRepository,
  createPgVslaMemberRepository,
  createPgVslaCycleRepository,
  createPgVslaContributionRepository,
  createPgVslaShareOutRepository,
  createPgVslaShareOutPlanRepository,
  createPgVslaLoanRepository,
  createPgVslaLoanRepaymentRepository,
  createPgCarbonPlotRepository,
  createPgCarbonEvidenceRepository,
  createPgCarbonEstimateRepository
} from './repositories/vsla-carbon.pg-repository.js';
// Wave LIVESTOCK-PASSPORT (additive): digital livestock passport repositories.
import {
  createInMemoryLivestockPassportRepository,
  createInMemoryPassportEventRepository,
  createInMemoryPassportTransferRepository
} from './repositories/livestock-passport.repository.js';
import {
  createPgLivestockPassportRepository,
  createPgPassportEventRepository,
  createPgPassportTransferRepository
} from './repositories/livestock-passport.pg-repository.js';
// Wave NINVOUCHER (additive): input subsidy e-voucher persistence.
import {
  BENEFICIARY_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  INPUT_VOUCHER_REDEMPTION_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryBeneficiaryRepository,
  createInMemoryInputVoucherRepository,
  createInMemoryRedemptionRepository,
  createInMemorySubsidyProgrammeRepository
} from './repositories/input-vouchers.repository.js';
import {
  createPgBeneficiaryRepository,
  createPgInputVoucherRepository,
  createPgRedemptionRepository,
  createPgSubsidyProgrammeRepository
} from './repositories/input-vouchers.pg-repository.js';
// Wave WAREHOUSE (additive): electronic warehouse receipts persistence.
import {
  CERTIFIED_WAREHOUSE_REPOSITORY,
  WAREHOUSE_DEPOSIT_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY,
  WAREHOUSE_PLEDGE_REPOSITORY,
  WAREHOUSE_TRANSFER_REPOSITORY,
  // Stage 27 (innovation 4): Planting-Window Pulse persistence (additive).
  ADVISORY_PULSE_REPOSITORY
} from './persistence.tokens.js';
import { createInMemoryAdvisoryPulseRepository } from './repositories/advisory-pulse.repository.js';
import { createPgAdvisoryPulseRepository } from './repositories/advisory-pulse.pg-repository.js';
import {
  createInMemoryCertifiedWarehouseRepository,
  createInMemoryWarehouseDepositRepository,
  createInMemoryWarehouseReceiptRepository,
  createInMemoryWarehousePledgeRepository,
  createInMemoryWarehouseTransferRepository
} from './repositories/warehouse.repository.js';
import {
  createPgCertifiedWarehouseRepository,
  createPgWarehouseDepositRepository,
  createPgWarehouseReceiptRepository,
  createPgWarehousePledgeRepository,
  createPgWarehouseTransferRepository
} from './repositories/warehouse.pg-repository.js';
// Innovation 10 (Stage 27): Chapter Map persistence (additive).
import {
  CHAPTER_MAP_SNAPSHOT_REPOSITORY,
  CHAPTER_MEMBER_DIRECTORY
} from './persistence.tokens.js';
import {
  createInMemoryChapterMapSnapshotRepository,
  createInMemoryChapterMemberDirectory
} from './repositories/chapter-map.repository.js';
import {
  createPgChapterMapSnapshotRepository,
  createPgChapterMemberDirectory
} from './repositories/chapter-map.pg-repository.js';

// Stage 27 innovation "Float Sentinel" (additive): fraud/liquidity anomaly
// engine persistence (fraud schema, migration 059).
import { FRAUD_SENTINEL_REPOSITORY } from './persistence.tokens.js';
import { createInMemoryFraudSentinelRepository } from './repositories/fraud.repository.js';
import { createPgFraudSentinelRepository } from './repositories/fraud.pg-repository.js';
// Stage 27 INNOVATION 7 Credit Passport (additive): verifiable farmer credential persistence.
import {
  CREDIT_PASSPORT_DISCLOSURE_REPOSITORY,
  CREDIT_PASSPORT_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryCreditPassportCredentialRepository,
  createInMemoryCreditPassportDisclosureRepository
} from './repositories/credit-passport.repository.js';
import {
  createPgCreditPassportCredentialRepository,
  createPgCreditPassportDisclosureRepository
} from './repositories/credit-passport.pg-repository.js';
// Stage 27 / Innovation 8: Receipt LTV Guardian persistence (additive).
import {
  COLLATERAL_POSITION_REPOSITORY,
  LTV_OBSERVATION_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryCollateralPositionRepository,
  createInMemoryLtvObservationRepository
} from './repositories/warehouse-ltv.repository.js';
import {
  createPgCollateralPositionRepository,
  createPgLtvObservationRepository
} from './repositories/warehouse-ltv.pg-repository.js';

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
    // Stage 27 (innovation 4): Planting-Window Pulse repositories.
    {
      provide: ADVISORY_PULSE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAdvisoryPulseRepository(pool) : createInMemoryAdvisoryPulseRepository(),
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