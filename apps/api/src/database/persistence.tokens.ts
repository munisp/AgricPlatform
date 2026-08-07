/**
 * DI tokens for the persistence wave. Repositories are provided by the
 * global DatabaseModule; stores and the Redis client by the global
 * RedisModule. Services inject the port interfaces behind these tokens so
 * the in-memory and PostgreSQL implementations stay swappable by config.
 */
export const PG_POOL = Symbol('PG_POOL');

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');
export const CONSENT_REPOSITORY = Symbol('CONSENT_REPOSITORY');
export const DELETION_REQUEST_REPOSITORY = Symbol('DELETION_REQUEST_REPOSITORY');
export const COURSE_REPOSITORY = Symbol('COURSE_REPOSITORY');
export const ENROLMENT_REPOSITORY = Symbol('ENROLMENT_REPOSITORY');
export const CERTIFICATE_REPOSITORY = Symbol('CERTIFICATE_REPOSITORY');
export const FORUM_TOPIC_REPOSITORY = Symbol('FORUM_TOPIC_REPOSITORY');
export const MENTOR_REQUEST_REPOSITORY = Symbol('MENTOR_REQUEST_REPOSITORY');
export const TOPIC_FLAG_REPOSITORY = Symbol('TOPIC_FLAG_REPOSITORY');
export const OPPORTUNITY_REPOSITORY = Symbol('OPPORTUNITY_REPOSITORY');
export const APPLICATION_REPOSITORY = Symbol('APPLICATION_REPOSITORY');
export const CHAPTER_REPOSITORY = Symbol('CHAPTER_REPOSITORY');
export const CHAPTER_EVENT_REPOSITORY = Symbol('CHAPTER_EVENT_REPOSITORY');
export const EVENT_RSVP_REPOSITORY = Symbol('EVENT_RSVP_REPOSITORY');
export const ANNOUNCEMENT_REPOSITORY = Symbol('ANNOUNCEMENT_REPOSITORY');
export const ADVISORY_REPOSITORY = Symbol('ADVISORY_REPOSITORY');
export const LISTING_REPOSITORY = Symbol('LISTING_REPOSITORY');
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const REVIEW_REPOSITORY = Symbol('REVIEW_REPOSITORY');
export const CREDIT_PROFILE_REPOSITORY = Symbol('CREDIT_PROFILE_REPOSITORY');
export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NOTIFICATION_PREFERENCE_REPOSITORY');
export const DELIVERY_LOG_REPOSITORY = Symbol('DELIVERY_LOG_REPOSITORY');
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
export const COMMODITY_PRICE_REPOSITORY = Symbol('COMMODITY_PRICE_REPOSITORY');

