import { Global, Module } from '@nestjs/common';
import { createClient } from 'redis';
import pg from 'pg';
import { loadApiEnv } from '@agric-platform/shared';
import { RedisModule } from '../redis/redis.module.js';
import { KEY_VALUE_STORE, REDIS_CLIENT } from '../redis/redis.tokens.js';
import {
  ADVISORY_PULSE_REPOSITORY,
  ADVISORY_REPOSITORY,
  AGENT_ACTIVITY_LOG_REPOSITORY,
  AGENT_ASSIGNMENT_REPOSITORY,
  AGENT_BANKING_AGENT_REPOSITORY,
  AGENT_FLOAT_TOPUP_REPOSITORY,
  AGENT_TRANSACTION_REPOSITORY,
  AGENT_VOUCHER_REPOSITORY,
  AGGREGATION_POINT_REPOSITORY,
  ANALYTICS_MART_REPOSITORY,
  ANALYTICS_STAR_REPOSITORY,
  ANIMAL_REPOSITORY,
  ANNOUNCEMENT_REPOSITORY,
  API_KEY_REPOSITORY,
  APPLICATION_REPOSITORY,
  AUDIT_ANCHOR_REPOSITORY,
  AUDIT_REPOSITORY,
  AUTH_SESSION_REPOSITORY,
  BENEFICIARY_REPOSITORY,
  BUYER_GROUP_MEMBERSHIP_REPOSITORY,
  BUYER_GROUP_REPOSITORY,
  CAMPUS_CLUB_MEMBERSHIP_REPOSITORY,
  CAMPUS_CLUB_REPOSITORY,
  CARBON_ESTIMATE_REPOSITORY,
  CARBON_EVIDENCE_REPOSITORY,
  CARBON_PLOT_REPOSITORY,
  CERTIFICATE_REPOSITORY,
  CERTIFIED_LISTING_REPOSITORY,
  CERTIFIED_WAREHOUSE_REPOSITORY,
  CHAPTER_EVENT_REPOSITORY,
  CHAPTER_REPOSITORY,
  COHORT_THREAD_POST_REPOSITORY,
  COHORT_THREAD_REPOSITORY,
  COLD_CHAIN_LOG_REPOSITORY,
  COMMODITY_LOT_REPOSITORY,
  COMMODITY_PRICE_REPOSITORY,
  COMPLIANCE_CONSENT_REPOSITORY,
  CONSENT_REPOSITORY,
  COOP_POOL_REPOSITORY,
  COURSE_REPOSITORY,
  CREDIT_COLLATERAL_REPOSITORY,
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY,
  CREDIT_GUARANTOR_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_PRODUCT_REPOSITORY,
  CREDIT_PROFILE_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  CREDIT_SAVINGS_TRANSACTION_REPOSITORY,
  CREDIT_SCORE_REPOSITORY,
  CROP_PLANTING_REPOSITORY,
  CUSTODY_EVENT_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
  DELETION_REQUEST_REPOSITORY,
  DELIVERY_LOG_REPOSITORY,
  DISBURSEMENT_REPOSITORY,
  DOCUMENT_REPOSITORY,
  DRAFT_ORDER_REPOSITORY,
  ENTITY_VERSION_REPOSITORY,
  ENROLMENT_REPOSITORY,
  EQUIPMENT_BOOKING_REPOSITORY,
  EQUIPMENT_LISTING_REPOSITORY,
  ESCROW_PAYOUT_REPOSITORY,
  ESCROW_REPOSITORY,
  EVENT_RSVP_REPOSITORY,
  EXPORT_DOCUMENT_REPOSITORY,
  EXTERNAL_ACCOUNT_LINK_REPOSITORY,
  FARM_EXPENSE_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  FARM_RECORD_REPOSITORY,
  FEATURE_FLAG_REPOSITORY,
  FORUM_TOPIC_REPOSITORY,
  FRAUD_SENTINEL_REPOSITORY,
  GEO_BOUNDARY_REPOSITORY,
  GEO_CREDIT_SHADOW_REPOSITORY,
  H3_INDEX_REPOSITORY,
  HARVEST_RECORD_REPOSITORY,
  HEALTH_RECORD_REPOSITORY,
  IDEMPOTENCY_STORE,
  IMPORT_BATCH_REPOSITORY,
  IMPORT_RECORD_REPOSITORY,
  INBOUND_EVENT_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_FUNDING_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  INPUT_VOUCHER_REDEMPTION_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY,
  INSURANCE_CLAIM_REPOSITORY,
  INSURANCE_POLICY_REPOSITORY,
  INVOICE_REPOSITORY,
  IVR_CALL_REPOSITORY,
  JUDGE_ASSIGNMENT_REPOSITORY,
  JUDGE_SCORE_REPOSITORY,
  KNOWLEDGE_RESOURCE_REPOSITORY,
  LEDGER_ACCOUNT_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  LENDER_REPOSITORY,
  LIEN_REPOSITORY,
  LISTING_REPOSITORY,
  LISTING_VARIANT_REPOSITORY,
  LIVESTOCK_PASSPORT_EVENT_REPOSITORY,
  LIVESTOCK_PASSPORT_REPOSITORY,
  LIVESTOCK_PASSPORT_TRANSFER_REPOSITORY,
  LIVESTOCK_TRANSFER_GUARD,
  LOAN_APPLICATION_REPOSITORY,
  LOT_REPOSITORY,
  MENTOR_REQUEST_REPOSITORY,
  MILESTONE_PROGRESS_REPOSITORY,
  MOVEMENT_PERMIT_REPOSITORY,
  MOVEMENT_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OFFTAKE_CONTRACT_REPOSITORY,
  OFFTAKE_TEMPLATE_REPOSITORY,
  OPPORTUNITY_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  OUTBOX_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY,
  PARAMETRIC_PAYOUT_REPOSITORY,
  PARAMETRIC_POLICY_REPOSITORY,
  PARAMETRIC_PRODUCT_REPOSITORY,
  PARAMETRIC_TRIGGER_EVENT_REPOSITORY,
  PARTNER_CLIENT_REPOSITORY,
  PARTNER_MEMBER_REPOSITORY,
  PASTORALIST_PROFILE_REPOSITORY,
  PATHWAY_ENROLMENT_REPOSITORY,
  PATHWAY_STAGE_REPOSITORY,
  PATHWAY_TEMPLATE_REPOSITORY,
  PG_POOL,
  PIN_PROFILE_REPOSITORY,
  PODCAST_EPISODE_REPOSITORY,
  PRICE_LIST_ENTRY_REPOSITORY,
  PRICE_LIST_REPOSITORY,
  PROCESSED_EVENT_REPOSITORY,
  PRODUCT_REVIEW_REPOSITORY,
  PROFILE_REPOSITORY,
  PROGRAMME_COHORT_REPOSITORY,
  PROGRAMME_ENROLMENT_REPOSITORY,
  PROGRAMME_MILESTONE_REPOSITORY,
  PROMOTION_REDEMPTION_REPOSITORY,
  PROMOTION_REPOSITORY,
  RECALL_REPOSITORY,
  RECOMMENDATION_FEEDBACK_REPOSITORY,
  REPAYMENT_SCHEDULE_REPOSITORY,
  RETENTION_POLICY_REPOSITORY,
  RETURN_REQUEST_REPOSITORY,
  REVIEW_REPOSITORY,
  RUBRIC_CRITERION_REPOSITORY,
  SEARCH_QUERY_REPOSITORY,
  SEASONAL_SCHEDULE_REPOSITORY,
  SELLER_RATING_REPOSITORY,
  SERVICE_BOOKING_REPOSITORY,
  SERVICE_OFFERING_REPOSITORY,
  SERVICE_REVIEW_REPOSITORY,
  SHIPMENT_REPOSITORY,
  STAGE_PROGRESS_REPOSITORY,
  SUPPLIER_REPOSITORY,
  SYNC_CURSOR_REPOSITORY,
  SYNC_MUTATION_REPOSITORY,
  TOPIC_FLAG_REPOSITORY,
  TRACEABILITY_SHIPMENT_REPOSITORY,
  USER_REPOSITORY,
  USSD_SESSION_REPOSITORY,
  VOICE_SESSION_REPOSITORY,
  VOICE_TURN_REPOSITORY,
  AGENT_CASE_REPOSITORY,
  VOUCHER_COVER_REPOSITORY,
  VOUCHER_PROGRAMME_RIDER_REPOSITORY,
  VSLA_CONTRIBUTION_REPOSITORY,
  VSLA_CYCLE_REPOSITORY,
  VSLA_GROUP_REPOSITORY,
  VSLA_LOAN_REPAYMENT_REPOSITORY,
  VSLA_LOAN_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_SHARE_OUT_PLAN_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY,
  WAREHOUSE_DEPOSIT_REPOSITORY,
  WAREHOUSE_PLEDGE_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY,
  WAREHOUSE_TRANSFER_REPOSITORY,
  WEBHOOK_DEDUPE_STORE,
  WEBHOOK_SUBSCRIPTION_REPOSITORY,
  WEBINAR_REGISTRATION_REPOSITORY,
  WEBINAR_REPOSITORY
} from './persistence.tokens.js';
import {
  createInMemoryAuditRepository,
  createPgAuditRepository
} from './repositories/audit.repository.js';
import { createPgAuditAnchorRepository } from './repositories/audit-anchor.pg-repository.js';
import { createInMemoryOutboxRepository } from './repositories/outbox.repository.js';
import { createPgOutboxRepository } from './repositories/outbox.pg-repository.js';
import {
  createInMemoryUserRepository,
  createPgUserRepository
} from './repositories/user.repository.js';
import { createPgProfileRepository } from './repositories/profile.pg-repository.js';
import {
  createInMemoryProfileRepository,
  type InMemoryProfileRepository
} from './repositories/profile.repository.js';
import { createInMemoryConsentRepository } from './repositories/consent.repository.js';
import { createPgConsentRepository } from './repositories/consent.pg-repository.js';
import { createInMemoryDeletionRequestRepository } from './repositories/deletion-request.repository.js';
import { createPgDeletionRequestRepository } from './repositories/deletion-request.pg-repository.js';
import { createInMemoryCourseRepository } from './repositories/course.repository.js';
import {
  createPgCertificateRepository,
  createPgCourseRepository,
  createPgEnrolmentRepository
} from './repositories/learning.pg-repository.js';
import {
  createInMemoryChapterEventRepository,
  createInMemoryChapterRepository,
  createInMemoryForumTopicRepository,
  createInMemoryMentorRequestRepository,
  createInMemoryTopicFlagRepository
} from './repositories/community.repository.js';
import {
  createPgChapterEventRepository,
  createPgChapterRepository,
  createPgEventRsvpRepository,
  createPgForumTopicRepository,
  createPgMentorRequestRepository,
  createPgTopicFlagRepository
} from './repositories/community.pg-repository.js';
import { createInMemoryEventRsvpRepository } from './repositories/event-rsvp.repository.js';
import { createInMemoryAnnouncementRepository } from './repositories/announcement.repository.js';
import { createPgAnnouncementRepository } from './repositories/announcement.pg-repository.js';
import { createInMemoryAdvisoryRepository } from './repositories/advisory.repository.js';
import { createPgAdvisoryRepository } from './repositories/advisory.pg-repository.js';
import {
  createInMemoryListingRepository,
  createInMemoryOrderRepository,
  createInMemoryReviewRepository
} from './repositories/marketplace.repository.js';
import {
  createPgListingRepository,
  createPgMarketplaceListingRepository,
  createPgMarketplaceOrderRepository,
  createPgMarketplaceReviewRepository
} from './repositories/marketplace.pg-repository.js';
import { createInMemoryCreditProfileRepository } from './repositories/credit-profile.repository.js';
import { createPgCreditProfileRepository } from './repositories/credit-profile.pg-repository.js';
import { createInMemoryDocumentRepository } from './repositories/document.repository.js';
import { createPgDocumentRepository } from './repositories/document.pg-repository.js';
import {
  createInMemoryDeliveryLogRepository,
  createInMemoryNotificationPreferenceRepository,
  createInMemoryNotificationRepository
} from './repositories/notification.repository.js';
import {
  createPgDeliveryLogRepository,
  createPgNotificationPreferenceRepository,
  createPgNotificationRepository
} from './repositories/notification.pg-repository.js';
import {
  createInMemoryCommodityPriceRepository,
  createPgCommodityPriceRepository
} from './repositories/commodity-price.repository.js';
import {
  createInMemoryProgrammeCohortRepository,
  createInMemoryProgrammeEnrolmentRepository,
  createInMemoryProgrammeMilestoneRepository,
  createInMemoryRubricCriterionRepository,
  createInMemoryServiceBookingRepository,
  createInMemoryServiceOfferingRepository,
  createInMemoryServiceReviewRepository,
  createInMemorySupplierRepository
} from './repositories/engagement.repository.js';
import {
  createPgProgrammeCohortRepository,
  createPgProgrammeEnrolmentRepository,
  createPgProgrammeMilestoneRepository,
  createPgRubricCriterionRepository,
  createPgServiceBookingRepository,
  createPgServiceOfferingRepository,
  createPgServiceReviewRepository,
  createPgSupplierRepository
} from './repositories/engagement.pg-repository.js';
import {
  createInMemoryJudgeAssignmentRepository,
  createInMemoryJudgeScoreRepository,
  createInMemoryMilestoneProgressRepository
} from './repositories/programmes.repository.js';
import {
  createPgCohortThreadPostRepository,
  createPgCohortThreadRepository,
  createPgJudgeAssignmentRepository,
  createPgJudgeScoreRepository,
  createPgMilestoneProgressRepository
} from './repositories/programmes.pg-repository.js';
import {
  createInMemoryCohortThreadPostRepository,
  createInMemoryCohortThreadRepository
} from './repositories/cohort-thread.repository.js';
import {
  createInMemoryPathwayEnrolmentRepository,
  createInMemoryPathwayStageRepository,
  createInMemoryPathwayTemplateRepository,
  createInMemoryStageProgressRepository
} from './repositories/pathways.repository.js';
import {
  createPgPathwayEnrolmentRepository,
  createPgPathwayStageRepository,
  createPgPathwayTemplateRepository,
  createPgStageProgressRepository
} from './repositories/pathways.pg-repository.js';
import {
  createInMemoryCampusClubMembershipRepository,
  createInMemoryCampusClubRepository,
  createInMemoryKnowledgeResourceRepository,
  createInMemoryPodcastEpisodeRepository,
  createInMemorySearchQueryRepository
} from './repositories/knowledge.repository.js';
import {
  createPgCampusClubMembershipRepository,
  createPgCampusClubRepository,
  createPgKnowledgeResourceRepository,
  createPgPodcastEpisodeRepository,
  createPgSearchQueryRepository
} from './repositories/knowledge.pg-repository.js';
import { createInMemoryAnalyticsMartRepository } from './repositories/analytics-mart.repository.js';
import { createPgAnalyticsMartRepository } from './repositories/analytics-mart.pg-repository.js';
import { createInMemoryRecommendationFeedbackRepository } from './repositories/recommendation-feedback.repository.js';
import { createPgRecommendationFeedbackRepository } from './repositories/recommendation-feedback.pg-repository.js';
import { createInMemoryEscrowRepository } from './repositories/escrow.repository.js';
import {
  createInMemoryCoopPoolRepository,
  createPgCoopPoolRepository
} from './repositories/coop-pool.repository.js';
import { createInMemoryEscrowPayoutRepository } from './repositories/escrow-payout.repository.js';
import { createPgEscrowPayoutRepository } from './repositories/escrow-payout.pg-repository.js';
import { createInMemoryInvoiceRepository } from './repositories/invoice.repository.js';
import { createInMemoryShipmentRepository } from './repositories/shipment.repository.js';
import {
  createPgEscrowRepository,
  createPgInvoiceRepository,
  createPgShipmentRepository
} from './repositories/commerce.pg-repository.js';
import {
  createInMemoryCreditScoreRepository,
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository,
  createInMemoryLenderRepository,
  createInMemoryLoanApplicationRepository,
  createInMemoryRepaymentScheduleRepository
} from './repositories/ledger.repository.js';
import {
  createPgCreditScoreRepository,
  createPgLedgerAccountRepository,
  createPgLedgerEntryRepository
} from './repositories/ledger.pg-repository.js';
import {
  createPgLenderRepository,
  createPgLoanApplicationRepository,
  createPgRepaymentScheduleRepository
} from './repositories/finance.pg-repository.js';
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
  createPgInboundEventRepository
} from './repositories/phase3.pg-repository.js';
import {
  createInMemoryPinProfileRepository,
  createInMemoryUssdSessionRepository
} from './repositories/ussd.repository.js';
import {
  createPgPinProfileRepository,
  createPgUssdSessionRepository
} from './repositories/ussd.pg-repository.js';
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
import {
  createInMemoryPartnerMemberRepository,
  createPgPartnerMemberRepository
} from './repositories/partner-member.repository.js';
import { createInMemoryIvrCallRepository } from './repositories/ivr.repository.js';
import { createPgIvrCallRepository } from './repositories/ivr.pg-repository.js';
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
import {
  createInMemoryHealthRecordRepository,
  createInMemoryMovementPermitRepository,
  createInMemoryMovementRepository
} from './repositories/livestock-health.repository.js';
import {
  createInMemoryDiseaseFlagRepository,
  createInMemoryRecallRepository
} from './repositories/livestock-recall.repository.js';
import {
  createPgDiseaseFlagRepository,
  createPgHealthRecordRepository,
  createPgMovementPermitRepository,
  createPgMovementRepository,
  createPgRecallRepository
} from './repositories/livestock-health.pg-repository.js';
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
  createInMemoryOfftakeTemplateRepository
} from './repositories/livestock-trade.repository.js';
import { createInMemoryInsuranceProvider } from '../modules/livestock-trade/providers/insurance.provider.js';
import { createInMemoryColdChainProvider } from '../modules/livestock-trade/providers/cold-chain.provider.js';
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
import {
  createInMemoryAuthSessionRepository,
  createInMemoryFeatureFlagRepository,
  createInMemoryProcessedEventRepository
} from './repositories/platform.repository.js';
import {
  createPgAuthSessionRepository,
  createPgFeatureFlagRepository,
  createPgProcessedEventRepository
} from './repositories/platform.pg-repository.js';
import { createInMemoryAnalyticsStarRepository } from './repositories/analytics-star.repository.js';
import { createPgAnalyticsStarRepository } from './repositories/analytics-star.pg-repository.js';
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
import {
  createInMemoryAgentActivityLogRepository,
  createInMemoryAgentAssignmentRepository
} from './repositories/agents.repository.js';
import {
  createPgAgentActivityLogRepository,
  createPgAgentAssignmentRepository
} from './repositories/agents.pg-repository.js';
import {
  createInMemoryGeoBoundaryRepository,
  createInMemoryH3IndexRepository
} from './repositories/geo.repository.js';
import {
  createPgGeoBoundaryRepository,
  createPgH3IndexRepository
} from './repositories/geo.pg-repository.js';
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
} from './repositories/credit.repository.js';
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
} from './repositories/credit.pg-repository.js';
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
import { createInMemorySeasonalScheduleRepository } from './repositories/seasonal-schedule.repository.js';
import { createPgSeasonalScheduleRepository } from './repositories/seasonal-schedule.pg-repository.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createInMemoryAgentFloatTopupRepository,
  createInMemoryAgentTransactionRepository,
  createInMemoryAgentVoucherRepository
} from './repositories/agent-banking.repository.js';
import {
  createPgAgentBankingAgentRepository,
  createPgAgentFloatTopupRepository,
  createPgAgentTransactionRepository,
  createPgAgentVoucherRepository
} from './repositories/agent-banking.pg-repository.js';
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
