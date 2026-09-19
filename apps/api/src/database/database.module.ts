import { Module } from '@nestjs/common';
import {
  ACTIVITY_FEED_REPOSITORY,
  AGGREGATE_REPOSITORY,
  ALERT_PREFERENCE_REPOSITORY,
  ANTI_FRAUD_FLAG_REPOSITORY,
  API_PROVENANCE_REPOSITORY,
  AUDIT_ANCHOR_REPOSITORY,
  AUDIT_REPOSITORY,
  AUTH_SESSION_REPOSITORY,
  BULK_DISBURSEMENT_REPOSITORY,
  CARBON_CREDIT_REPOSITORY,
  CARBON_MILESTONE_REPOSITORY,
  CHAPTER_REPOSITORY,
  COMMODITY_PRICE_REPOSITORY,
  COMPLIANCE_CASE_REPOSITORY,
  CONSENT_RECORD_REPOSITORY,
  CONVERSATION_REPOSITORY,
  COOP_SCORE_REPOSITORY,
  COURSE_COMPLETION_REPOSITORY,
  COURSE_ENROLMENT_REPOSITORY,
  COURSE_REPOSITORY,
  CREDIT_PROFILE_REPOSITORY,
  CREDIT_SCORECARD_REPOSITORY,
  DISPUTE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  DSAR_REQUEST_REPOSITORY,
  ESCROW_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  FEATURE_FLAG_REPOSITORY,
  FIELD_CHECK_REPOSITORY,
  GRANT_APPLICATION_REPOSITORY,
  GROUP_BUY_REPOSITORY,
  GUARDIAN_LINK_REPOSITORY,
  HOLD_REPOSITORY,
  IDEMPOTENCY_RECORD_REPOSITORY,
  INTEGRATION_REPOSITORY,
  INTEROP_EXCHANGE_REPOSITORY,
  LEADERBOARD_ENTRY_REPOSITORY,
  LEADERBOARD_SNAPSHOT_REPOSITORY,
  LEDGER_ACCOUNT_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  LOAN_REPOSITORY,
  MANDATE_REPOSITORY,
  MARKET_LINK_REPOSITORY,
  MARKETPLACE_LISTING_REPOSITORY,
  MARKETPLACE_ORDER_REPOSITORY,
  MESSAGE_REPOSITORY,
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OFFLINE_ENROLMENT_TASK_REPOSITORY,
  OPPORTUNITY_REPOSITORY,
  OTP_CHALLENGE_REPOSITORY,
  OUTBOX_REPOSITORY,
  PARTNER_MEMBER_REPOSITORY,
  PARTNER_REPOSITORY,
  PAYMENT_REPOSITORY,
  PIN_PROFILE_REPOSITORY,
  PRICE_ALERT_REPOSITORY,
  PROCESSING_JOB_REPOSITORY,
  PROCESSING_RECORD_REPOSITORY,
  PROVIDER_INTEGRATION_REPOSITORY,
  PROVENANCE_AUDIT_REPOSITORY,
  PULSE_SUBSCRIPTION_REPOSITORY,
  RECEIPT_REPOSITORY,
  RECONCILIATION_EXCEPTION_REPOSITORY,
  RECONCILIATION_REPORT_REPOSITORY,
  REFERRAL_REPOSITORY,
  REGISTRY_ANCHOR_REPOSITORY,
  REPAYMENT_REPOSITORY,
  REVIEW_FLAG_REPOSITORY,
  REWARD_TRANSACTION_REPOSITORY,
  SAVINGS_GOAL_REPOSITORY,
  SELLER_PROFILE_REPOSITORY,
  SETTLEMENT_REPOSITORY,
  STAFF_REPOSITORY,
  STATEMENT_SNAPSHOT_REPOSITORY,
  STORAGE_DRIVER,
  SUBMISSION_REPOSITORY,
  SUCCESSION_CLAIM_REPOSITORY,
  SURVEY_REPOSITORY,
  TOPIC_REPOSITORY,
  TRAINING_MODULE_REPOSITORY,
  USSD_SESSION_REPOSITORY,
  USER_REPOSITORY,
  VOUCHER_REPOSITORY,
  WAREHOUSE_REPOSITORY,
  WEBHOOK_EVENT_REPOSITORY
} from './persistence.tokens.js';
import { registerPostgresRepositories } from './postgres-repositories.js';
import { PostgresModule } from './postgres.module.js';
import {
  InMemoryActivityFeedRepository,
  InMemoryAggregateRepository,
  InMemoryAlertPreferenceRepository,
  InMemoryAntiFraudFlagRepository,
  InMemoryApiProvenanceRepository,
  InMemoryAuditAnchorRepository,
  InMemoryAuditRepository,
  InMemoryAuthSessionRepository,
  InMemoryBulkDisbursementRepository,
  InMemoryCarbonCreditRepository,
  InMemoryCarbonMilestoneRepository,
  InMemoryChapterRepository,
  InMemoryCommodityPriceRepository,
  InMemoryComplianceCaseRepository,
  InMemoryConsentRecordRepository,
  InMemoryConversationRepository,
  InMemoryCoopScoreRepository,
  InMemoryCourseCompletionRepository,
  InMemoryCourseEnrolmentRepository,
  InMemoryCourseRepository,
  InMemoryCreditProfileRepository,
  InMemoryCreditScorecardRepository,
  InMemoryDisputeRepository,
  InMemoryDocumentRepository,
  InMemoryDsarRequestRepository,
  InMemoryEscrowRepository,
  InMemoryFarmPlotRepository,
  InMemoryFeatureFlagRepository,
  InMemoryFieldCheckRepository,
  InMemoryGrantApplicationRepository,
  InMemoryGroupBuyRepository,
  InMemoryGuardianLinkRepository,
  InMemoryHoldRepository,
  InMemoryIdempotencyRecordRepository,
  InMemoryIntegrationRepository,
  InMemoryInteropExchangeRepository,
  InMemoryLeaderboardEntryRepository,
  InMemoryLeaderboardSnapshotRepository,
  InMemoryLedgerAccountRepository,
  InMemoryLedgerEntryRepository,
  InMemoryLoanRepository,
  InMemoryMandateRepository,
  InMemoryMarketLinkRepository,
  InMemoryMarketplaceListingRepository,
  InMemoryMarketplaceOrderRepository,
  InMemoryMessageRepository,
  InMemoryNotificationDeliveryRepository,
  InMemoryNotificationRepository,
  InMemoryOfflineEnrolmentTaskRepository,
  InMemoryOpportunityRepository,
  InMemoryOtpChallengeRepository,
  InMemoryOutboxRepository,
  InMemoryPartnerMemberRepository,
  InMemoryPartnerRepository,
  InMemoryPaymentRepository,
  InMemoryPinProfileRepository,
  InMemoryPriceAlertRepository,
  InMemoryProcessingJobRepository,
  InMemoryProcessingRecordRepository,
  InMemoryProviderIntegrationRepository,
  InMemoryProvenanceAuditRepository,
  InMemoryPulseSubscriptionRepository,
  InMemoryReceiptRepository,
  InMemoryReconciliationExceptionRepository,
  InMemoryReconciliationReportRepository,
  InMemoryReferralRepository,
  InMemoryRegistryAnchorRepository,
  InMemoryRepaymentRepository,
  InMemoryReviewFlagRepository,
  InMemoryRewardTransactionRepository,
  InMemorySavingsGoalRepository,
  InMemorySellerProfileRepository,
  InMemorySettlementRepository,
  InMemoryStaffRepository,
  InMemoryStatementSnapshotRepository,
  InMemorySubmissionRepository,
  InMemorySuccessionClaimRepository,
  InMemorySurveyRepository,
  InMemoryTopicRepository,
  InMemoryTrainingModuleRepository,
  InMemoryUssdSessionRepository,
  InMemoryUserRepository,
  InMemoryVoucherRepository,
  InMemoryWarehouseRepository,
  InMemoryWebhookEventRepository
} from './repositories/index.js';
import type { ActivityFeedRepository } from './repositories/activity-feed.repository.js';
import type { AggregateRepository } from './repositories/aggregate.repository.js';
import type { AlertPreferenceRepository } from './repositories/alert-preference.repository.js';
import type { AntiFraudFlagRepository } from './repositories/anti-fraud-flag.repository.js';
import type { ApiProvenanceRepository } from './repositories/api-provenance.repository.js';
import type { AuditAnchorRepository } from './repositories/audit-anchor.repository.js';
import type { AuditRepository } from './repositories/audit.repository.js';
import type { AuthSessionRepository } from './repositories/auth-session.repository.js';
import type { BulkDisbursementRepository } from './repositories/bulk-disbursement.repository.js';
import type { CarbonCreditRepository } from './repositories/carbon-credit.repository.js';
import type { CarbonMilestoneRepository } from './repositories/carbon-milestone.repository.js';
import type { ChapterRepository } from './repositories/chapter.repository.js';
import type { CommodityPriceRepository } from './repositories/commodity-price.repository.js';
import type { ComplianceCaseRepository } from './repositories/compliance-case.repository.js';
import type { ConsentRecordRepository } from './repositories/consent-record.repository.js';
import type { ConversationRepository } from './repositories/conversation.repository.js';
import type { CoopScoreRepository } from './repositories/coop-score.repository.js';
import type { CourseCompletionRepository } from './repositories/course-completion.repository.js';
import type { CourseEnrolmentRepository } from './repositories/course-enrolment.repository.js';
import type { CourseRepository } from './repositories/course.repository.js';
import type { CreditProfileRepository } from './repositories/credit-profile.repository.js';
import type { CreditScorecardRepository } from './repositories/credit-scorecard.repository.js';
import type { DisputeRepository } from './repositories/dispute.repository.js';
import type { DocumentRepository } from './repositories/document.repository.js';
import type { DsarRequestRepository } from './repositories/dsar-request.repository.js';
import type { EscrowRepository } from './repositories/escrow.repository.js';
import type { FarmPlotRepository } from './repositories/farm-plot.repository.js';
import type { FeatureFlagRepository } from './repositories/feature-flag.repository.js';
import type { FieldCheckRepository } from './repositories/field-check.repository.js';
import type { GrantApplicationRepository } from './repositories/grant-application.repository.js';
import type { GroupBuyRepository } from './repositories/group-buy.repository.js';
import type { GuardianLinkRepository } from './repositories/guardian-link.repository.js';
import type { HoldRepository } from './repositories/hold.repository.js';
import type { IdempotencyRecordRepository } from './repositories/idempotency-record.repository.js';
import type { IntegrationRepository } from './repositories/integration.repository.js';
import type { InteropExchangeRepository } from './repositories/interop-exchange.repository.js';
import type { LeaderboardEntryRepository } from './repositories/leaderboard-entry.repository.js';
import type { LeaderboardSnapshotRepository } from './repositories/leaderboard-snapshot.repository.js';
import type { LedgerAccountRepository } from './repositories/ledger-account.repository.js';
import type { LedgerEntryRepository } from './repositories/ledger-entry.repository.js';
import type { LoanRepository } from './repositories/loan.repository.js';
import type { MandateRepository } from './repositories/mandate.repository.js';
import type { MarketLinkRepository } from './repositories/market-link.repository.js';
import type { MarketplaceListingRepository } from './repositories/marketplace-listing.repository.js';
import type { MarketplaceOrderRepository } from './repositories/marketplace-order.repository.js';
import type { MessageRepository } from './repositories/message.repository.js';
import type { NotificationDeliveryRepository } from './repositories/notification-delivery.repository.js';
import type { NotificationRepository } from './repositories/notification.repository.js';
import type { OfflineEnrolmentTaskRepository } from './repositories/offline-enrolment-task.repository.js';
import type { OpportunityRepository } from './repositories/opportunity.repository.js';
import type { OtpChallengeRepository } from './repositories/otp-challenge.repository.js';
import type { OutboxRepository } from './repositories/outbox.repository.js';
import type { PartnerMemberRepository } from './repositories/partner-member.repository.js';
import type { PartnerRepository } from './repositories/partner.repository.js';
import type { PaymentRepository } from './repositories/payment.repository.js';
import type { PinProfileRepository } from './repositories/pin-profile.repository.js';
import type { PriceAlertRepository } from './repositories/price-alert.repository.js';
import type { ProcessingJobRepository } from './repositories/processing-job.repository.js';
import type { ProcessingRecordRepository } from './repositories/processing-record.repository.js';
import type { ProviderIntegrationRepository } from './repositories/provider-integration.repository.js';
import type { ProvenanceAuditRepository } from './repositories/provenance-audit.repository.js';
import type { PulseSubscriptionRepository } from './repositories/pulse-subscription.repository.js';
import type { ReceiptRepository } from './repositories/receipt.repository.js';
import type { ReconciliationExceptionRepository } from './repositories/reconciliation-exception.repository.js';
import type { ReconciliationReportRepository } from './repositories/reconciliation-report.repository.js';
import type { ReferralRepository } from './repositories/referral.repository.js';
import type { RegistryAnchorRepository } from './repositories/registry-anchor.repository.js';
import type { RepaymentRepository } from './repositories/repayment.repository.js';
import type { ReviewFlagRepository } from './repositories/review-flag.repository.js';
import type { RewardTransactionRepository } from './repositories/reward-transaction.repository.js';
import type { SavingsGoalRepository } from './repositories/savings-goal.repository.js';
import type { SellerProfileRepository } from './repositories/seller-profile.repository.js';
import type { SettlementRepository } from './repositories/settlement.repository.js';
import type { StaffRepository } from './repositories/staff.repository.js';
import type { StatementSnapshotRepository } from './repositories/statement-snapshot.repository.js';
import type { SubmissionRepository } from './repositories/submission.repository.js';
import type { SuccessionClaimRepository } from './repositories/succession-claim.repository.js';
import type { SurveyRepository } from './repositories/survey.repository.js';
import type { TopicRepository } from './repositories/topic.repository.js';
import type { TrainingModuleRepository } from './repositories/training-module.repository.js';
import type { UssdSessionRepository } from './repositories/ussd-session.repository.js';
import type { UserRepository } from './repositories/user.repository.js';
import type { VoucherRepository } from './repositories/voucher.repository.js';
import type { WarehouseRepository } from './repositories/warehouse.repository.js';
import type { WebhookEventRepository } from './repositories/webhook-event.repository.js';
import { LocalStorageDriver, S3StorageDriver, type StorageDriver } from './storage-drivers.js';