// Engagement wave (P2b): services marketplace, programmes, pathways, knowledge, search depth.
export const SUPPLIER_REPOSITORY = Symbol('SUPPLIER_REPOSITORY');
export const SERVICE_OFFERING_REPOSITORY = Symbol('SERVICE_OFFERING_REPOSITORY');
export const SERVICE_BOOKING_REPOSITORY = Symbol('SERVICE_BOOKING_REPOSITORY');
export const SERVICE_REVIEW_REPOSITORY = Symbol('SERVICE_REVIEW_REPOSITORY');
export const PROGRAMME_COHORT_REPOSITORY = Symbol('PROGRAMME_COHORT_REPOSITORY');
export const PROGRAMME_ENROLMENT_REPOSITORY = Symbol('PROGRAMME_ENROLMENT_REPOSITORY');
export const PROGRAMME_MILESTONE_REPOSITORY = Symbol('PROGRAMME_MILESTONE_REPOSITORY');
export const MILESTONE_PROGRESS_REPOSITORY = Symbol('MILESTONE_PROGRESS_REPOSITORY');
export const RUBRIC_CRITERION_REPOSITORY = Symbol('RUBRIC_CRITERION_REPOSITORY');
export const JUDGE_ASSIGNMENT_REPOSITORY = Symbol('JUDGE_ASSIGNMENT_REPOSITORY');
export const JUDGE_SCORE_REPOSITORY = Symbol('JUDGE_SCORE_REPOSITORY');
export const COHORT_THREAD_REPOSITORY = Symbol('COHORT_THREAD_REPOSITORY');
export const COHORT_THREAD_POST_REPOSITORY = Symbol('COHORT_THREAD_POST_REPOSITORY');
export const PATHWAY_TEMPLATE_REPOSITORY = Symbol('PATHWAY_TEMPLATE_REPOSITORY');
export const PATHWAY_STAGE_REPOSITORY = Symbol('PATHWAY_STAGE_REPOSITORY');
export const PATHWAY_ENROLMENT_REPOSITORY = Symbol('PATHWAY_ENROLMENT_REPOSITORY');
export const STAGE_PROGRESS_REPOSITORY = Symbol('STAGE_PROGRESS_REPOSITORY');
export const CAMPUS_CLUB_REPOSITORY = Symbol('CAMPUS_CLUB_REPOSITORY');
export const CAMPUS_CLUB_MEMBERSHIP_REPOSITORY = Symbol('CAMPUS_CLUB_MEMBERSHIP_REPOSITORY');
export const KNOWLEDGE_RESOURCE_REPOSITORY = Symbol('KNOWLEDGE_RESOURCE_REPOSITORY');
export const PODCAST_EPISODE_REPOSITORY = Symbol('PODCAST_EPISODE_REPOSITORY');
export const WEBINAR_REPOSITORY = Symbol('WEBINAR_REPOSITORY');
export const WEBINAR_REGISTRATION_REPOSITORY = Symbol('WEBINAR_REGISTRATION_REPOSITORY');
export const SEARCH_QUERY_REPOSITORY = Symbol('SEARCH_QUERY_REPOSITORY');
// Wave P5c: recommendation feedback + analytics data marts.
export const RECOMMENDATION_FEEDBACK_REPOSITORY = Symbol('RECOMMENDATION_FEEDBACK_REPOSITORY');
export const ANALYTICS_MART_REPOSITORY = Symbol('ANALYTICS_MART_REPOSITORY');

// Wave P2a: marketplace depth (escrow/invoicing/logistics) + finance/credit.
export const ESCROW_REPOSITORY = Symbol('ESCROW_REPOSITORY');
export const INVOICE_REPOSITORY = Symbol('INVOICE_REPOSITORY');
export const SHIPMENT_REPOSITORY = Symbol('SHIPMENT_REPOSITORY');
export const LEDGER_ACCOUNT_REPOSITORY = Symbol('LEDGER_ACCOUNT_REPOSITORY');
export const LEDGER_ENTRY_REPOSITORY = Symbol('LEDGER_ENTRY_REPOSITORY');
export const CREDIT_SCORE_REPOSITORY = Symbol('CREDIT_SCORE_REPOSITORY');
export const LENDER_REPOSITORY = Symbol('LENDER_REPOSITORY');
export const LOAN_APPLICATION_REPOSITORY = Symbol('LOAN_APPLICATION_REPOSITORY');
export const REPAYMENT_SCHEDULE_REPOSITORY = Symbol('REPAYMENT_SCHEDULE_REPOSITORY');

