export const USER_ROLES = [
  'farmer',
  'student',
  'buyer',
  'supplier',
  'chapter_lead',
  'partner',
  'admin',
  // Wave L1b (ALTP): field veterinarian (Dr. Chidinma persona) and
  // regulator/state-vet auditor (Mrs. Comfort persona).
  'vet',
  // Wave L1c ALTP personas (finance + compliance).
  'lender',
  'insurer',
  'regulator',
  'donor',
  // Wave AGENTS: field enumerator — captures farmer data on behalf of
  // farmers (agent assignments queue, migration 023).
  'enumerator',
  // Wave VOICE: agronomist — works the voice-agronomist escalation queue
  // (agent cases, agent-assist console, migration 027).
  'agronomist',
  // Wave AGENTBANK: rural banking agent — runs a ledger-backed float for
  // farmer cash-in/cash-out and signed offline vouchers (migration 032).
  'agent'
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const LANGUAGE_CODES = ['en', 'ha', 'yo', 'ig'] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export const KYC_TIERS = ['tier_0', 'tier_1', 'tier_2', 'tier_3'] as const;
export type KycTier = (typeof KYC_TIERS)[number];

export const APPLICATION_STATUSES = [
  'submitted',
  'under_review',
  'successful',
  'unsuccessful',
  'withdrawn'
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const ORDER_STATUSES = [
  'requested',
  'negotiating',
  'confirmed',
  'deposit_paid',
  'in_fulfilment',
  'delivered',
  'completed',
  'disputed',
  'cancelled'
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'sms', 'whatsapp', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface LocationRef {
  state: string;
  lga: string;
  ward?: string;
  latitude?: number;
  longitude?: number;
}

export interface User {
  id: string;
  phone: string;
  email?: string;
  fullName: string;
  roles: UserRole[];
  preferredLanguage: LanguageCode;
  kycTier: KycTier;
  isVerified: boolean;
  createdAt: string;
  lastActiveAt?: string;
}

export interface Profile {
  userId: string;
  location: LocationRef;
  farmingInterests: string[];
  valueChains: string[];
  bio?: string;
  farmSizeHectares?: number;
  yearsExperience?: number;
  completionScore: number;
  badges: string[];
}

export interface ConsentRecord {
  id: string;
  userId: string;
  purpose: string;
  granted: boolean;
  source: string;
  grantedAt: string;
  revokedAt?: string;
}

export interface Course {
  id: string;
  title: string;
  category: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  durationMinutes: number;
  language: LanguageCode;
  enrolmentCount: number;
  offlineAvailable: boolean;
}

export interface Enrolment {
  id: string;
  courseId: string;
  userId: string;
  progressPercent: number;
  status: 'enrolled' | 'in_progress' | 'completed';
  enrolledAt: string;
  completedAt?: string;
}

export interface Certificate {
  id: string;
  userId: string;
  courseId: string;
  verificationCode: string;
  issuedAt: string;
  verificationUrl: string;
}

export interface ForumTopic {
  id: string;
  title: string;
  category: string;
  authorId: string;
  state?: string;
  crop?: string;
  replyCount: number;
  createdAt: string;
}

export interface MentorRequest {
  id: string;
  userId: string;
  crop: string;
  state: string;
  challenge: string;
  status: 'requested' | 'matched' | 'closed';
  createdAt: string;
}

export interface Opportunity {
  id: string;
  title: string;
  type: 'grant' | 'loan' | 'programme' | 'job' | 'internship' | 'competition' | 'equipment' | 'land';
  description: string;
  states: string[];
  valueChains: string[];
  eligibility: string[];
  deadline: string;
  partnerId?: string;
  isActive: boolean;
}

export interface OpportunityApplication {
  id: string;
  opportunityId: string;
  userId: string;
  status: ApplicationStatus;
  submittedAt: string;
  notes?: string;
}

export interface Chapter {
  id: string;
  name: string;
  level: 'national' | 'state' | 'lga' | 'ward';
  parentId?: string;
  state: string;
  lga?: string;
  leadUserId?: string;
  memberCount: number;
  active: boolean;
}

export interface ChapterEvent {
  id: string;
  chapterId: string;
  title: string;
  type: 'meeting' | 'training' | 'field_visit' | 'programme';
  startsAt: string;
  location: string;
  rsvpCount: number;
  attendanceCount: number;
}

export interface AdvisoryItem {
  id: string;
  kind: 'crop_calendar' | 'pest_alert' | 'weather' | 'price' | 'guide';
  title: string;
  summary: string;
  state?: string;
  crop?: string;
  severity?: 'info' | 'warning' | 'critical';
  publishedAt: string;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  kind: 'produce' | 'input' | 'service' | 'equipment' | 'storage' | 'transport';
  title: string;
  crop?: string;
  quantity: number;
  unit: string;
  priceNaira: number;
  location: LocationRef;
  harvestDate?: string;
  /**
   * Link to the certified livestock listing this marketplace listing was
   * created from (migration 019a). Buyer-facing provenance badges prefer
   * this direct field over crop-term heuristics.
   */
  certifiedListingId?: string;
  isActive: boolean;
}

export interface Order {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  quantity: number;
  totalNaira: number;
  status: OrderStatus;
  escrowRequired: boolean;
  createdAt: string;
}

export interface CreditProfile {
  userId: string;
  score: number;
  trainingSignals: number;
  transactionSignals: number;
  productionSignals: number;
  documentCount: number;
  improvementActions: string[];
}

export interface VaultDocument {
  id: string;
  userId: string;
  kind: 'national_id' | 'land_title' | 'farm_photo' | 'certificate' | 'business_plan' | 'utility_bill';
  fileName: string;
  status: 'uploaded' | 'verified' | 'rejected';
  uploadedAt: string;
}

export interface NotificationPreference {
  userId: string;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationMessage {
  id: string;
  userId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'read';
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  /** Hash of the previous audit event in the tamper-evident chain (additive). */
  prevHash?: string;
  /** sha256 over the canonical event payload + prevHash (additive). */
  hash?: string;
  /** Correlates the audit event with the HTTP request that caused it (additive). */
  requestId?: string;
}

/**
 * Consistent API error envelope produced by the API exception filter.
 * `requestId` is additive: older clients ignore it (observability wave).
 */
export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

export interface PlatformMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  trend?: number;
  /**
   * Honesty flag: 'live' = computed from repositories at request time;
   * 'seed' = deterministic fixture (allowed in non-production responses and
   * client-side offline fallbacks only — refused in production responses).
   */
  basis: 'seed' | 'live';
}

export interface IntegrationStatus {
  provider: string;
  capability: string;
  driver: 'stub' | 'sandbox' | 'production';
  configured: boolean;
  healthy: boolean;
  notes?: string;
}

export interface ApiListResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiItemResponse<T> {
  data: T;
}

/* ---------------------------------------------------------------------------
 * Wave P2a: Produce Marketplace depth + Finance/Credit contracts.
 * Money is always integer kobo (1 NGN = 100 kobo); no float money arithmetic.
 * ------------------------------------------------------------------------- */

export const ESCROW_STATUSES = [
  'held',
  'releasing',
  'released',
  'refunding',
  'refunded',
  'disputed'
] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

/** Escrow record held against a marketplace order (provider-agnostic). */
export interface EscrowRecord {
  id: string;
  orderId: string;
  amountKobo: number;
  /**
   * 'releasing'/'refunding' are system-driven pending states: the intent is
   * persisted BEFORE the payment provider is called, so a crash mid-call
   * leaves a resumable record instead of a double-release risk.
   */
  status: EscrowStatus;
  /** Opaque reference returned by the payment provider adapter, when attached. */
  providerReference?: string;
  /**
   * Buyer-supplied payment reference declared at the deposit_paid transition
   * (Stage 22, audit C2). Always recorded when a reference was supplied;
   * `depositVerifiedAt` distinguishes a provider-verified deposit from a
   * declarative (non-production convenience) one.
   */
  depositReference?: string;
  /** Set only when a payment provider verified the deposit on-chain. */
  depositVerifiedAt?: string;
  heldAt: string;
  /** Expiry deadline: a held escrow past this timestamp is auto-refunded. */
  heldUntil?: string;
  resolvedAt?: string;
}

/**
 * Payment provider port. Wave P2a defined the interface; Stage 22 (audit C2)
 * wired the Paystack/Flutterwave driver adapter and added verify-before-
 * credit. Implementations must never be called with float amounts.
 */
export interface PaymentHoldCommand {
  orderId: string;
  amountKobo: number;
  currency: 'NGN';
  /** Platform reference the provider echoes back for reconciliation. */
  reference: string;
}

export interface PaymentProviderResult {
  /**
   * Opaque reference for later provider-backed release/refund calls. May be
   * absent when the provider has no separate hold artefact (e.g. the deposit
   * was already captured by a verified charge); releases/refunds then stay
   * on the declarative local path.
   */
  providerReference?: string;
}

/**
 * Result of verifying a buyer-supplied payment reference with the provider
 * (Stage 22, audit C2: verify-before-credit). Amounts are integer kobo —
 * adapters convert from provider units at the boundary.
 */
export interface PaymentVerificationResult {
  reference: string;
  status: 'success' | 'pending' | 'failed';
  /** Verified amount in integer kobo. */
  amountKobo: number;
  providerReference: string;
}

export interface PaymentProviderPort {
  readonly name: string;
  /**
   * Verifies a payment reference with the provider. Returns the provider-
   * reported status and the verified amount in integer kobo; callers must
   * require status === 'success' AND an exact amount match before crediting.
   */
  verify(reference: string): Promise<PaymentVerificationResult>;
  hold(command: PaymentHoldCommand): Promise<PaymentProviderResult>;
  release(providerReference: string): Promise<void>;
  refund(providerReference: string): Promise<void>;
}

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPriceKobo: number;
  totalKobo: number;
}

export interface Invoice {
  id: string;
  /** Sequential per seller, e.g. INV-<seller>-000042. */
  invoiceNumber: string;
  orderId: string;
  sellerId: string;
  buyerId: string;
  status: InvoiceStatus;
  currency: 'NGN';
  subtotalKobo: number;
  /** VAT at 7.5% (Nigeria) computed in integer kobo. */
  vatKobo: number;
  totalKobo: number;
  lineItems: InvoiceLineItem[];
  issuedAt?: string;
  paidAt?: string;
  createdAt: string;
}

export const SHIPMENT_STATUSES = [
  'pickup_scheduled',
  'in_transit',
  'delivered',
  'confirmed',
  'failed'
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export interface Shipment {
  id: string;
  orderId: string;
  status: ShipmentStatus;
  carrier?: string;
  trackingReference?: string;
  scheduledPickupAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string;
  confirmedAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export const LEDGER_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export interface LedgerAccount {
  id: string;
  /** Unique natural key, e.g. platform:cash, member:<userId>:loan_receivable. */
  code: string;
  /** Owning member for member-scoped accounts; undefined for platform accounts. */
  ownerId?: string;
  type: LedgerAccountType;
  currency: 'NGN';
  createdAt: string;
}

export const LEDGER_DIRECTIONS = ['debit', 'credit'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export interface LedgerPosting {
  accountCode: string;
  direction: LedgerDirection;
  amountKobo: number;
}

/**
 * Immutable double-entry journal entry. Sum of debits always equals sum of
 * credits (enforced by the service before persistence). Corrections happen
 * only through a reversal entry referencing `reversesEntryId`.
 */
export interface LedgerJournalEntry {
  id: string;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  reversesEntryId?: string;
  postedAt: string;
  postings: LedgerPosting[];
}

export interface LedgerBalance {
  accountCode: string;
  debitsKobo: number;
  creditsKobo: number;
  /** debitsKobo - creditsKobo (debit-positive convention). */
  balanceKobo: number;
}

export const LOAN_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'disbursed',
  'repaying',
  'closed',
  'defaulted'
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export interface LoanApplication {
  id: string;
  applicantId: string;
  lenderId: string;
  productName?: string;
  amountKobo: number;
  termMonths: number;
  /** Annual interest in basis points (integer; 2750 = 27.5%). */
  annualRateBps: number;
  purpose?: string;
  status: LoanStatus;
  submittedAt?: string;
  decidedAt?: string;
  disbursedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const INSTALLMENT_STATUSES = ['pending', 'declared', 'paid', 'late'] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export interface RepaymentInstallment {
  id: string;
  loanId: string;
  sequence: number;
  /** ISO date (YYYY-MM-DD). */
  dueDate: string;
  principalKobo: number;
  interestKobo: number;
  totalKobo: number;
  /**
   * 'declared' = the borrower asserts they paid (with paymentReference) and
   * the payment awaits lender/admin confirmation; only a confirmed payment
   * ('paid') posts to the ledger.
   */
  status: InstallmentStatus;
  paidAt?: string;
  /** External payment evidence (provider receipt / transfer reference). */
  paymentReference?: string;
  declaredBy?: string;
  declaredAt?: string;
}

export interface Lender {
  id: string;
  name: string;
  product: string;
  minTicketKobo: number;
  maxTicketKobo: number;
  /** Minimum versioned credit score required for eligibility. */
  minScore: number;
  criteria: string[];
  isActive: boolean;
}

export interface CreditScoreResult {
  userId: string;
  /** Scoring function version, e.g. credit-score/v1. */
  version: string;
  score: number;
  components: Record<string, number>;
  computedAt: string;
}

/* ---------------------------------------------------------------------------
 * Wave AGENTS: field-agent (enumerator) assignments + productivity.
 * Enumerators are field staff who capture farmer data on behalf of farmer
 * users; assignments are the unit of work handed out by admins/chapter leads
 * (migration 023, schema `agents`).
 * ------------------------------------------------------------------------- */

export const AGENT_ASSIGNMENT_STATUSES = [
  'assigned',
  'in_progress',
  'completed',
  'cancelled'
] as const;
export type AgentAssignmentStatus = (typeof AGENT_ASSIGNMENT_STATUSES)[number];

/** Unit of field work assigned to an enumerator. */
export interface AgentAssignment {
  id: string;
  /** Enumerator (users.id with the 'enumerator' role) who owns the work. */
  agentUserId: string;
  /** Optional specific farmer the assignment targets. */
  farmerUserId?: string;
  chapterId?: string;
  state: string;
  lga: string;
  ward?: string;
  /** Free-text purpose, e.g. 'farmer-registration', 'farm-visit'. */
  purpose: string;
  /** Number of captures/visits expected (>= 1). */
  targetCount: number;
  completedCount: number;
  status: AgentAssignmentStatus;
  dueAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Append-only activity trail for enumerator actions (agents.agent_activity_log). */
export interface AgentActivityLogEntry {
  id: string;
  agentUserId: string;
  assignmentId?: string;
  /** e.g. 'assignment_created' | 'assignment_progress' | 'profile_captured'. */
  action: string;
  /** Subject of the action when it concerns a person (e.g. the farmer). */
  subjectUserId?: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** Per-agent productivity aggregate (GET /field-agents/productivity). */
export interface AgentProductivity {
  agentUserId: string;
  totalAssignments: number;
  activeAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  targetCount: number;
  completedCount: number;
  /** completedCount / targetCount in [0, 1]; 0 when no target was set. */
  completionRate: number;
}

/** Consent purpose recorded when an enumerator captures data on behalf of a farmer. */
export const FIELD_DATA_CAPTURE_CONSENT_PURPOSE = 'field-data-capture';