export interface StorageResolution {
  driver: StorageDriver;
  /** True when the S3 driver is fully configured (credentials + endpoint present). */
  s3Active: boolean;
}

/**
 * WP-G15 storage driver resolution. STORAGE_DRIVER=s3 requires the full S3
 * credential set; any other flag (or none) keeps the local disk driver.
 * Fails closed: an explicit s3 flag with missing credentials falls back to
 * local rather than erroring at request time, so the API boots and the
 * missing config is visible via s3Active=false.
 */
export function resolveStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageResolution {
  const flag = (env.STORAGE_DRIVER ?? 'local').trim().toLowerCase();
  if (flag === 's3') {
    const endpoint = env.S3_ENDPOINT?.trim();
    const bucket = env.S3_BUCKET?.trim();
    const accessKey = env.S3_ACCESS_KEY?.trim();
    const secretKey = env.S3_SECRET_KEY?.trim();
    if (endpoint && bucket && accessKey && secretKey) {
      return {
        driver: new S3StorageDriver({ endpoint, bucket, accessKey, secretKey, region: env.S3_REGION }),
        s3Active: true
      };
    }
  }
  return { driver: new LocalStorageDriver(), s3Active: false };
}

export { DatabaseModule };

/**
 * DatabaseModule — persistence driver wiring (repository pattern §1).
 *
 * Persistence drivers (Postgres pool, S3-compatible object storage) live
 * behind repository interfaces; every consumer injects a repository token,
 * never the driver. Domain modules never import pg or fs directly.
 */