// Wave P5a: Phase-3 federated integrations (external links, farm records,
// beneficiary imports, inbound event ledger).
export const EXTERNAL_ACCOUNT_LINK_REPOSITORY = Symbol('EXTERNAL_ACCOUNT_LINK_REPOSITORY');
export const FARM_RECORD_REPOSITORY = Symbol('FARM_RECORD_REPOSITORY');
export const IMPORT_BATCH_REPOSITORY = Symbol('IMPORT_BATCH_REPOSITORY');
export const IMPORT_RECORD_REPOSITORY = Symbol('IMPORT_RECORD_REPOSITORY');
export const INBOUND_EVENT_REPOSITORY = Symbol('INBOUND_EVENT_REPOSITORY');
// Wave P5b: USSD channel + shared-device PIN profiles.
export const USSD_SESSION_REPOSITORY = Symbol('USSD_SESSION_REPOSITORY');
export const PIN_PROFILE_REPOSITORY = Symbol('PIN_PROFILE_REPOSITORY');
// Wave P5d: partner API (OAuth clients, developer API keys, webhooks).
export const PARTNER_CLIENT_REPOSITORY = Symbol('PARTNER_CLIENT_REPOSITORY');
export const API_KEY_REPOSITORY = Symbol('API_KEY_REPOSITORY');
export const WEBHOOK_SUBSCRIPTION_REPOSITORY = Symbol('WEBHOOK_SUBSCRIPTION_REPOSITORY');
// Wave P6a: IVR voice channel.
export const IVR_CALL_REPOSITORY = Symbol('IVR_CALL_REPOSITORY');
// Wave L1a: ALTP livestock core (animals, lots, transfers, pastoralists).
export const ANIMAL_REPOSITORY = Symbol('ANIMAL_REPOSITORY');
export const LOT_REPOSITORY = Symbol('LOT_REPOSITORY');
export const OWNERSHIP_TRANSFER_REPOSITORY = Symbol('OWNERSHIP_TRANSFER_REPOSITORY');
export const PASTORALIST_PROFILE_REPOSITORY = Symbol('PASTORALIST_PROFILE_REPOSITORY');
// Wave L1c: ALTP trade, finance, compliance + partner aggregation.
export const CERTIFIED_LISTING_REPOSITORY = Symbol('CERTIFIED_LISTING_REPOSITORY');
export const OFFTAKE_TEMPLATE_REPOSITORY = Symbol('OFFTAKE_TEMPLATE_REPOSITORY');
export const OFFTAKE_CONTRACT_REPOSITORY = Symbol('OFFTAKE_CONTRACT_REPOSITORY');
export const EXPORT_DOCUMENT_REPOSITORY = Symbol('EXPORT_DOCUMENT_REPOSITORY');
export const LIEN_REPOSITORY = Symbol('LIEN_REPOSITORY');
export const INSURANCE_POLICY_REPOSITORY = Symbol('INSURANCE_POLICY_REPOSITORY');
export const INSURANCE_CLAIM_REPOSITORY = Symbol('INSURANCE_CLAIM_REPOSITORY');
export const DISBURSEMENT_REPOSITORY = Symbol('DISBURSEMENT_REPOSITORY');
export const AGGREGATION_POINT_REPOSITORY = Symbol('AGGREGATION_POINT_REPOSITORY');
export const COLD_CHAIN_LOG_REPOSITORY = Symbol('COLD_CHAIN_LOG_REPOSITORY');
// Optional transfer guard port consulted by LivestockService.transferAnimal
// (lien-backed implementation; see livestock-trade module).
export const LIVESTOCK_TRANSFER_GUARD = Symbol('LIVESTOCK_TRANSFER_GUARD');
// External provider adapters (fail-closed stubs without configuration).
export const LIVESTOCK_INSURANCE_PROVIDER = Symbol('LIVESTOCK_INSURANCE_PROVIDER');
export const COLD_CHAIN_PROVIDER = Symbol('COLD_CHAIN_PROVIDER');
// Wave P: commodity price signal provider (fail-closed 503 when unconfigured).
export const COMMODITY_PRICE_PROVIDER = Symbol('COMMODITY_PRICE_PROVIDER');

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const KEY_VALUE_STORE = Symbol('KEY_VALUE_STORE');
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
export const OTP_STORE = Symbol('OTP_STORE');
// Funds-integrity wave: durable provider-webhook dedupe (integrations.inbound_events).
export const WEBHOOK_DEDUPE_STORE = Symbol('WEBHOOK_DEDUPE_STORE');
// Wave L1b: ALTP animal health, movement traceability, recall, surveillance.
export const HEALTH_RECORD_REPOSITORY = Symbol('HEALTH_RECORD_REPOSITORY');
export const MOVEMENT_REPOSITORY = Symbol('MOVEMENT_REPOSITORY');
export const MOVEMENT_PERMIT_REPOSITORY = Symbol('MOVEMENT_PERMIT_REPOSITORY');
export const RECALL_REPOSITORY = Symbol('RECALL_REPOSITORY');
export const DISEASE_FLAG_REPOSITORY = Symbol('DISEASE_FLAG_REPOSITORY');
// Wave M: marketplace commerce depth (variants, promotions, price lists,
// buyer groups, order extensions, returns, draft orders, reviews/ratings).
export const LISTING_VARIANT_REPOSITORY = Symbol('LISTING_VARIANT_REPOSITORY');
export const BUYER_GROUP_REPOSITORY = Symbol('BUYER_GROUP_REPOSITORY');
export const BUYER_GROUP_MEMBERSHIP_REPOSITORY = Symbol('BUYER_GROUP_MEMBERSHIP_REPOSITORY');
export const PRICE_LIST_REPOSITORY = Symbol('PRICE_LIST_REPOSITORY');
export const PRICE_LIST_ENTRY_REPOSITORY = Symbol('PRICE_LIST_ENTRY_REPOSITORY');
export const PROMOTION_REPOSITORY = Symbol('PROMOTION_REPOSITORY');
export const PROMOTION_REDEMPTION_REPOSITORY = Symbol('PROMOTION_REDEMPTION_REPOSITORY');
export const ORDER_EXTENSION_REPOSITORY = Symbol('ORDER_EXTENSION_REPOSITORY');
export const RETURN_REQUEST_REPOSITORY = Symbol('RETURN_REQUEST_REPOSITORY');
export const DRAFT_ORDER_REPOSITORY = Symbol('DRAFT_ORDER_REPOSITORY');
export const PRODUCT_REVIEW_REPOSITORY = Symbol('PRODUCT_REVIEW_REPOSITORY');
export const SELLER_RATING_REPOSITORY = Symbol('SELLER_RATING_REPOSITORY');

