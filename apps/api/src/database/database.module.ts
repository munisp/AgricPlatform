import { Global, Module, type Provider } from '@nestjs/common';
import type pg from 'pg';
import {
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
  DISEASE_FLAG_REPOSITORY,
  DOCUMENT_REPOSITORY,
  DRAFT_ORDER_REPOSITORY,
  ENROLMENT_REPOSITORY,
  ENTITY_VERSION_REPOSITORY,
  EQUIPMENT_BOOKING_REPOSITORY,
  EQUIPMENT_LISTING_REPOSITORY,
  ESCROW_REPOSITORY,
  EVENT_RSVP_REPOSITORY,
  EXPORT_DOCUMENT_REPOSITORY,
  EXTERNAL_ACCOUNT_LINK_REPOSITORY,
  FARM_EXPENSE_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  FARM_RECORD_REPOSITORY,
  FEATURE_FLAG_REPOSITORY,
  FORUM_TOPIC_REPOSITORY,
  GEO_BOUNDARY_REPOSITORY,
  GEO_CREDIT_SHADOW_REPOSITORY,
  H3_INDEX_REPOSITORY,
  HARVEST_RECORD_REPOSITORY,
  HEALTH_RECORD_REPOSITORY,
  IDEMPOTENCY_STORE,
  IMPORT_BATCH_REPOSITORY,
  IMPORT_RECORD_REPOSITORY,
  INBOUND_EVENT_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  INPUT_VOUCHER_REDEMPTION_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY,
  INSURANCE_CLAIM_REPOSITORY,
  INSURANCE_POLICY_REPOSITORY,
  INVOICE_REPOSITORY,
  IVR_CALL_REPOSITORY,
  JUDGE_ASSIGNMENT_REPOSITORY,
  JUDGE_SCORE_REPOSITORY,
  KEY_VALUE_STORE,
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
  LOAN_APPLICATION_REPOSITORY,
  LOT_PLOT_LINK_REPOSITORY,
  LOT_REPOSITORY,
  MENTOR_REQUEST_REPOSITORY,
  MILESTONE_PROGRESS_REPOSITORY,
  MOVEMENT_PERMIT_REPOSITORY,
  MOVEMENT_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OPPORTUNITY_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  OTP_STORE,
  OUTBOX_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY,
  PARAMETRIC_PAYOUT_REPOSITORY,
  PARAMETRIC_POLICY_REPOSITORY,
  PARAMETRIC_PRODUCT_REPOSITORY,
  PARAMETRIC_TRIGGER_EVENT_REPOSITORY,
  PARTNER_CLIENT_REPOSITORY,
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
  REDIS_CLIENT,
  REPAYMENT_SCHEDULE_REPOSITORY,
  RETENTION_POLICY_REPOSITORY,
  RETURN_REQUEST_REPOSITORY,
  REVIEW_REPOSITORY,
  RUBRIC_CRITERION_REPOSITORY,
  SEARCH_QUERY_REPOSITORY,
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
  VSLA_CONTRIBUTION_REPOSITORY,
  VSLA_CYCLE_REPOSITORY,
  VSLA_GROUP_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY,
  VSLA_SHARE_OUT_PLAN_REPOSITORY,
  VSLA_LOAN_REPOSITORY,
  VSLA_LOAN_REPAYMENT_REPOSITORY,
  CARBON_PLOT_REPOSITORY as CARBON_PLOT_REPOSITORY_TOKEN,
  WAREHOUSE_DEPOSIT_REPOSITORY,
  WAREHOUSE_PLEDGE_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY,
  WAREHOUSE_TRANSFER_REPOSITORY,
  WEBHOOK_DEDUPE_STORE,
  WEBHOOK_SUBSCRIPTION_REPOSITORY,
  WEBINAR_REGISTRATION_REPOSITORY,
  WEBINAR_REPOSITORY
} from './persistence.tokens.js';
import { RedisModule } from './redis.module.js';
import { ConfigService } from '../config/config.service.js';
import {
  createInMemoryUserRepository,
  createPgUserRepository
} from './repositories/user.repository.js';
import {
  createInMemoryProfileRepository,
  createPgProfileRepository
} from './repositories/profile.repository.js';
import {
  createInMemoryConsentRepository,
  createPgConsentRepository
} from './repositories/consent.repository.js';
import {
  createInMemoryDeletionRequestRepository,
  createPgDeletionRequestRepository
} from './repositories/deletion-request.repository.js';
import {
  createInMemoryCourseRepository,
  createPgCourseRepository
} from './repositories/course.repository.js';
import {
  createInMemoryEnrolmentRepository,
  createPgEnrolmentRepository
} from './repositories/enrolment.repository.js';
import {
  createInMemoryCertificateRepository,
  createPgCertificateRepository
} from './repositories/certificate.repository.js';
import {
  createInMemoryForumTopicRepository,
  createPgForumTopicRepository
} from './repositories/forum.repository.js';
import {
  createInMemoryMentorRequestRepository,
  createPgMentorRequestRepository
} from './repositories/mentor.repository.js';
import {
  createInMemoryTopicFlagRepository,
  createPgTopicFlagRepository
} from './repositories/moderation.repository.js';
import {
  createInMemoryOpportunityRepository,
  createPgOpportunityRepository
} from './repositories/opportunity.repository.js';
import {
  createInMemoryApplicationRepository,
  createPgApplicationRepository
} from './repositories/application.repository.js';
import {
  createInMemoryChapterRepository,
  createPgChapterRepository
} from './repositories/chapter.repository.js';
import {
  createInMemoryChapterEventRepository,
  createPgChapterEventRepository
} from './repositories/chapter-event.repository.js';
import {
  createInMemoryEventRsvpRepository,
  createPgEventRsvpRepository
} from './repositories/event-rsvp.repository.js';
import {
  createInMemoryAnnouncementRepository,
  createPgAnnouncementRepository
} from './repositories/announcement.repository.js';
import {
  createInMemoryAdvisoryRepository,
  createPgAdvisoryRepository
} from './repositories/advisory.repository.js';
import {
  createInMemoryListingRepository,
  createPgListingRepository
} from './repositories/listing.repository.js';
import {
  createInMemoryOrderRepository,
  createPgOrderRepository
} from './repositories/order.repository.js';
import {
  createInMemoryReviewRepository,
  createPgReviewRepository
} from './repositories/review.repository.js';
import {
  createInMemoryCreditProfileRepository,
  createPgCreditProfileRepository
} from './repositories/credit-profile.repository.js';
import {
  createInMemoryDocumentRepository,
  createPgDocumentRepository
} from './repositories/document.repository.js';
import {
  createInMemoryNotificationRepository,
  createPgNotificationRepository
} from './repositories/notification.repository.js';
import {
  createInMemoryNotificationPreferenceRepository,
  createPgNotificationPreferenceRepository
} from './repositories/notification-preference.repository.js';
import {
  createInMemoryDeliveryLogRepository,
  createPgDeliveryLogRepository
} from './repositories/delivery-log.repository.js';
import {
  createInMemoryAuditRepository,
  createPgAuditRepository
} from './repositories/audit.repository.js';
import {
  createInMemoryOutboxRepository,
  createPgOutboxRepository
} from './repositories/outbox.repository.js';
import {
  createInMemoryCommodityPriceRepository,
  createPgCommodityPriceRepository
} from './repositories/commodity-price.repository.js';
import {
  createInMemorySupplierRepository,
  createPgSupplierRepository
} from './repositories/supplier.repository.js';
import {
  createInMemoryServiceOfferingRepository,
  createPgServiceOfferingRepository
} from './repositories/service-offering.repository.js';
import {
  createInMemoryServiceBookingRepository,
  createPgServiceBookingRepository
} from './repositories/service-booking.repository.js';
import {
  createInMemoryServiceReviewRepository,
  createPgServiceReviewRepository
} from './repositories/service-review.repository.js';
import {
  createInMemoryProgrammeCohortRepository,
  createPgProgrammeCohortRepository
} from './repositories/programme-cohort.repository.js';
import {
  createInMemoryProgrammeEnrolmentRepository,
  createPgProgrammeEnrolmentRepository
} from './repositories/programme-enrolment.repository.js';
import {
  createInMemoryProgrammeMilestoneRepository,
  createPgProgrammeMilestoneRepository
} from './repositories/programme-milestone.repository.js';
import {
  createInMemoryMilestoneProgressRepository,
  createPgMilestoneProgressRepository
} from './repositories/milestone-progress.repository.js';
import {
  createInMemoryRubricCriterionRepository,
  createPgRubricCriterionRepository
} from './repositories/rubric-criterion.repository.js';
import {
  createInMemoryJudgeAssignmentRepository,
  createPgJudgeAssignmentRepository
} from './repositories/judge-assignment.repository.js';
import {
  createInMemoryJudgeScoreRepository,
  createPgJudgeScoreRepository
} from './repositories/judge-score.repository.js';
import {
  createInMemoryCohortThreadRepository,
  createPgCohortThreadRepository
} from './repositories/cohort-thread.repository.js';
import {
  createInMemoryCohortThreadPostRepository,
  createPgCohortThreadPostRepository
} from './repositories/cohort-thread-post.repository.js';
import {
  createInMemoryPathwayTemplateRepository,
  createPgPathwayTemplateRepository
} from './repositories/pathway-template.repository.js';
import {
  createInMemoryPathwayStageRepository,
  createPgPathwayStageRepository
} from './repositories/pathway-stage.repository.js';
import {
  createInMemoryPathwayEnrolmentRepository,
  createPgPathwayEnrolmentRepository
} from './repositories/pathway-enrolment.repository.js';
import {
  createInMemoryStageProgressRepository,
  createPgStageProgressRepository
} from './repositories/stage-progress.repository.js';
import {
  createInMemoryCampusClubRepository,
  createPgCampusClubRepository
} from './repositories/campus-club.repository.js';
import {
  createInMemoryCampusClubMembershipRepository,
  createPgCampusClubMembershipRepository
} from './repositories/campus-club-membership.repository.js';
import {
  createInMemoryKnowledgeResourceRepository,
  createPgKnowledgeResourceRepository
} from './repositories/knowledge-resource.repository.js';
import {
  createInMemoryPodcastEpisodeRepository,
  createPgPodcastEpisodeRepository
} from './repositories/podcast-episode.repository.js';
import {
  createInMemoryWebinarRepository,
  createPgWebinarRepository
} from './repositories/webinar.repository.js';
import {
  createInMemoryWebinarRegistrationRepository,
  createPgWebinarRegistrationRepository
} from './repositories/webinar-registration.repository.js';
import {
  createInMemorySearchQueryRepository,
  createPgSearchQueryRepository
} from './repositories/search-query.repository.js';
import {
  createInMemoryRecommendationFeedbackRepository,
  createPgRecommendationFeedbackRepository
} from './repositories/recommendation-feedback.repository.js';
import {
  createInMemoryAnalyticsMartRepository,
  createPgAnalyticsMartRepository
} from './repositories/analytics-mart.repository.js';
import {
  createInMemoryEscrowRepository,
  createPgEscrowRepository
} from './repositories/escrow.repository.js';
import {
  createInMemoryInvoiceRepository,
  createPgInvoiceRepository
} from './repositories/invoice.repository.js';
import {
  createInMemoryShipmentRepository,
  createPgShipmentRepository
} from './repositories/shipment.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createPgLedgerAccountRepository
} from './repositories/ledger.repository.js';
import {
  createInMemoryLedgerEntryRepository,
  createPgLedgerEntryRepository
} from './repositories/ledger.repository.js';
import {
  createInMemoryCreditScoreRepository,
  createPgCreditScoreRepository
} from './repositories/credit-score.repository.js';
import {
  createInMemoryLenderRepository,
  createPgLenderRepository
} from './repositories/lender.repository.js';
import {
  createInMemoryLoanApplicationRepository,
  createPgLoanApplicationRepository
} from './repositories/loan-application.repository.js';
import {
  createInMemoryRepaymentScheduleRepository,
  createPgRepaymentScheduleRepository
} from './repositories/repayment-schedule.repository.js';
import {
  createInMemoryExternalAccountLinkRepository,
  createPgExternalAccountLinkRepository
} from './repositories/external-account-link.repository.js';
import {
  createInMemoryFarmRecordRepository,
  createPgFarmRecordRepository
} from './repositories/farm-record.repository.js';
import {
  createInMemoryImportBatchRepository,
  createPgImportBatchRepository
} from './repositories/import-batch.repository.js';
import {
  createInMemoryImportRecordRepository,
  createPgImportRecordRepository
} from './repositories/import-record.repository.js';
import {
  createInMemoryInboundEventRepository,
  createPgInboundEventRepository
} from './repositories/inbound-event.repository.js';
import {
  createInMemoryUssdSessionRepository,
  createPgUssdSessionRepository
} from './repositories/ussd-session.repository.js';
import {
  createInMemoryPinProfileRepository,
  createPgPinProfileRepository
} from './repositories/pin-profile.repository.js';
import {
  createInMemoryPartnerClientRepository,
  createPgPartnerClientRepository
} from './repositories/partner-client.repository.js';
import {
  createInMemoryApiKeyRepository,
  createPgApiKeyRepository
} from './repositories/api-key.repository.js';
import {
  createInMemoryWebhookSubscriptionRepository,
  createPgWebhookSubscriptionRepository
} from './repositories/webhook-subscription.repository.js';
import {
  createInMemoryIvrCallRepository,
  createPgIvrCallRepository
} from './repositories/ivr-call.repository.js';
import {
  createInMemoryAnimalRepository,
  createPgAnimalRepository
} from './repositories/animal.repository.js';
import {
  createInMemoryLotRepository,
  createPgLotRepository
} from './repositories/lot.repository.js';
import {
  createInMemoryOwnershipTransferRepository,
  createPgOwnershipTransferRepository
} from './repositories/ownership-transfer.repository.js';
import {
  createInMemoryPastoralistProfileRepository,
  createPgPastoralistProfileRepository
} from './repositories/pastoralist-profile.repository.js';
import {
  createInMemoryCertifiedListingRepository,
  createPgCertifiedListingRepository
} from './repositories/certified-listing.repository.js';
import {
  createInMemoryOfftakeTemplateRepository,
  createPgOfftakeTemplateRepository
} from './repositories/offtake-template.repository.js';
import {
  createInMemoryOfftakeContractRepository,
  createPgOfftakeContractRepository
} from './repositories/offtake-contract.repository.js';
import {
  createInMemoryExportDocumentRepository,
  createPgExportDocumentRepository
} from './repositories/export-document.repository.js';
import {
  createInMemoryLienRepository,
  createPgLienRepository
} from './repositories/lien.repository.js';
import {
  createInMemoryInsurancePolicyRepository,
  createPgInsurancePolicyRepository
} from './repositories/insurance-policy.repository.js';
import {
  createInMemoryInsuranceClaimRepository,
  createPgInsuranceClaimRepository
} from './repositories/insurance-claim.repository.js';
import {
  createInMemoryDisbursementRepository,
  createPgDisbursementRepository
} from './repositories/disbursement.repository.js';
import {
  createInMemoryAggregationPointRepository,
  createPgAggregationPointRepository
} from './repositories/aggregation-point.repository.js';
import {
  createInMemoryColdChainLogRepository,
  createPgColdChainLogRepository
} from './repositories/cold-chain-log.repository.js';
import {
  createInMemoryHealthRecordRepository,
  createPgHealthRecordRepository
} from './repositories/health-record.repository.js';
import {
  createInMemoryMovementRepository,
  createPgMovementRepository
} from './repositories/movement.repository.js';
import {
  createInMemoryMovementPermitRepository,
  createPgMovementPermitRepository
} from './repositories/movement-permit.repository.js';
import {
  createInMemoryRecallRepository,
  createPgRecallRepository
} from './repositories/recall.repository.js';
import {
  createInMemoryDiseaseFlagRepository,
  createPgDiseaseFlagRepository
} from './repositories/disease-flag.repository.js';
import {
  createInMemoryListingVariantRepository,
  createPgListingVariantRepository
} from './repositories/listing-variant.repository.js';
import {
  createInMemoryBuyerGroupRepository,
  createPgBuyerGroupRepository
} from './repositories/buyer-group.repository.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createPgBuyerGroupMembershipRepository
} from './repositories/buyer-group-membership.repository.js';
import {
  createInMemoryPriceListRepository,
  createPgPriceListRepository
} from './repositories/price-list.repository.js';
import {
  createInMemoryPriceListEntryRepository,
  createPgPriceListEntryRepository
} from './repositories/price-list-entry.repository.js';
import {
  createInMemoryPromotionRepository,
  createPgPromotionRepository
} from './repositories/promotion.repository.js';
import {
  createInMemoryPromotionRedemptionRepository,
  createPgPromotionRedemptionRepository
} from './repositories/promotion-redemption.repository.js';
import {
  createInMemoryOrderExtensionRepository,
  createPgOrderExtensionRepository
} from './repositories/order-extension.repository.js';
import {
  createInMemoryReturnRequestRepository,
  createPgReturnRequestRepository
} from './repositories/return-request.repository.js';
import {
  createInMemoryDraftOrderRepository,
  createPgDraftOrderRepository
} from './repositories/draft-order.repository.js';
import {
  createInMemoryProductReviewRepository,
  createPgProductReviewRepository
} from './repositories/product-review.repository.js';
import {
  createInMemorySellerRatingRepository,
  createPgSellerRatingRepository
} from './repositories/seller-rating.repository.js';
import {
  createInMemoryAuthSessionRepository,
  createPgAuthSessionRepository
} from './repositories/auth-session.repository.js';
import {
  createInMemoryFeatureFlagRepository,
  createPgFeatureFlagRepository
} from './repositories/feature-flag.repository.js';
import {
  createInMemoryProcessedEventRepository,
  createPgProcessedEventRepository
} from './repositories/processed-event.repository.js';
import {
  createInMemoryAnalyticsStarRepository,
  createPgAnalyticsStarRepository
} from './repositories/analytics-star.repository.js';
import {
  createInMemoryComplianceConsentRepository,
  createPgComplianceConsentRepository
} from './repositories/compliance-consent.repository.js';
import {
  createInMemoryDataSubjectRequestRepository,
  createPgDataSubjectRequestRepository
} from './repositories/data-subject-request.repository.js';
import {
  createInMemoryRetentionPolicyRepository,
  createPgRetentionPolicyRepository
} from './repositories/retention-policy.repository.js';
import {
  createInMemoryEntityVersionRepository,
  createPgEntityVersionRepository
} from './repositories/entity-version.repository.js';
import {
  createInMemorySyncCursorRepository,
  createPgSyncCursorRepository
} from './repositories/sync-cursor.repository.js';
import {
  createInMemorySyncMutationRepository,
  createPgSyncMutationRepository
} from './repositories/sync-mutation.repository.js';
import {
  createInMemoryFarmPlotRepository,
  createPgFarmPlotRepository
} from './repositories/farm-plot.repository.js';
import {
  createInMemoryCropPlantingRepository,
  createPgCropPlantingRepository
} from './repositories/crop-planting.repository.js';
import {
  createInMemoryHarvestRecordRepository,
  createPgHarvestRecordRepository
} from './repositories/harvest-record.repository.js';
import {
  createInMemoryFarmExpenseRepository,
  createPgFarmExpenseRepository
} from './repositories/farm-expense.repository.js';
import {
  createInMemoryAgentAssignmentRepository,
  createPgAgentAssignmentRepository
} from './repositories/agent-assignment.repository.js';
import {
  createInMemoryAgentActivityLogRepository,
  createPgAgentActivityLogRepository
} from './repositories/agent-activity-log.repository.js';
import {
  createInMemoryH3IndexRepository,
  createPgH3IndexRepository
} from './repositories/h3-index.repository.js';
import {
  createInMemoryGeoBoundaryRepository,
  createPgGeoBoundaryRepository
} from './repositories/geo-boundary.repository.js';
import {
  createInMemoryVoiceSessionRepository,
  createPgVoiceSessionRepository
} from './repositories/voice-session.repository.js';
import {
  createInMemoryVoiceTurnRepository,
  createPgVoiceTurnRepository
} from './repositories/voice-turn.repository.js';
import {
  createInMemoryAgentCaseRepository,
  createPgAgentCaseRepository
} from './repositories/agent-case.repository.js';
import {
  createInMemoryCreditProductRepository,
  createPgCreditProductRepository
} from './repositories/credit-product.repository.js';
import {
  createInMemoryCreditLoanRepository,
  createPgCreditLoanRepository
} from './repositories/credit-loan.repository.js';
import {
  createInMemoryCreditRepaymentRepository,
  createPgCreditRepaymentRepository
} from './repositories/credit-repayment.repository.js';
import {
  createInMemoryCreditCollateralRepository,
  createPgCreditCollateralRepository
} from './repositories/credit-collateral.repository.js';
import {
  createInMemoryCreditGuarantorRepository,
  createPgCreditGuarantorRepository
} from './repositories/credit-guarantor.repository.js';
import {
  createInMemoryCreditGroupRepository,
  createPgCreditGroupRepository
} from './repositories/credit-group.repository.js';
import {
  createInMemoryCreditGroupMemberRepository,
  createPgCreditGroupMemberRepository
} from './repositories/credit-group-member.repository.js';
import {
  createInMemoryCreditSavingsAccountRepository,
  createPgCreditSavingsAccountRepository
} from './repositories/credit-savings-account.repository.js';
import {
  createInMemoryCreditSavingsTransactionRepository,
  createPgCreditSavingsTransactionRepository
} from './repositories/credit-savings-transaction.repository.js';
import {
  createInMemoryCommodityLotRepository,
  createPgCommodityLotRepository
} from './repositories/commodity-lot.repository.js';
import {
  createInMemoryCustodyEventRepository,
  createPgCustodyEventRepository
} from './repositories/custody-event.repository.js';
import {
  createInMemoryLotPlotLinkRepository,
  createPgLotPlotLinkRepository
} from './repositories/lot-plot-link.repository.js';
import {
  createInMemoryTraceabilityShipmentRepository,
  createPgTraceabilityShipmentRepository
} from './repositories/traceability-shipment.repository.js';
import {
  createInMemoryGeoCreditShadowRepository,
  createPgGeoCreditShadowRepository
} from './repositories/geo-credit-shadow.repository.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createPgAgentBankingAgentRepository
} from './repositories/agent-banking.repository.js';
import {
  createInMemoryAgentFloatTopupRepository,
  createPgAgentFloatTopupRepository
} from './repositories/agent-banking.repository.js';
import {
  createInMemoryAgentVoucherRepository,
  createPgAgentVoucherRepository
} from './repositories/agent-banking.repository.js';
import {
  createInMemoryAgentTransactionRepository,
  createPgAgentTransactionRepository
} from './repositories/agent-banking.repository.js';
import {
  createInMemoryEquipmentListingRepository,
  createPgEquipmentListingRepository
} from './repositories/equipment-listing.repository.js';
import {
  createInMemoryEquipmentBookingRepository,
  createPgEquipmentBookingRepository
} from './repositories/equipment-booking.repository.js';
import {
  createInMemoryParametricProductRepository,
  createPgParametricProductRepository
} from './repositories/parametric-product.repository.js';
import {
  createInMemoryParametricPolicyRepository,
  createPgParametricPolicyRepository
} from './repositories/parametric-policy.repository.js';
import {
  createInMemoryParametricTriggerEventRepository,
  createPgParametricTriggerEventRepository
} from './repositories/parametric-trigger-event.repository.js';
import {
  createInMemoryParametricPayoutRepository,
  createPgParametricPayoutRepository
} from './repositories/parametric-payout.repository.js';
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
import {
  createInMemoryLivestockPassportRepository,
  createPgLivestockPassportRepository
} from './repositories/livestock-passport.repository.js';
import {
  createInMemoryLivestockPassportEventRepository,
  createPgLivestockPassportEventRepository
} from './repositories/livestock-passport-event.repository.js';
import {
  createInMemoryLivestockPassportTransferRepository,
  createPgLivestockPassportTransferRepository
} from './repositories/livestock-passport-transfer.repository.js';
import {
  createInMemoryInputVoucherProgrammeRepository,
  createPgInputVoucherProgrammeRepository
} from './repositories/input-voucher-programme.repository.js';
import {
  createInMemoryBeneficiaryRepository,
  createPgBeneficiaryRepository
} from './repositories/beneficiary.repository.js';
import {
  createInMemoryInputVoucherRepository,
  createPgInputVoucherRepository
} from './repositories/input-voucher.repository.js';
import {
  createInMemoryInputVoucherRedemptionRepository,
  createPgInputVoucherRedemptionRepository
} from './repositories/input-voucher-redemption.repository.js';
import {
  createInMemoryCertifiedWarehouseRepository,
  createPgCertifiedWarehouseRepository
} from './repositories/certified-warehouse.repository.js';
import {
  createInMemoryWarehouseDepositRepository,
  createPgWarehouseDepositRepository
} from './repositories/warehouse-deposit.repository.js';
import {
  createInMemoryWarehouseReceiptRepository,
  createPgWarehouseReceiptRepository
} from './repositories/warehouse-receipt.repository.js';
import {
  createInMemoryWarehousePledgeRepository,
  createPgWarehousePledgeRepository
} from './repositories/warehouse-pledge.repository.js';
import {
  createInMemoryWarehouseTransferRepository,
  createPgWarehouseTransferRepository
} from './repositories/warehouse-transfer.repository.js';