@Module({
  imports: [PostgresModule],
  providers: [
    {
      provide: USER_REPOSITORY,
      useFactory: (pgUser?: UserRepository): UserRepository =>
        pgUser ?? new InMemoryUserRepository(),
      inject: [{ token: 'PG_USER_REPOSITORY', optional: true }]
    },
    {
      provide: GUARDIAN_LINK_REPOSITORY,
      useFactory: (pg?: GuardianLinkRepository): GuardianLinkRepository =>
        pg ?? new InMemoryGuardianLinkRepository(),
      inject: [{ token: 'PG_GUARDIAN_LINK_REPOSITORY', optional: true }]
    },
    {
      provide: CHAPTER_REPOSITORY,
      useFactory: (pg?: ChapterRepository): ChapterRepository =>
        pg ?? new InMemoryChapterRepository(),
      inject: [{ token: 'PG_CHAPTER_REPOSITORY', optional: true }]
    },
    {
      provide: COURSE_REPOSITORY,
      useFactory: (pg?: CourseRepository): CourseRepository =>
        pg ?? new InMemoryCourseRepository(),
      inject: [{ token: 'PG_COURSE_REPOSITORY', optional: true }]
    },
    {
      provide: TRAINING_MODULE_REPOSITORY,
      useFactory: (pg?: TrainingModuleRepository): TrainingModuleRepository =>
        pg ?? new InMemoryTrainingModuleRepository(),
      inject: [{ token: 'PG_TRAINING_MODULE_REPOSITORY', optional: true }]
    },
    {
      provide: COURSE_ENROLMENT_REPOSITORY,
      useFactory: (pg?: CourseEnrolmentRepository): CourseEnrolmentRepository =>
        pg ?? new InMemoryCourseEnrolmentRepository(),
      inject: [{ token: 'PG_COURSE_ENROLMENT_REPOSITORY', optional: true }]
    },
    {
      provide: COURSE_COMPLETION_REPOSITORY,
      useFactory: (pg?: CourseCompletionRepository): CourseCompletionRepository =>
        pg ?? new InMemoryCourseCompletionRepository(),
      inject: [{ token: 'PG_COURSE_COMPLETION_REPOSITORY', optional: true }]
    },
    {
      provide: OPPORTUNITY_REPOSITORY,
      useFactory: (pg?: OpportunityRepository): OpportunityRepository =>
        pg ?? new InMemoryOpportunityRepository(),
      inject: [{ token: 'PG_OPPORTUNITY_REPOSITORY', optional: true }]
    },
    {
      provide: GRANT_APPLICATION_REPOSITORY,
      useFactory: (pg?: GrantApplicationRepository): GrantApplicationRepository =>
        pg ?? new InMemoryGrantApplicationRepository(),
      inject: [{ token: 'PG_GRANT_APPLICATION_REPOSITORY', optional: true }]
    },
    {
      provide: TOPIC_REPOSITORY,
      useFactory: (pg?: TopicRepository): TopicRepository => pg ?? new InMemoryTopicRepository(),
      inject: [{ token: 'PG_TOPIC_REPOSITORY', optional: true }]
    },
    {
      provide: REVIEW_FLAG_REPOSITORY,
      useFactory: (pg?: ReviewFlagRepository): ReviewFlagRepository =>
        pg ?? new InMemoryReviewFlagRepository(),
      inject: [{ token: 'PG_REVIEW_FLAG_REPOSITORY', optional: true }]
    },
    {
      provide: MESSAGE_REPOSITORY,
      useFactory: (pg?: MessageRepository): MessageRepository =>
        pg ?? new InMemoryMessageRepository(),
      inject: [{ token: 'PG_MESSAGE_REPOSITORY', optional: true }]
    },
    {
      provide: CONVERSATION_REPOSITORY,
      useFactory: (pg?: ConversationRepository): ConversationRepository =>
        pg ?? new InMemoryConversationRepository(),
      inject: [{ token: 'PG_CONVERSATION_REPOSITORY', optional: true }]
    },
    {
      provide: SELLER_PROFILE_REPOSITORY,
      useFactory: (pg?: SellerProfileRepository): SellerProfileRepository =>
        pg ?? new InMemorySellerProfileRepository(),
      inject: [{ token: 'PG_SELLER_PROFILE_REPOSITORY', optional: true }]
    },
    {
      provide: MARKETPLACE_LISTING_REPOSITORY,
      useFactory: (pg?: MarketplaceListingRepository): MarketplaceListingRepository =>
        pg ?? new InMemoryMarketplaceListingRepository(),
      inject: [{ token: 'PG_MARKETPLACE_LISTING_REPOSITORY', optional: true }]
    },
    {
      provide: MARKETPLACE_ORDER_REPOSITORY,
      useFactory: (pg?: MarketplaceOrderRepository): MarketplaceOrderRepository =>
        pg ?? new InMemoryMarketplaceOrderRepository(),
      inject: [{ token: 'PG_MARKETPLACE_ORDER_REPOSITORY', optional: true }]
    },
    {
      provide: GROUP_BUY_REPOSITORY,
      useFactory: (pg?: GroupBuyRepository): GroupBuyRepository =>
        pg ?? new InMemoryGroupBuyRepository(),
      inject: [{ token: 'PG_GROUP_BUY_REPOSITORY', optional: true }]
    },
    {
      provide: HOLD_REPOSITORY,
      useFactory: (pg?: HoldRepository): HoldRepository => pg ?? new InMemoryHoldRepository(),
      inject: [{ token: 'PG_HOLD_REPOSITORY', optional: true }]
    },
    {
      provide: LEDGER_ACCOUNT_REPOSITORY,
      useFactory: (pg?: LedgerAccountRepository): LedgerAccountRepository =>
        pg ?? new InMemoryLedgerAccountRepository(),
      inject: [{ token: 'PG_LEDGER_ACCOUNT_REPOSITORY', optional: true }]
    },
    {
      provide: LEDGER_ENTRY_REPOSITORY,
      useFactory: (pg?: LedgerEntryRepository): LedgerEntryRepository =>
        pg ?? new InMemoryLedgerEntryRepository(),
      inject: [{ token: 'PG_LEDGER_ENTRY_REPOSITORY', optional: true }]
    },
    {
      provide: SAVINGS_GOAL_REPOSITORY,
      useFactory: (pg?: SavingsGoalRepository): SavingsGoalRepository =>
        pg ?? new InMemorySavingsGoalRepository(),
      inject: [{ token: 'PG_SAVINGS_GOAL_REPOSITORY', optional: true }]
    },
    {
      provide: MANDATE_REPOSITORY,
      useFactory: (pg?: MandateRepository): MandateRepository =>
        pg ?? new InMemoryMandateRepository(),
      inject: [{ token: 'PG_MANDATE_REPOSITORY', optional: true }]
    },
    {
      provide: LOAN_REPOSITORY,
      useFactory: (pg?: LoanRepository): LoanRepository => pg ?? new InMemoryLoanRepository(),
      inject: [{ token: 'PG_LOAN_REPOSITORY', optional: true }]
    },
    {
      provide: REPAYMENT_REPOSITORY,
      useFactory: (pg?: RepaymentRepository): RepaymentRepository =>
        pg ?? new InMemoryRepaymentRepository(),
      inject: [{ token: 'PG_REPAYMENT_REPOSITORY', optional: true }]
    },
    {
      provide: PAYMENT_REPOSITORY,
      useFactory: (pg?: PaymentRepository): PaymentRepository =>
        pg ?? new InMemoryPaymentRepository(),
      inject: [{ token: 'PG_PAYMENT_REPOSITORY', optional: true }]
    },
    {
      provide: SETTLEMENT_REPOSITORY,
      useFactory: (pg?: SettlementRepository): SettlementRepository =>
        pg ?? new InMemorySettlementRepository(),
      inject: [{ token: 'PG_SETTLEMENT_REPOSITORY', optional: true }]
    },
    {
      provide: ESCROW_REPOSITORY,
      useFactory: (pg?: EscrowRepository): EscrowRepository =>
        pg ?? new InMemoryEscrowRepository(),
      inject: [{ token: 'PG_ESCROW_REPOSITORY', optional: true }]
    },
    {
      provide: DOCUMENT_REPOSITORY,
      useFactory: (pg?: DocumentRepository): DocumentRepository =>
        pg ?? new InMemoryDocumentRepository(),
      inject: [{ token: 'PG_DOCUMENT_REPOSITORY', optional: true }]
    },
    {
      provide: CREDIT_PROFILE_REPOSITORY,
      useFactory: (pg?: CreditProfileRepository): CreditProfileRepository =>
        pg ?? new InMemoryCreditProfileRepository(),
      inject: [{ token: 'PG_CREDIT_PROFILE_REPOSITORY', optional: true }]
    },
    {
      provide: CREDIT_SCORECARD_REPOSITORY,
      useFactory: (pg?: CreditScorecardRepository): CreditScorecardRepository =>
        pg ?? new InMemoryCreditScorecardRepository(),
      inject: [{ token: 'PG_CREDIT_SCORECARD_REPOSITORY', optional: true }]
    },
    {
      provide: VOUCHER_REPOSITORY,
      useFactory: (pg?: VoucherRepository): VoucherRepository =>
        pg ?? new InMemoryVoucherRepository(),
      inject: [{ token: 'PG_VOUCHER_REPOSITORY', optional: true }]
    },
    {
      provide: DISPUTE_REPOSITORY,
      useFactory: (pg?: DisputeRepository): DisputeRepository =>
        pg ?? new InMemoryDisputeRepository(),
      inject: [{ token: 'PG_DISPUTE_REPOSITORY', optional: true }]
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      useFactory: (pg?: NotificationRepository): NotificationRepository =>
        pg ?? new InMemoryNotificationRepository(),
      inject: [{ token: 'PG_NOTIFICATION_REPOSITORY', optional: true }]
    },
    {
      provide: NOTIFICATION_DELIVERY_REPOSITORY,
      useFactory: (pg?: NotificationDeliveryRepository): NotificationDeliveryRepository =>
        pg ?? new InMemoryNotificationDeliveryRepository(),
      inject: [{ token: 'PG_NOTIFICATION_DELIVERY_REPOSITORY', optional: true }]
    },
    {
      provide: ALERT_PREFERENCE_REPOSITORY,
      useFactory: (pg?: AlertPreferenceRepository): AlertPreferenceRepository =>
        pg ?? new InMemoryAlertPreferenceRepository(),
      inject: [{ token: 'PG_ALERT_PREFERENCE_REPOSITORY', optional: true }]
    },
    {
      provide: AUDIT_REPOSITORY,
      useFactory: (pg?: AuditRepository): AuditRepository => pg ?? new InMemoryAuditRepository(),
      inject: [{ token: 'PG_AUDIT_REPOSITORY', optional: true }]
    },
    {
      provide: AUDIT_ANCHOR_REPOSITORY,
      useFactory: (pg?: AuditAnchorRepository): AuditAnchorRepository =>
        pg ?? new InMemoryAuditAnchorRepository(),
      inject: [{ token: 'PG_AUDIT_ANCHOR_REPOSITORY', optional: true }]
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (pg?: OutboxRepository): OutboxRepository =>
        pg ?? new InMemoryOutboxRepository(),
      inject: [{ token: 'PG_OUTBOX_REPOSITORY', optional: true }]
    },
    {
      provide: FEATURE_FLAG_REPOSITORY,
      useFactory: (pg?: FeatureFlagRepository): FeatureFlagRepository =>
        pg ?? new InMemoryFeatureFlagRepository(),
      inject: [{ token: 'PG_FEATURE_FLAG_REPOSITORY', optional: true }]
    },
    {
      provide: API_PROVENANCE_REPOSITORY,
      useFactory: (pg?: ApiProvenanceRepository): ApiProvenanceRepository =>
        pg ?? new InMemoryApiProvenanceRepository(),
      inject: [{ token: 'PG_API_PROVENANCE_REPOSITORY', optional: true }]
    },
    {
      provide: INTEGRATION_REPOSITORY,
      useFactory: (pg?: IntegrationRepository): IntegrationRepository =>
        pg ?? new InMemoryIntegrationRepository(),
      inject: [{ token: 'PG_INTEGRATION_REPOSITORY', optional: true }]
    },
    {
      provide: WEBHOOK_EVENT_REPOSITORY,
      useFactory: (pg?: WebhookEventRepository): WebhookEventRepository =>
        pg ?? new InMemoryWebhookEventRepository(),
      inject: [{ token: 'PG_WEBHOOK_EVENT_REPOSITORY', optional: true }]
    },
    {
      provide: PROVIDER_INTEGRATION_REPOSITORY,
      useFactory: (pg?: ProviderIntegrationRepository): ProviderIntegrationRepository =>
        pg ?? new InMemoryProviderIntegrationRepository(),
      inject: [{ token: 'PG_PROVIDER_INTEGRATION_REPOSITORY', optional: true }]
    },
    {
      provide: COMPLIANCE_CASE_REPOSITORY,
      useFactory: (pg?: ComplianceCaseRepository): ComplianceCaseRepository =>
        pg ?? new InMemoryComplianceCaseRepository(),
      inject: [{ token: 'PG_COMPLIANCE_CASE_REPOSITORY', optional: true }]
    },
    {
      provide: INTEROP_EXCHANGE_REPOSITORY,
      useFactory: (pg?: InteropExchangeRepository): InteropExchangeRepository =>
        pg ?? new InMemoryInteropExchangeRepository(),
      inject: [{ token: 'PG_INTEROP_EXCHANGE_REPOSITORY', optional: true }]
    },
    {
      provide: COMMODITY_PRICE_REPOSITORY,
      useFactory: (pg?: CommodityPriceRepository): CommodityPriceRepository =>
        pg ?? new InMemoryCommodityPriceRepository(),
      inject: [{ token: 'PG_COMMODITY_PRICE_REPOSITORY', optional: true }]
    },
    {
      provide: RECEIPT_REPOSITORY,
      useFactory: (pg?: ReceiptRepository): ReceiptRepository =>
        pg ?? new InMemoryReceiptRepository(),
      inject: [{ token: 'PG_RECEIPT_REPOSITORY', optional: true }]
    },
    {
      provide: RECONCILIATION_REPORT_REPOSITORY,
      useFactory: (pg?: ReconciliationReportRepository): ReconciliationReportRepository =>
        pg ?? new InMemoryReconciliationReportRepository(),
      inject: [{ token: 'PG_RECONCILIATION_REPORT_REPOSITORY', optional: true }]
    },
    {
      provide: RECONCILIATION_EXCEPTION_REPOSITORY,
      useFactory: (pg?: ReconciliationExceptionRepository): ReconciliationExceptionRepository =>
        pg ?? new InMemoryReconciliationExceptionRepository(),
      inject: [{ token: 'PG_RECONCILIATION_EXCEPTION_REPOSITORY', optional: true }]
    },
    {
      provide: STATEMENT_SNAPSHOT_REPOSITORY,
      useFactory: (pg?: StatementSnapshotRepository): StatementSnapshotRepository =>
        pg ?? new InMemoryStatementSnapshotRepository(),
      inject: [{ token: 'PG_STATEMENT_SNAPSHOT_REPOSITORY', optional: true }]
    },
    {
      provide: REFERRAL_REPOSITORY,
      useFactory: (pg?: ReferralRepository): ReferralRepository =>
        pg ?? new InMemoryReferralRepository(),
      inject: [{ token: 'PG_REFERRAL_REPOSITORY', optional: true }]
    },
    {
      provide: ACTIVITY_FEED_REPOSITORY,
      useFactory: (pg?: ActivityFeedRepository): ActivityFeedRepository =>
        pg ?? new InMemoryActivityFeedRepository(),
      inject: [{ token: 'PG_ACTIVITY_FEED_REPOSITORY', optional: true }]
    },
    {
      provide: AUTH_SESSION_REPOSITORY,
      useFactory: (pg?: AuthSessionRepository): AuthSessionRepository =>
        pg ?? new InMemoryAuthSessionRepository(),
      inject: [{ token: 'PG_AUTH_SESSION_REPOSITORY', optional: true }]
    },
    {
      provide: PIN_PROFILE_REPOSITORY,
      useFactory: (pg?: PinProfileRepository): PinProfileRepository =>
        pg ?? new InMemoryPinProfileRepository(),
      inject: [{ token: 'PG_PIN_PROFILE_REPOSITORY', optional: true }]
    },
    {
      provide: USSD_SESSION_REPOSITORY,
      useFactory: (pg?: UssdSessionRepository): UssdSessionRepository =>
        pg ?? new InMemoryUssdSessionRepository(),
      inject: [{ token: 'PG_USSD_SESSION_REPOSITORY', optional: true }]
    },
    {
      provide: OTP_CHALLENGE_REPOSITORY,
      useFactory: (pg?: OtpChallengeRepository): OtpChallengeRepository =>
        pg ?? new InMemoryOtpChallengeRepository(),
      inject: [{ token: 'PG_OTP_CHALLENGE_REPOSITORY', optional: true }]
    },
    {
      provide: IDEMPOTENCY_RECORD_REPOSITORY,
      useFactory: (pg?: IdempotencyRecordRepository): IdempotencyRecordRepository =>
        pg ?? new InMemoryIdempotencyRecordRepository(),
      inject: [{ token: 'PG_IDEMPOTENCY_RECORD_REPOSITORY', optional: true }]
    },
    {
      provide: DSAR_REQUEST_REPOSITORY,
      useFactory: (pg?: DsarRequestRepository): DsarRequestRepository =>
        pg ?? new InMemoryDsarRequestRepository(),
      inject: [{ token: 'PG_DSAR_REQUEST_REPOSITORY', optional: true }]
    },
    {
      provide: CONSENT_RECORD_REPOSITORY,
      useFactory: (pg?: ConsentRecordRepository): ConsentRecordRepository =>
        pg ?? new InMemoryConsentRecordRepository(),
      inject: [{ token: 'PG_CONSENT_RECORD_REPOSITORY', optional: true }]
    },
    {
      provide: OFFLINE_ENROLMENT_TASK_REPOSITORY,
      useFactory: (pg?: OfflineEnrolmentTaskRepository): OfflineEnrolmentTaskRepository =>
        pg ?? new InMemoryOfflineEnrolmentTaskRepository(),
      inject: [{ token: 'PG_OFFLINE_ENROLMENT_TASK_REPOSITORY', optional: true }]
    },
    {
      provide: SURVEY_REPOSITORY,
      useFactory: (pg?: SurveyRepository): SurveyRepository =>
        pg ?? new InMemorySurveyRepository(),
      inject: [{ token: 'PG_SURVEY_REPOSITORY', optional: true }]
    },
    {
      provide: SUBMISSION_REPOSITORY,
      useFactory: (pg?: SubmissionRepository): SubmissionRepository =>
        pg ?? new InMemorySubmissionRepository(),
      inject: [{ token: 'PG_SUBMISSION_REPOSITORY', optional: true }]
    },
    {
      provide: FARM_PLOT_REPOSITORY,
      useFactory: (pg?: FarmPlotRepository): FarmPlotRepository =>
        pg ?? new InMemoryFarmPlotRepository(),
      inject: [{ token: 'PG_FARM_PLOT_REPOSITORY', optional: true }]
    },
    {
      provide: FIELD_CHECK_REPOSITORY,
      useFactory: (pg?: FieldCheckRepository): FieldCheckRepository =>
        pg ?? new InMemoryFieldCheckRepository(),
      inject: [{ token: 'PG_FIELD_CHECK_REPOSITORY', optional: true }]
    },
    {
      provide: LEADERBOARD_ENTRY_REPOSITORY,
      useFactory: (pg?: LeaderboardEntryRepository): LeaderboardEntryRepository =>
        pg ?? new InMemoryLeaderboardEntryRepository(),
      inject: [{ token: 'PG_LEADERBOARD_ENTRY_REPOSITORY', optional: true }]
    },
    {
      provide: LEADERBOARD_SNAPSHOT_REPOSITORY,
      useFactory: (pg?: LeaderboardSnapshotRepository): LeaderboardSnapshotRepository =>
        pg ?? new InMemoryLeaderboardSnapshotRepository(),
      inject: [{ token: 'PG_LEADERBOARD_SNAPSHOT_REPOSITORY', optional: true }]
    },
    {
      provide: REWARD_TRANSACTION_REPOSITORY,
      useFactory: (pg?: RewardTransactionRepository): RewardTransactionRepository =>
        pg ?? new InMemoryRewardTransactionRepository(),
      inject: [{ token: 'PG_REWARD_TRANSACTION_REPOSITORY', optional: true }]
    },
    {
      provide: STAFF_REPOSITORY,
      useFactory: (pg?: StaffRepository): StaffRepository => pg ?? new InMemoryStaffRepository(),
      inject: [{ token: 'PG_STAFF_REPOSITORY', optional: true }]
    },
    {
      provide: BULK_DISBURSEMENT_REPOSITORY,
      useFactory: (pg?: BulkDisbursementRepository): BulkDisbursementRepository =>
        pg ?? new InMemoryBulkDisbursementRepository(),
      inject: [{ token: 'PG_BULK_DISBURSEMENT_REPOSITORY', optional: true }]
    },
    {
      provide: ANTI_FRAUD_FLAG_REPOSITORY,
      useFactory: (pg?: AntiFraudFlagRepository): AntiFraudFlagRepository =>
        pg ?? new InMemoryAntiFraudFlagRepository(),
      inject: [{ token: 'PG_ANTI_FRAUD_FLAG_REPOSITORY', optional: true }]
    },
    {
      provide: CARBON_CREDIT_REPOSITORY,
      useFactory: (pg?: CarbonCreditRepository): CarbonCreditRepository =>
        pg ?? new InMemoryCarbonCreditRepository(),
      inject: [{ token: 'PG_CARBON_CREDIT_REPOSITORY', optional: true }]
    },
    {
      provide: CARBON_MILESTONE_REPOSITORY,
      useFactory: (pg?: CarbonMilestoneRepository): CarbonMilestoneRepository =>
        pg ?? new InMemoryCarbonMilestoneRepository(),
      inject: [{ token: 'PG_CARBON_MILESTONE_REPOSITORY', optional: true }]
    },
    {
      provide: REGISTRY_ANCHOR_REPOSITORY,
      useFactory: (pg?: RegistryAnchorRepository): RegistryAnchorRepository =>
        pg ?? new InMemoryRegistryAnchorRepository(),
      inject: [{ token: 'PG_REGISTRY_ANCHOR_REPOSITORY', optional: true }]
    },
    {
      provide: AGGREGATE_REPOSITORY,
      useFactory: (pg?: AggregateRepository): AggregateRepository =>
        pg ?? new InMemoryAggregateRepository(),
      inject: [{ token: 'PG_AGGREGATE_REPOSITORY', optional: true }]
    },
    {
      provide: PARTNER_REPOSITORY,
      useFactory: (pg?: PartnerRepository): PartnerRepository =>
        pg ?? new InMemoryPartnerRepository(),
      inject: [{ token: 'PG_PARTNER_REPOSITORY', optional: true }]
    },
    {
      provide: PARTNER_MEMBER_REPOSITORY,
      useFactory: (pg?: PartnerMemberRepository): PartnerMemberRepository =>
        pg ?? new InMemoryPartnerMemberRepository(),
      inject: [{ token: 'PG_PARTNER_MEMBER_REPOSITORY', optional: true }]
    },
    {
      provide: MARKET_LINK_REPOSITORY,
      useFactory: (pg?: MarketLinkRepository): MarketLinkRepository =>
        pg ?? new InMemoryMarketLinkRepository(),
      inject: [{ token: 'PG_MARKET_LINK_REPOSITORY', optional: true }]
    },
    {
      provide: PROCESSING_RECORD_REPOSITORY,
      useFactory: (pg?: ProcessingRecordRepository): ProcessingRecordRepository =>
        pg ?? new InMemoryProcessingRecordRepository(),
      inject: [{ token: 'PG_PROCESSING_RECORD_REPOSITORY', optional: true }]
    },
    {
      provide: PROCESSING_JOB_REPOSITORY,
      useFactory: (pg?: ProcessingJobRepository): ProcessingJobRepository =>
        pg ?? new InMemoryProcessingJobRepository(),
      inject: [{ token: 'PG_PROCESSING_JOB_REPOSITORY', optional: true }]
    },
    {
      provide: WAREHOUSE_REPOSITORY,
      useFactory: (pg?: WarehouseRepository): WarehouseRepository =>
        pg ?? new InMemoryWarehouseRepository(),
      inject: [{ token: 'PG_WAREHOUSE_REPOSITORY', optional: true }]
    },
    {
      provide: PULSE_SUBSCRIPTION_REPOSITORY,
      useFactory: (pg?: PulseSubscriptionRepository): PulseSubscriptionRepository =>
        pg ?? new InMemoryPulseSubscriptionRepository(),
      inject: [{ token: 'PG_PULSE_SUBSCRIPTION_REPOSITORY', optional: true }]
    },
    {
      provide: PRICE_ALERT_REPOSITORY,
      useFactory: (pg?: PriceAlertRepository): PriceAlertRepository =>
        pg ?? new InMemoryPriceAlertRepository(),
      inject: [{ token: 'PG_PRICE_ALERT_REPOSITORY', optional: true }]
    },
    {
      provide: PROVENANCE_AUDIT_REPOSITORY,
      useFactory: (pg?: ProvenanceAuditRepository): ProvenanceAuditRepository =>
        pg ?? new InMemoryProvenanceAuditRepository(),
      inject: [{ token: 'PG_PROVENANCE_AUDIT_REPOSITORY', optional: true }]
    },
    {
      provide: SUCCESSION_CLAIM_REPOSITORY,
      useFactory: (pg?: SuccessionClaimRepository): SuccessionClaimRepository =>
        pg ?? new InMemorySuccessionClaimRepository(),
      inject: [{ token: 'PG_SUCCESSION_CLAIM_REPOSITORY', optional: true }]
    },
    {
      provide: COOP_SCORE_REPOSITORY,
      useFactory: (pg?: CoopScoreRepository): CoopScoreRepository =>
        pg ?? new InMemoryCoopScoreRepository(),
      inject: [{ token: 'PG_COOP_SCORE_REPOSITORY', optional: true }]
    },
    {
      provide: STORAGE_DRIVER,
      useFactory: (): StorageDriver => resolveStorageDriver().driver
    }
  ],
  exports: [
    USER_REPOSITORY,
    GUARDIAN_LINK_REPOSITORY,
    CHAPTER_REPOSITORY,
    COURSE_REPOSITORY,
    TRAINING_MODULE_REPOSITORY,
    COURSE_ENROLMENT_REPOSITORY,
    COURSE_COMPLETION_REPOSITORY,
    OPPORTUNITY_REPOSITORY,
    GRANT_APPLICATION_REPOSITORY,
    TOPIC_REPOSITORY,
    REVIEW_FLAG_REPOSITORY,
    MESSAGE_REPOSITORY,
    CONVERSATION_REPOSITORY,
    SELLER_PROFILE_REPOSITORY,
    MARKETPLACE_LISTING_REPOSITORY,
    MARKETPLACE_ORDER_REPOSITORY,
    GROUP_BUY_REPOSITORY,
    HOLD_REPOSITORY,
    LEDGER_ACCOUNT_REPOSITORY,
    LEDGER_ENTRY_REPOSITORY,
    SAVINGS_GOAL_REPOSITORY,
    MANDATE_REPOSITORY,
    LOAN_REPOSITORY,
    REPAYMENT_REPOSITORY,
    PAYMENT_REPOSITORY,
    SETTLEMENT_REPOSITORY,
    ESCROW_REPOSITORY,
    DOCUMENT_REPOSITORY,
    CREDIT_PROFILE_REPOSITORY,
    CREDIT_SCORECARD_REPOSITORY,
    VOUCHER_REPOSITORY,
    DISPUTE_REPOSITORY,
    NOTIFICATION_REPOSITORY,
    NOTIFICATION_DELIVERY_REPOSITORY,
    ALERT_PREFERENCE_REPOSITORY,
    AUDIT_REPOSITORY,
    AUDIT_ANCHOR_REPOSITORY,
    OUTBOX_REPOSITORY,
    FEATURE_FLAG_REPOSITORY,
    API_PROVENANCE_REPOSITORY,
    INTEGRATION_REPOSITORY,
    WEBHOOK_EVENT_REPOSITORY,
    PROVIDER_INTEGRATION_REPOSITORY,
    COMPLIANCE_CASE_REPOSITORY,
    INTEROP_EXCHANGE_REPOSITORY,
    COMMODITY_PRICE_REPOSITORY,
    RECEIPT_REPOSITORY,
    RECONCILIATION_REPORT_REPOSITORY,
    RECONCILIATION_EXCEPTION_REPOSITORY,
    STATEMENT_SNAPSHOT_REPOSITORY,
    REFERRAL_REPOSITORY,
    ACTIVITY_FEED_REPOSITORY,
    AUTH_SESSION_REPOSITORY,
    PIN_PROFILE_REPOSITORY,
    USSD_SESSION_REPOSITORY,
    OTP_CHALLENGE_REPOSITORY,
    IDEMPOTENCY_RECORD_REPOSITORY,
    DSAR_REQUEST_REPOSITORY,
    CONSENT_RECORD_REPOSITORY,
    OFFLINE_ENROLMENT_TASK_REPOSITORY,
    SURVEY_REPOSITORY,
    SUBMISSION_REPOSITORY,
    FARM_PLOT_REPOSITORY,
    FIELD_CHECK_REPOSITORY,
    LEADERBOARD_ENTRY_REPOSITORY,
    LEADERBOARD_SNAPSHOT_REPOSITORY,
    REWARD_TRANSACTION_REPOSITORY,
    STAFF_REPOSITORY,
    BULK_DISBURSEMENT_REPOSITORY,
    ANTI_FRAUD_FLAG_REPOSITORY,
    CARBON_CREDIT_REPOSITORY,
    CARBON_MILESTONE_REPOSITORY,
    REGISTRY_ANCHOR_REPOSITORY,
    AGGREGATE_REPOSITORY,
    PARTNER_REPOSITORY,
    PARTNER_MEMBER_REPOSITORY,
    MARKET_LINK_REPOSITORY,
    PROCESSING_RECORD_REPOSITORY,
    PROCESSING_JOB_REPOSITORY,
    WAREHOUSE_REPOSITORY,
    PULSE_SUBSCRIPTION_REPOSITORY,
    PRICE_ALERT_REPOSITORY,
    PROVENANCE_AUDIT_REPOSITORY,
    SUCCESSION_CLAIM_REPOSITORY,
    COOP_SCORE_REPOSITORY,
    STORAGE_DRIVER
  ]
})
class DatabaseModuleImpl {}

// OB-10 wiring: PG_* optional tokens are registered by PostgresModule when
// DATABASE_URL is set (registerPostgresRepositories); otherwise each token
// falls back to the in-memory implementation so the API boots for dev/test.
export { DatabaseModuleImpl as DatabaseModule };