// Wave P: platform foundation (sessions, feature flags, consumer dedup).
export const AUTH_SESSION_REPOSITORY = Symbol('AUTH_SESSION_REPOSITORY');
export const FEATURE_FLAG_REPOSITORY = Symbol('FEATURE_FLAG_REPOSITORY');
export const PROCESSED_EVENT_REPOSITORY = Symbol('PROCESSED_EVENT_REPOSITORY');

// Wave B: analytics star-schema marts (analytics schema, migration 019).
export const ANALYTICS_STAR_REPOSITORY = Symbol('ANALYTICS_STAR_REPOSITORY');

// Wave COMP: NDPA 2023 compliance tooling (compliance schema, migration 021).
export const COMPLIANCE_CONSENT_REPOSITORY = Symbol('COMPLIANCE_CONSENT_REPOSITORY');
export const DATA_SUBJECT_REQUEST_REPOSITORY = Symbol('DATA_SUBJECT_REQUEST_REPOSITORY');
export const RETENTION_POLICY_REPOSITORY = Symbol('RETENTION_POLICY_REPOSITORY');

// Wave SYNCSRV: record-level offline sync protocol v1 (sync schema, migration 024).
export const ENTITY_VERSION_REPOSITORY = Symbol('ENTITY_VERSION_REPOSITORY');
export const SYNC_CURSOR_REPOSITORY = Symbol('SYNC_CURSOR_REPOSITORY');
export const SYNC_MUTATION_REPOSITORY = Symbol('SYNC_MUTATION_REPOSITORY');
// Wave FARMS: farms & crop-production (farms schema, migration 022).
export const FARM_PLOT_REPOSITORY = Symbol('FARM_PLOT_REPOSITORY');
export const CROP_PLANTING_REPOSITORY = Symbol('CROP_PLANTING_REPOSITORY');
export const HARVEST_RECORD_REPOSITORY = Symbol('HARVEST_RECORD_REPOSITORY');
export const FARM_EXPENSE_REPOSITORY = Symbol('FARM_EXPENSE_REPOSITORY');
// Wave AGENTS: field-agent (enumerator) assignments + activity trail
// (agents schema, migration 023).
export const AGENT_ASSIGNMENT_REPOSITORY = Symbol('AGENT_ASSIGNMENT_REPOSITORY');
export const AGENT_ACTIVITY_LOG_REPOSITORY = Symbol('AGENT_ACTIVITY_LOG_REPOSITORY');
// Wave GEO: geospatial pack — H3 cell index + named boundaries (geo schema,
// migration 026). No PostGIS: cells are computed in the app layer (h3-js).
export const H3_INDEX_REPOSITORY = Symbol('H3_INDEX_REPOSITORY');
export const GEO_BOUNDARY_REPOSITORY = Symbol('GEO_BOUNDARY_REPOSITORY');