/**
 * Global persistence module: provides the pg.Pool when DATABASE_URL is set,
 * otherwise every repository falls back to the in-memory implementation so
 * the API can boot for local development and unit tests. Swapping backends
 * is a config change, not a code change.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): pg.Pool | null => {
        return config.createPgPool();
      }
    },
    {
      provide: IDEMPOTENCY_STORE,
      inject: [REDIS_CLIENT],
      useFactory: (redis: unknown) => redis // placeholder, overridden by RedisModule exports
    },
    {
      provide: USER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgUserRepository(pool) : createInMemoryUserRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProfileRepository(pool) : createInMemoryProfileRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CONSENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgConsentRepository(pool) : createInMemoryConsentRepository(),
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCourseRepository(pool) : createInMemoryCourseRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ENROLMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEnrolmentRepository(pool) : createInMemoryEnrolmentRepository(),
      inject: [PG_POOL]
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgApplicationRepository(pool) : createInMemoryApplicationRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CHAPTER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgChapterRepository(pool) : createInMemoryChapterRepository(),
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEventRsvpRepository(pool) : createInMemoryEventRsvpRepository(),
      inject: [PG_POOL]
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgListingRepository(pool) : createInMemoryListingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ORDER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOrderRepository(pool) : createInMemoryOrderRepository(),
      inject: [PG_POOL]
    },
    {
      provide: REVIEW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgReviewRepository(pool) : createInMemoryReviewRepository(),
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgNotificationRepository(pool) : createInMemoryNotificationRepository(),
      inject: [PG_POOL]
    },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgNotificationPreferenceRepository(pool)
          : createInMemoryNotificationPreferenceRepository(),
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAuditRepository(pool) : createInMemoryAuditRepository(),
      inject: [PG_POOL]
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOutboxRepository(pool) : createInMemoryOutboxRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COMMODITY_PRICE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCommodityPriceRepository(pool) : createInMemoryCommodityPriceRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SUPPLIER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgSupplierRepository(pool) : createInMemorySupplierRepository(),
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
        pool
          ? createPgProgrammeEnrolmentRepository(pool)
          : createInMemoryProgrammeEnrolmentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PROGRAMME_MILESTONE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgProgrammeMilestoneRepository(pool)
          : createInMemoryProgrammeMilestoneRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MILESTONE_PROGRESS_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgMilestoneProgressRepository(pool)
          : createInMemoryMilestoneProgressRepository(),
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
        pool
          ? createPgCohortThreadPostRepository(pool)
          : createInMemoryCohortThreadPostRepository(),
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
        pool
          ? createPgCampusClubMembershipRepository(pool)
          : createInMemoryCampusClubMembershipRepository(),
      inject: [PG_POOL]
    },
    {
      provide: KNOWLEDGE_RESOURCE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgKnowledgeResourceRepository(pool)
          : createInMemoryKnowledgeResourceRepository(),
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgWebinarRepository(pool) : createInMemoryWebinarRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WEBINAR_REGISTRATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgWebinarRegistrationRepository(pool)
          : createInMemoryWebinarRegistrationRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SEARCH_QUERY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgSearchQueryRepository(pool) : createInMemorySearchQueryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: RECOMMENDATION_FEEDBACK_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgRecommendationFeedbackRepository(pool)
          : createInMemoryRecommendationFeedbackRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ANALYTICS_MART_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnalyticsMartRepository(pool) : createInMemoryAnalyticsMartRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ESCROW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEscrowRepository(pool) : createInMemoryEscrowRepository(),
      inject: [PG_POOL]
    },
    {
      provide: INVOICE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgInvoiceRepository(pool) : createInMemoryInvoiceRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SHIPMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgShipmentRepository(pool) : createInMemoryShipmentRepository(),
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLenderRepository(pool) : createInMemoryLenderRepository(),
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
        pool
          ? createPgRepaymentScheduleRepository(pool)
          : createInMemoryRepaymentScheduleRepository(),
      inject: [PG_POOL]
    },
    {
      provide: EXTERNAL_ACCOUNT_LINK_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgExternalAccountLinkRepository(pool)
          : createInMemoryExternalAccountLinkRepository(),
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
    {
      provide: IVR_CALL_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgIvrCallRepository(pool) : createInMemoryIvrCallRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ANIMAL_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnimalRepository(pool) : createInMemoryAnimalRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LOT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLotRepository(pool) : createInMemoryLotRepository(),
      inject: [PG_POOL]
    },
    {
      provide: OWNERSHIP_TRANSFER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgOwnershipTransferRepository(pool)
          : createInMemoryOwnershipTransferRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PASTORALIST_PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgPastoralistProfileRepository(pool)
          : createInMemoryPastoralistProfileRepository(),
      inject: [PG_POOL]
    },
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
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLienRepository(pool) : createInMemoryLienRepository(),
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
        pool
          ? createPgAggregationPointRepository(pool)
          : createInMemoryAggregationPointRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COLD_CHAIN_LOG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgColdChainLogRepository(pool) : createInMemoryColdChainLogRepository(),
      inject: [PG_POOL]
    },
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
        pool
          ? createPgBuyerGroupMembershipRepository(pool)
          : createInMemoryBuyerGroupMembershipRepository(),
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
        pool
          ? createPgPromotionRedemptionRepository(pool)
          : createInMemoryPromotionRedemptionRepository(),
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
    {
      provide: ANALYTICS_STAR_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnalyticsStarRepository(pool) : createInMemoryAnalyticsStarRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COMPLIANCE_CONSENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgComplianceConsentRepository(pool)
          : createInMemoryComplianceConsentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DATA_SUBJECT_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgDataSubjectRequestRepository(pool)
          : createInMemoryDataSubjectRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: RETENTION_POLICY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRetentionPolicyRepository(pool) : createInMemoryRetentionPolicyRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ENTITY_VERSION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEntityVersionRepository(pool) : createInMemoryEntityVersionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SYNC_CURSOR_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgSyncCursorRepository(pool) : createInMemorySyncCursorRepository(),
      inject: [PG_POOL]
    },
    {
      provide: SYNC_MUTATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgSyncMutationRepository(pool) : createInMemorySyncMutationRepository(),
      inject: [PG_POOL]
    },
    {
      provide: FARM_PLOT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgFarmPlotRepository(pool) : createInMemoryFarmPlotRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CROP_PLANTING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCropPlantingRepository(pool) : createInMemoryCropPlantingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: HARVEST_RECORD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgHarvestRecordRepository(pool) : createInMemoryHarvestRecordRepository(),
      inject: [PG_POOL]
    },
    {
      provide: FARM_EXPENSE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgFarmExpenseRepository(pool) : createInMemoryFarmExpenseRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_ASSIGNMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAgentAssignmentRepository(pool) : createInMemoryAgentAssignmentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_ACTIVITY_LOG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgAgentActivityLogRepository(pool)
          : createInMemoryAgentActivityLogRepository(),
      inject: [PG_POOL]
    },
    {
      provide: H3_INDEX_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgH3IndexRepository(pool) : createInMemoryH3IndexRepository(),
      inject: [PG_POOL]
    },
    {
      provide: GEO_BOUNDARY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgGeoBoundaryRepository(pool) : createInMemoryGeoBoundaryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VOICE_SESSION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVoiceSessionRepository(pool) : createInMemoryVoiceSessionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VOICE_TURN_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVoiceTurnRepository(pool) : createInMemoryVoiceTurnRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_CASE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAgentCaseRepository(pool) : createInMemoryAgentCaseRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_PRODUCT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditProductRepository(pool) : createInMemoryCreditProductRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_LOAN_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditLoanRepository(pool) : createInMemoryCreditLoanRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_REPAYMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditRepaymentRepository(pool) : createInMemoryCreditRepaymentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_COLLATERAL_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditCollateralRepository(pool) : createInMemoryCreditCollateralRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_GUARANTOR_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditGuarantorRepository(pool) : createInMemoryCreditGuarantorRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_GROUP_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditGroupRepository(pool) : createInMemoryCreditGroupRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_GROUP_MEMBER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgCreditGroupMemberRepository(pool)
          : createInMemoryCreditGroupMemberRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgCreditSavingsAccountRepository(pool)
          : createInMemoryCreditSavingsAccountRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_SAVINGS_TRANSACTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgCreditSavingsTransactionRepository(pool)
          : createInMemoryCreditSavingsTransactionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COMMODITY_LOT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCommodityLotRepository(pool) : createInMemoryCommodityLotRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CUSTODY_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCustodyEventRepository(pool) : createInMemoryCustodyEventRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LOT_PLOT_LINK_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLotPlotLinkRepository(pool) : createInMemoryLotPlotLinkRepository(),
      inject: [PG_POOL]
    },
    {
      provide: TRACEABILITY_SHIPMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgTraceabilityShipmentRepository(pool)
          : createInMemoryTraceabilityShipmentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: GEO_CREDIT_SHADOW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgGeoCreditShadowRepository(pool) : createInMemoryGeoCreditShadowRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_BANKING_AGENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgAgentBankingAgentRepository(pool)
          : createInMemoryAgentBankingAgentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_FLOAT_TOPUP_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAgentFloatTopupRepository(pool) : createInMemoryAgentFloatTopupRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_VOUCHER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAgentVoucherRepository(pool) : createInMemoryAgentVoucherRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AGENT_TRANSACTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAgentTransactionRepository(pool) : createInMemoryAgentTransactionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: EQUIPMENT_LISTING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEquipmentListingRepository(pool) : createInMemoryEquipmentListingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: EQUIPMENT_BOOKING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEquipmentBookingRepository(pool) : createInMemoryEquipmentBookingRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PARAMETRIC_PRODUCT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgParametricProductRepository(pool)
          : createInMemoryParametricProductRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PARAMETRIC_POLICY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgParametricPolicyRepository(pool) : createInMemoryParametricPolicyRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PARAMETRIC_TRIGGER_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgParametricTriggerEventRepository(pool)
          : createInMemoryParametricTriggerEventRepository(),
      inject: [PG_POOL]
    },
    {
      provide: PARAMETRIC_PAYOUT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgParametricPayoutRepository(pool) : createInMemoryParametricPayoutRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_GROUP_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVslaGroupRepository(pool) : createInMemoryVslaGroupRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_MEMBER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVslaMemberRepository(pool) : createInMemoryVslaMemberRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_CYCLE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVslaCycleRepository(pool) : createInMemoryVslaCycleRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_CONTRIBUTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVslaContributionRepository(pool) : createInMemoryVslaContributionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_SHARE_OUT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVslaShareOutRepository(pool) : createInMemoryVslaShareOutRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_SHARE_OUT_PLAN_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgVslaShareOutPlanRepository(pool)
          : createInMemoryVslaShareOutPlanRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_LOAN_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgVslaLoanRepository(pool) : createInMemoryVslaLoanRepository(),
      inject: [PG_POOL]
    },
    {
      provide: VSLA_LOAN_REPAYMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgVslaLoanRepaymentRepository(pool)
          : createInMemoryVslaLoanRepaymentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CARBON_PLOT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCarbonPlotRepository(pool) : createInMemoryCarbonPlotRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CARBON_EVIDENCE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCarbonEvidenceRepository(pool) : createInMemoryCarbonEvidenceRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CARBON_ESTIMATE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCarbonEstimateRepository(pool) : createInMemoryCarbonEstimateRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LIVESTOCK_PASSPORT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgLivestockPassportRepository(pool)
          : createInMemoryLivestockPassportRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LIVESTOCK_PASSPORT_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgLivestockPassportEventRepository(pool)
          : createInMemoryLivestockPassportEventRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LIVESTOCK_PASSPORT_TRANSFER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgLivestockPassportTransferRepository(pool)
          : createInMemoryLivestockPassportTransferRepository(),
      inject: [PG_POOL]
    },
    {
      provide: INPUT_VOUCHER_PROGRAMME_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgInputVoucherProgrammeRepository(pool)
          : createInMemoryInputVoucherProgrammeRepository(),
      inject: [PG_POOL]
    },
    {
      provide: BENEFICIARY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgBeneficiaryRepository(pool) : createInMemoryBeneficiaryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: INPUT_VOUCHER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgInputVoucherRepository(pool) : createInMemoryInputVoucherRepository(),
      inject: [PG_POOL]
    },
    {
      provide: INPUT_VOUCHER_REDEMPTION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgInputVoucherRedemptionRepository(pool)
          : createInMemoryInputVoucherRedemptionRepository(),
      inject: [PG_POOL]
    },
    {
      provide: CERTIFIED_WAREHOUSE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgCertifiedWarehouseRepository(pool)
          : createInMemoryCertifiedWarehouseRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WAREHOUSE_DEPOSIT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgWarehouseDepositRepository(pool) : createInMemoryWarehouseDepositRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WAREHOUSE_RECEIPT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgWarehouseReceiptRepository(pool) : createInMemoryWarehouseReceiptRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WAREHOUSE_PLEDGE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgWarehousePledgeRepository(pool) : createInMemoryWarehousePledgeRepository(),
      inject: [PG_POOL]
    },
    {
      provide: WAREHOUSE_TRANSFER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgWarehouseTransferRepository(pool)
          : createInMemoryWarehouseTransferRepository(),
      inject: [PG_POOL]
    }
  ] satisfies Provider[],
  exports: [
    PG_POOL,
    IDEMPOTENCY_STORE,
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
    RECOMMENDATION_FEEDBACK_REPOSITORY,
    ANALYTICS_MART_REPOSITORY,
    ESCROW_REPOSITORY,
    INVOICE_REPOSITORY,
    SHIPMENT_REPOSITORY,
    LEDGER_ACCOUNT_REPOSITORY,
    LEDGER_ENTRY_REPOSITORY,
    CREDIT_SCORE_REPOSITORY,
    LENDER_REPOSITORY,
    LOAN_APPLICATION_REPOSITORY,
    REPAYMENT_SCHEDULE_REPOSITORY,
    EXTERNAL_ACCOUNT_LINK_REPOSITORY,
    FARM_RECORD_REPOSITORY,
    IMPORT_BATCH_REPOSITORY,
    IMPORT_RECORD_REPOSITORY,
    INBOUND_EVENT_REPOSITORY,
    USSD_SESSION_REPOSITORY,
    PIN_PROFILE_REPOSITORY,
    PARTNER_CLIENT_REPOSITORY,
    API_KEY_REPOSITORY,
    WEBHOOK_SUBSCRIPTION_REPOSITORY,
    IVR_CALL_REPOSITORY,
    ANIMAL_REPOSITORY,
    LOT_REPOSITORY,
    OWNERSHIP_TRANSFER_REPOSITORY,
    PASTORALIST_PROFILE_REPOSITORY,
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
    HEALTH_RECORD_REPOSITORY,
    MOVEMENT_REPOSITORY,
    MOVEMENT_PERMIT_REPOSITORY,
    RECALL_REPOSITORY,
    DISEASE_FLAG_REPOSITORY,
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
    RETENTION_POLICY_REPOSITORY,
    ENTITY_VERSION_REPOSITORY,
    SYNC_CURSOR_REPOSITORY,
    SYNC_MUTATION_REPOSITORY,
    FARM_PLOT_REPOSITORY,
    CROP_PLANTING_REPOSITORY,
    HARVEST_RECORD_REPOSITORY,
    FARM_EXPENSE_REPOSITORY,
    AGENT_ASSIGNMENT_REPOSITORY,
    AGENT_ACTIVITY_LOG_REPOSITORY,
    H3_INDEX_REPOSITORY,
    GEO_BOUNDARY_REPOSITORY,
    VOICE_SESSION_REPOSITORY,
    VOICE_TURN_REPOSITORY,
    AGENT_CASE_REPOSITORY,
    CREDIT_PRODUCT_REPOSITORY,
    CREDIT_LOAN_REPOSITORY,
    CREDIT_REPAYMENT_REPOSITORY,
    CREDIT_COLLATERAL_REPOSITORY,
    CREDIT_GUARANTOR_REPOSITORY,
    CREDIT_GROUP_REPOSITORY,
    CREDIT_GROUP_MEMBER_REPOSITORY,
    CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
    CREDIT_SAVINGS_TRANSACTION_REPOSITORY,
    COMMODITY_LOT_REPOSITORY,
    CUSTODY_EVENT_REPOSITORY,
    LOT_PLOT_LINK_REPOSITORY,
    TRACEABILITY_SHIPMENT_REPOSITORY,
    GEO_CREDIT_SHADOW_REPOSITORY,
    AGENT_BANKING_AGENT_REPOSITORY,
    AGENT_FLOAT_TOPUP_REPOSITORY,
    AGENT_VOUCHER_REPOSITORY,
    AGENT_TRANSACTION_REPOSITORY,
    EQUIPMENT_LISTING_REPOSITORY,
    EQUIPMENT_BOOKING_REPOSITORY,
    PARAMETRIC_PRODUCT_REPOSITORY,
    PARAMETRIC_POLICY_REPOSITORY,
    PARAMETRIC_TRIGGER_EVENT_REPOSITORY,
    PARAMETRIC_PAYOUT_REPOSITORY,
    // Wave VSLACARBON (additive).
    VSLA_GROUP_REPOSITORY,
    VSLA_MEMBER_REPOSITORY,
    VSLA_CYCLE_REPOSITORY,
    VSLA_CONTRIBUTION_REPOSITORY,
    VSLA_SHARE_OUT_REPOSITORY,
    VSLA_SHARE_OUT_PLAN_REPOSITORY,
    VSLA_LOAN_REPOSITORY,
    VSLA_LOAN_REPAYMENT_REPOSITORY,
    CARBON_PLOT_REPOSITORY_TOKEN,
    CARBON_EVIDENCE_REPOSITORY,
    CARBON_ESTIMATE_REPOSITORY,
    // Wave LIVESTOCK-PASSPORT (additive).
    LIVESTOCK_PASSPORT_REPOSITORY,
    LIVESTOCK_PASSPORT_EVENT_REPOSITORY,
    LIVESTOCK_PASSPORT_TRANSFER_REPOSITORY,
    INPUT_VOUCHER_PROGRAMME_REPOSITORY,
    BENEFICIARY_REPOSITORY,
    INPUT_VOUCHER_REPOSITORY,
    INPUT_VOUCHER_REDEMPTION_REPOSITORY,
    CERTIFIED_WAREHOUSE_REPOSITORY,
    WAREHOUSE_DEPOSIT_REPOSITORY,
    WAREHOUSE_RECEIPT_REPOSITORY,
    WAREHOUSE_PLEDGE_REPOSITORY,
    WAREHOUSE_TRANSFER_REPOSITORY
  ]
})
export class DatabaseModule {}