// Wave VOICE: voice agronomist — IVR/USSD RAG advisory sessions, transcript
// turns and the agent-escalation queue (voice schema, migration 027).
export const VOICE_SESSION_REPOSITORY = Symbol('VOICE_SESSION_REPOSITORY');
export const VOICE_TURN_REPOSITORY = Symbol('VOICE_TURN_REPOSITORY');
export const AGENT_CASE_REPOSITORY = Symbol('AGENT_CASE_REPOSITORY');

// Wave CREDIT: microfinance suite (loan products/applications, repayments,
// collateral, guarantors, VSLA groups, savings) — schema `credit`.
export const CREDIT_PRODUCT_REPOSITORY = Symbol('CREDIT_PRODUCT_REPOSITORY');
export const CREDIT_LOAN_REPOSITORY = Symbol('CREDIT_LOAN_REPOSITORY');
export const CREDIT_REPAYMENT_REPOSITORY = Symbol('CREDIT_REPAYMENT_REPOSITORY');
export const CREDIT_COLLATERAL_REPOSITORY = Symbol('CREDIT_COLLATERAL_REPOSITORY');
export const CREDIT_GUARANTOR_REPOSITORY = Symbol('CREDIT_GUARANTOR_REPOSITORY');
export const CREDIT_GROUP_REPOSITORY = Symbol('CREDIT_GROUP_REPOSITORY');
export const CREDIT_GROUP_MEMBER_REPOSITORY = Symbol('CREDIT_GROUP_MEMBER_REPOSITORY');
export const CREDIT_SAVINGS_ACCOUNT_REPOSITORY = Symbol('CREDIT_SAVINGS_ACCOUNT_REPOSITORY');
export const CREDIT_SAVINGS_TRANSACTION_REPOSITORY = Symbol('CREDIT_SAVINGS_TRANSACTION_REPOSITORY');

// Wave EUDR: traceability passport — commodity lots, append-only custody
// hash chain, immutable plot snapshots, shipments (traceability schema,
// migrations 029/030).
export const COMMODITY_LOT_REPOSITORY = Symbol('COMMODITY_LOT_REPOSITORY');
export const CUSTODY_EVENT_REPOSITORY = Symbol('CUSTODY_EVENT_REPOSITORY');
export const LOT_PLOT_LINK_REPOSITORY = Symbol('LOT_PLOT_LINK_REPOSITORY');
export const TRACEABILITY_SHIPMENT_REPOSITORY = Symbol('TRACEABILITY_SHIPMENT_REPOSITORY');
// Wave GEOCREDIT: geo-verified credit SHADOW scores (credit schema, migration
// 028). Shadow mode only — the live decision path never injects this token.
export const GEO_CREDIT_SHADOW_REPOSITORY = Symbol('GEO_CREDIT_SHADOW_REPOSITORY');

// Wave AGENTBANK: agent banking (agent registry, float top-up workflow,
// signed offline vouchers, agent transaction log) — schema `agent_banking`,
// migration 032. Money movement stays in the finance ledger; these tables
// hold operational records only.
export const AGENT_BANKING_AGENT_REPOSITORY = Symbol('AGENT_BANKING_AGENT_REPOSITORY');
export const AGENT_FLOAT_TOPUP_REPOSITORY = Symbol('AGENT_FLOAT_TOPUP_REPOSITORY');
export const AGENT_VOUCHER_REPOSITORY = Symbol('AGENT_VOUCHER_REPOSITORY');
export const AGENT_TRANSACTION_REPOSITORY = Symbol('AGENT_TRANSACTION_REPOSITORY');
// Wave MECHANIZATION: equipment hire marketplace (mechanization schema,
// migration 033) — listings with H3 service areas + the booking workflow.
export const EQUIPMENT_LISTING_REPOSITORY = Symbol('EQUIPMENT_LISTING_REPOSITORY');
export const EQUIPMENT_BOOKING_REPOSITORY = Symbol('EQUIPMENT_BOOKING_REPOSITORY');

// Wave-INSURANCE: parametric insurance rail (insurance schema, migration 031).
// Distinct from the livestock-trade INSURANCE_POLICY_REPOSITORY (animal
// mortality cover); these are the plot-level parametric products/policies.
export const PARAMETRIC_PRODUCT_REPOSITORY = Symbol('PARAMETRIC_PRODUCT_REPOSITORY');
export const PARAMETRIC_POLICY_REPOSITORY = Symbol('PARAMETRIC_POLICY_REPOSITORY');
export const PARAMETRIC_TRIGGER_EVENT_REPOSITORY = Symbol('PARAMETRIC_TRIGGER_EVENT_REPOSITORY');
export const PARAMETRIC_PAYOUT_REPOSITORY = Symbol('PARAMETRIC_PAYOUT_REPOSITORY');

// Wave NINVOUCHER: NIN-linked input subsidy e-vouchers (input_vouchers
// schema, migration 035) — programmes, NIN-verified beneficiaries (hash +
// mask only, never plaintext), vouchers, redemptions. Money movement stays
// in the finance ledger; these tables hold operational records only.
export const INPUT_VOUCHER_PROGRAMME_REPOSITORY = Symbol('INPUT_VOUCHER_PROGRAMME_REPOSITORY');
export const BENEFICIARY_REPOSITORY = Symbol('BENEFICIARY_REPOSITORY');
export const INPUT_VOUCHER_REPOSITORY = Symbol('INPUT_VOUCHER_REPOSITORY');
export const INPUT_VOUCHER_REDEMPTION_REPOSITORY = Symbol('INPUT_VOUCHER_REDEMPTION_REPOSITORY');
// Wave WAREHOUSE: electronic warehouse receipts (warehouse schema, migration
// 034) — certified warehouse registry, deposits/grading, signed receipts,
// pledge liens, ownership-transfer audit trail. Money stays in the finance
// ledger; these are operational records only.
export const CERTIFIED_WAREHOUSE_REPOSITORY = Symbol('CERTIFIED_WAREHOUSE_REPOSITORY');
export const WAREHOUSE_DEPOSIT_REPOSITORY = Symbol('WAREHOUSE_DEPOSIT_REPOSITORY');
export const WAREHOUSE_RECEIPT_REPOSITORY = Symbol('WAREHOUSE_RECEIPT_REPOSITORY');
export const WAREHOUSE_PLEDGE_REPOSITORY = Symbol('WAREHOUSE_PLEDGE_REPOSITORY');
export const WAREHOUSE_TRANSFER_REPOSITORY = Symbol('WAREHOUSE_TRANSFER_REPOSITORY');
