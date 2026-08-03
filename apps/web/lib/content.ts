/**
 * Content for the web app, in two groups:
 *
 * 1. STATIC METADATA (top) — module catalogue, role copy, integration
 *    catalogue copy, partner programme blurbs and consent-purpose text.
 *    This is product copy, not API data, and stays local by design.
 * 2. OFFLINE FALLBACK FIXTURES (marked section below) — demo arrays that
 *    used to drive the UI and are now only rendered when the API is
 *    unreachable, always behind an offline notice.
 */
import type {
  AggregationPoint,
  Animal,
  AnimalHealthRecord,
  AnimalMovement,
  AuditEvent,
  Certificate,
  CertifiedListing,
  ChapterEvent,
  CreditProfile,
  DiseaseFlag,
  DiseaseMapEntry,
  DonorDisbursement,
  ExportDocument,
  CropPlanting,
  FarmExpense,
  FarmPlot,
  FarmSummary,
  HarvestRecord,
  ForumTopic,
  InsuranceClaim,
  InsurancePolicy,
  IntegrationStatus,
  LivestockLien,
  LivestockLot,
  LivestockRecall,
  MentorRequest,
  MovementPermit,
  NotificationMessage,
  Promotion,
  ReturnRequest,
  SellerAnalytics,
  OfftakeContract,
  OfftakeTemplate,
  Order,
  OwnershipTransfer,
  PastoralistProfile,
  UserRole,
  VaultDocument
} from '@agric-platform/shared';
import type {
  AnimalGradeResult,
  HealthRecordVerification,
  LotWithAnimals,
  PermitVerificationResult,
  RecallWithAnimals
} from '@/lib/api/endpoints';

export const ROLE_LABELS: Record<UserRole, string> = {
  farmer: 'Farmer',
  student: 'Student',
  buyer: 'Buyer',
  supplier: 'Supplier',
  chapter_lead: 'Chapter Lead',
  partner: 'Partner',
  admin: 'Admin',
  vet: 'Veterinarian',
  lender: 'Lender',
  insurer: 'Insurer',
  regulator: 'Regulator',
  donor: 'Donor'
};

export const ROLE_SUMMARIES: Record<UserRole, string> = {
  farmer: 'Grow your farm with advisory, learning, opportunities and market access.',
  student: 'Follow the student and NYSC pathway into agribusiness careers.',
  buyer: 'Source verified produce and manage escrow-ready orders.',
  supplier: 'List inputs, equipment and services for farming communities.',
  chapter_lead: 'Run your chapter: members, events, attendance and announcements.',
  partner: 'Publish programmes and track participant impact in your scope.',
  admin: 'Operate the platform: users, reviews, audit and integrations.',
  vet: 'Sign vaccination and treatment records and issue movement permits.',
  lender: 'Register and manage liens over livestock collateral.',
  insurer: 'Bind livestock insurance policies and settle claims.',
  regulator: 'Export compliance reports and oversee disease surveillance, recalls and movement control.',
  donor: 'Schedule and track milestone-based programme disbursements.'
};

export interface ModuleDef {
  href: string;
  title: string;
  description: string;
  tag: string;
  roles: UserRole[];
}

export const MODULES: ModuleDef[] = [
  {
    href: '/dashboard',
    title: 'Dashboard',
    description: 'Your role-aware home: progress, actions and recent activity.',
    tag: 'Personalised',
    roles: ['farmer', 'student', 'buyer', 'supplier', 'chapter_lead', 'partner', 'admin']
  },
  {
    href: '/learning',
    title: 'Learning Academy',
    description: 'Courses, enrolment progress and verifiable certificates, offline-ready.',
    tag: 'Skills',
    roles: ['farmer', 'student', 'chapter_lead']
  },
  {
    href: '/community',
    title: 'Community',
    description: 'Forums, groups and mentorship across states and value chains.',
    tag: 'People',
    roles: ['farmer', 'student', 'chapter_lead']
  },
  {
    href: '/opportunities',
    title: 'Opportunities',
    description: 'Grants, loans, programmes, jobs and competitions matched to your profile.',
    tag: 'Growth',
    roles: ['farmer', 'student', 'partner']
  },
  {
    href: '/chapters',
    title: 'Chapters',
    description: 'National-to-ward chapter operations, events, RSVP and attendance.',
    tag: 'Field ops',
    roles: ['farmer', 'chapter_lead', 'admin']
  },
  {
    href: '/marketplace',
    title: 'Marketplace',
    description: 'Produce, inputs, equipment and services with escrow-ready orders.',
    tag: 'Trade',
    roles: ['farmer', 'buyer', 'supplier']
  },
  {
    href: '/finance',
    title: 'Finance & Credit',
    description: 'Credit readiness, KYC tiers, document vault and lender matching.',
    tag: 'Capital',
    roles: ['farmer', 'student']
  },
  {
    href: '/advisory',
    title: 'Advisory',
    description: 'Crop calendar, pest alerts, weather and price signals for your state.',
    tag: 'Decisions',
    roles: ['farmer', 'student', 'chapter_lead']
  },
  {
    href: '/services',
    title: 'Services',
    description: 'Input and service suppliers with booking, quotes and reviews.',
    tag: 'Services',
    roles: ['farmer', 'supplier', 'buyer']
  },
  {
    href: '/programmes',
    title: 'Programmes',
    description: 'Women and youth cohorts with milestones and protected spaces.',
    tag: 'Cohorts',
    roles: ['farmer', 'student', 'partner']
  },
  {
    href: '/pathways',
    title: 'Pathways',
    description: 'Student and NYSC stage-by-stage pathways and campus clubs.',
    tag: 'Students',
    roles: ['student']
  },
  {
    href: '/knowledge',
    title: 'Knowledge',
    description: 'Offline-ready resources, podcasts with transcripts and webinars.',
    tag: 'Library',
    roles: ['farmer', 'student', 'chapter_lead']
  },
  {
    href: '/livestock',
    title: 'Livestock Registry',
    description: 'Register animals with national IDs, manage lots and transfer ownership.',
    tag: 'ALTP',
    roles: ['farmer']
  },
  {
    href: '/livestock/health',
    title: 'Animal Health & Traceability',
    description: 'Vet-signed records, movement permits, recalls and disease surveillance.',
    tag: 'Traceability',
    roles: ['farmer', 'vet', 'regulator', 'admin']
  },
  {
    href: '/livestock/trade',
    title: 'Certified Livestock Trade',
    description: 'Certified listings, offtake contracts, liens, insurance and disbursements.',
    tag: 'ALTP',
    roles: ['farmer', 'lender', 'insurer', 'donor', 'partner', 'regulator', 'admin']
  },
  {
    href: '/partner',
    title: 'Partner Hub',
    description: 'Scoped programmes, participants and impact reporting.',
    tag: 'Programmes',
    roles: ['partner']
  },
  {
    href: '/admin',
    title: 'Admin Console',
    description: 'User operations, review queues, platform KPIs and audit trail.',
    tag: 'Operations',
    roles: ['admin']
  },
  // Wave P (append-only): platform operations surfaces.
  {
    href: '/admin/status',
    title: 'Module status',
    description: 'Per-module readiness: database, cache, outbox backlog, queues.',
    tag: 'Operations',
    roles: ['admin']
  },
  {
    href: '/admin/feature-flags',
    title: 'Feature flags',
    description: 'Enable surfaces, restrict by role, roll out by percentage.',
    tag: 'Operations',
    roles: ['admin']
  },
  {
    href: '/admin/audit-verify',
    title: 'Audit chain check',
    description: 'Verify the tamper-evident audit hash chain over a range.',
    tag: 'Operations',
    roles: ['admin']
  }
];

/* --------------------------------------------------------------------------
 * OFFLINE FALLBACK FIXTURES (quarantined)
 *
 * The demo arrays below were the app's data source before the API-wiring
 * wave. They are now used ONLY as clearly-labelled offline fallbacks when
 * the API is unreachable and nothing is cached (see `fallbackData` in
 * lib/api/hooks.ts and the OfflineDataNotice banners). Do not render them
 * as if they were live data.
 * ------------------------------------------------------------------------ */

export const demoTopics: ForumTopic[] = [
  {
    id: 'topic-armyworm',
    title: 'How are you scouting fall armyworm this season?',
    category: 'Pest & Disease',
    authorId: 'user-adamu',
    state: 'Kaduna',
    crop: 'Maize',
    replyCount: 42,
    createdAt: '2026-07-28T09:30:00.000Z'
  },
  {
    id: 'topic-cassava-price',
    title: 'Cassava offtaker prices around Lagos processing clusters',
    category: 'Markets',
    authorId: 'user-chika',
    state: 'Lagos',
    crop: 'Cassava',
    replyCount: 31,
    createdAt: '2026-07-29T14:05:00.000Z'
  },
  {
    id: 'topic-poultry-feed',
    title: 'Local feed formulations that cut poultry cost by 20%',
    category: 'Livestock',
    authorId: 'user-blessing',
    state: 'Oyo',
    crop: 'Poultry',
    replyCount: 58,
    createdAt: '2026-07-30T07:45:00.000Z'
  },
  {
    id: 'topic-nysc-club',
    title: 'Starting an agribusiness club at your NYSC camp',
    category: 'Student & NYSC',
    authorId: 'user-tunde',
    replyCount: 19,
    createdAt: '2026-07-31T16:20:00.000Z'
  }
];

export const demoMentorRequests: MentorRequest[] = [
  {
    id: 'mentor-1',
    userId: 'user-adamu',
    crop: 'Maize',
    state: 'Kaduna',
    challenge: 'Moving from 2 to 10 hectares without losing soil health.',
    status: 'matched',
    createdAt: '2026-07-20T10:00:00.000Z'
  },
  {
    id: 'mentor-2',
    userId: 'user-blessing',
    crop: 'Poultry',
    state: 'Oyo',
    challenge: 'Setting up biosecurity routines for a 500-bird broiler cycle.',
    status: 'requested',
    createdAt: '2026-07-27T11:30:00.000Z'
  }
];

export const demoEvents: ChapterEvent[] = [
  {
    id: 'event-kaduna-field',
    chapterId: 'chapter-kaduna',
    title: 'Maize field day — good agronomic practices',
    type: 'field_visit',
    startsAt: '2026-08-09T09:00:00.000Z',
    location: 'Zaria demonstration farm',
    rsvpCount: 86,
    attendanceCount: 0
  },
  {
    id: 'event-kano-training',
    chapterId: 'chapter-kano',
    title: 'Post-harvest handling training',
    type: 'training',
    startsAt: '2026-08-14T10:00:00.000Z',
    location: 'Kano Municipal chapter hall',
    rsvpCount: 64,
    attendanceCount: 0
  },
  {
    id: 'event-anambra-meeting',
    chapterId: 'chapter-anambra',
    title: 'Monthly chapter meeting and elections update',
    type: 'meeting',
    startsAt: '2026-08-16T12:00:00.000Z',
    location: 'Awka town hall',
    rsvpCount: 112,
    attendanceCount: 0
  }
];

export const demoRoster = [
  { id: 'm-01', name: 'Adamu Garba', state: 'Kaduna' },
  { id: 'm-02', name: 'Blessing Okon', state: 'Akwa Ibom' },
  { id: 'm-03', name: 'Chika Eze', state: 'Anambra' },
  { id: 'm-04', name: 'Fatima Bello', state: 'Kano' },
  { id: 'm-05', name: 'Tunde Adeyemi', state: 'Oyo' },
  { id: 'm-06', name: 'Hauwa Sule', state: 'Sokoto' },
  { id: 'm-07', name: 'Ngozi Umeh', state: 'Enugu' },
  { id: 'm-08', name: 'Ibrahim Musa', state: 'Katsina' }
];

export const demoCertificates: Certificate[] = [
  {
    id: 'cert-1',
    userId: 'user-adamu',
    courseId: 'course-agribusiness-finance',
    verificationCode: 'NYFN-2026-AF-1042',
    issuedAt: '2026-06-30T12:00:00.000Z',
    verificationUrl: '/learning#certificates'
  },
  {
    id: 'cert-2',
    userId: 'user-adamu',
    courseId: 'course-cassava-foundations',
    verificationCode: 'NYFN-2026-CF-0871',
    issuedAt: '2026-07-18T12:00:00.000Z',
    verificationUrl: '/learning#certificates'
  }
];

export const demoOrders: Order[] = [
  {
    id: 'order-1',
    listingId: 'listing-cassava-kaduna',
    buyerId: 'user-buyer-1',
    sellerId: 'user-adamu',
    quantity: 5,
    totalNaira: 925000,
    status: 'deposit_paid',
    escrowRequired: true,
    createdAt: '2026-07-30T08:00:00.000Z'
  },
  {
    id: 'order-2',
    listingId: 'listing-tractor-sokoto',
    buyerId: 'user-adamu',
    sellerId: 'user-hassan',
    quantity: 4,
    totalNaira: 340000,
    status: 'confirmed',
    escrowRequired: false,
    createdAt: '2026-07-31T15:30:00.000Z'
  }
];

export const demoCreditProfile: CreditProfile = {
  userId: 'user-adamu',
  score: 62,
  trainingSignals: 18,
  transactionSignals: 21,
  productionSignals: 23,
  documentCount: 3,
  improvementActions: [
    'Verify your land document to unlock Tier 2 lender matching.',
    'Complete one more finance course to strengthen training signals.',
    'Record two more marketplace sales to build transaction history.'
  ]
};

export const demoDocuments: VaultDocument[] = [
  {
    id: 'doc-1',
    userId: 'user-adamu',
    kind: 'national_id',
    fileName: 'national-id.pdf',
    status: 'verified',
    uploadedAt: '2026-05-12T09:00:00.000Z'
  },
  {
    id: 'doc-2',
    userId: 'user-adamu',
    kind: 'farm_photo',
    fileName: 'maize-field-north.jpg',
    status: 'verified',
    uploadedAt: '2026-06-02T13:20:00.000Z'
  },
  {
    id: 'doc-3',
    userId: 'user-adamu',
    kind: 'land_title',
    fileName: 'lease-agreement-scan.pdf',
    status: 'uploaded',
    uploadedAt: '2026-07-25T10:45:00.000Z'
  }
];

export const demoNotifications: NotificationMessage[] = [
  {
    id: 'notif-1',
    userId: 'user-adamu',
    channel: 'in_app',
    title: 'Opportunity match',
    body: 'CBN Youth Agri-Enterprise Facility matches your profile and state.',
    status: 'delivered',
    createdAt: '2026-08-01T07:30:00.000Z'
  },
  {
    id: 'notif-2',
    userId: 'user-adamu',
    channel: 'sms',
    title: 'Chapter event reminder',
    body: 'Maize field day starts 9 Aug at Zaria demonstration farm.',
    status: 'sent',
    createdAt: '2026-08-01T08:15:00.000Z'
  },
  {
    id: 'notif-3',
    userId: 'user-adamu',
    channel: 'whatsapp',
    title: 'Order update',
    body: 'Deposit received for cassava order #order-1 (escrow held).',
    status: 'queued',
    createdAt: '2026-08-01T09:05:00.000Z'
  }
];

export const demoAuditEvents: AuditEvent[] = [
  {
    id: 'audit-1',
    actorId: 'user-admin-1',
    action: 'opportunity.published',
    entityType: 'opportunity',
    entityId: 'opp-irrigation-grant',
    metadata: { partner: 'Dry Season Initiative' },
    createdAt: '2026-07-31T18:00:00.000Z'
  },
  {
    id: 'audit-2',
    actorId: 'user-admin-1',
    action: 'user.role_granted',
    entityType: 'user',
    entityId: 'user-fatemi',
    metadata: { role: 'chapter_lead', chapter: 'chapter-kano' },
    createdAt: '2026-07-30T11:00:00.000Z'
  },
  {
    id: 'audit-3',
    actorId: 'system',
    action: 'privacy.export.completed',
    entityType: 'privacy_request',
    entityId: 'privacy-req-88',
    metadata: { format: 'json' },
    createdAt: '2026-07-29T16:40:00.000Z'
  }
];

export const integrations: IntegrationStatus[] = [
  { provider: 'Keycloak', capability: 'OIDC identity and role claims', driver: 'stub', configured: true, healthy: true, notes: 'Local dev realm; production realm per environment.' },
  { provider: 'Moodle', capability: 'Learning academy course bridge', driver: 'stub', configured: true, healthy: true, notes: 'Course catalogue mirrored into platform search.' },
  { provider: 'Discourse', capability: 'Community forums bridge', driver: 'stub', configured: true, healthy: true, notes: 'Topics syndicated to state and crop groups.' },
  { provider: 'Directus', capability: 'Knowledge base and advisory CMS', driver: 'stub', configured: true, healthy: true },
  { provider: 'Paystack', capability: 'Payments and escrow-ready collections', driver: 'sandbox', configured: true, healthy: true, notes: 'Test keys only; live keys via environment secrets.' },
  { provider: 'Termii', capability: 'SMS and OTP delivery', driver: 'sandbox', configured: true, healthy: true },
  { provider: 'WhatsApp (360dialog)', capability: 'WhatsApp notifications', driver: 'stub', configured: false, healthy: false, notes: 'Awaiting sender approval for launch.' },
  { provider: 'NiMet / OpenMeteo', capability: 'Weather snapshots for advisory', driver: 'stub', configured: true, healthy: true },
  { provider: 'FEWS NET', capability: 'Food security and price signals', driver: 'stub', configured: true, healthy: true },
  { provider: 'OneSignal', capability: 'Web push notifications', driver: 'stub', configured: false, healthy: false, notes: 'VAPID keys to be provisioned at staging.' },
  { provider: 'Meilisearch', capability: 'Cross-domain search index', driver: 'stub', configured: true, healthy: true },
  { provider: 'farmOS', capability: 'Farm record adapter (Phase 2)', driver: 'stub', configured: false, healthy: false, notes: 'Port defined; driver scheduled for Phase 2.' }
];

export interface PartnerProgramme {
  id: string;
  name: string;
  scope: string;
  participants: number;
  completionRate: number;
  status: 'active' | 'reporting' | 'draft';
}

export const partnerProgrammes: PartnerProgramme[] = [
  { id: 'prog-women-poultry', name: 'Women in Poultry Accelerator', scope: 'Anambra, Kaduna, Kano, Oyo, Benue', participants: 240, completionRate: 78, status: 'active' },
  { id: 'prog-dry-season', name: 'Dry-Season Irrigation Micro-Grants', scope: 'Sokoto, Kano, Jigawa, Borno, Yobe', participants: 120, completionRate: 45, status: 'active' },
  { id: 'prog-agritech-interns', name: 'AgriTech Data Internship', scope: 'Lagos, FCT, Kaduna', participants: 36, completionRate: 92, status: 'reporting' }
];

export const reviewQueue = [
  { id: 'review-1', kind: 'Supplier verification', subject: 'GreenField Inputs Ltd — Kano', submitted: '2026-07-30', priority: 'high' },
  { id: 'review-2', kind: 'Listing moderation', subject: 'Tractor hire and land preparation', submitted: '2026-07-31', priority: 'medium' },
  { id: 'review-3', kind: 'Mentor application', subject: 'Ibrahim Musa — Sorghum, Katsina', submitted: '2026-08-01', priority: 'medium' },
  { id: 'review-4', kind: 'Partner programme draft', subject: 'Dry-Season Irrigation Micro-Grants', submitted: '2026-08-01', priority: 'low' }
];

export const CONSENT_PURPOSES = [
  { id: 'essential', label: 'Essential service processing', description: 'Required to operate your account, chapters and orders.', locked: true },
  { id: 'sms', label: 'SMS alerts', description: 'Weather, pest and order alerts by SMS via Termii.', locked: false },
  { id: 'whatsapp', label: 'WhatsApp messages', description: 'Chapter reminders and advisory digests on WhatsApp.', locked: false },
  { id: 'analytics', label: 'Product analytics', description: 'Anonymous usage data that helps improve the platform.', locked: false },
  { id: 'partner-sharing', label: 'Partner programme sharing', description: 'Share your profile signals with programmes you apply to.', locked: false }
] as const;

/* ------------------------------------------------------------------------
 * ALTP LIVESTOCK FALLBACK FIXTURES (waves L1a–L1c)
 * Offline-only reference data for the livestock registry, health and trade
 * surfaces — rendered behind OfflineDataNotice when the API is unreachable.
 * Shapes mirror the NestJS controllers under apps/api/src/modules/livestock*.
 * ---------------------------------------------------------------------- */

export const demoAnimals: Animal[] = [
  {
    id: 'NG-BOV-KD-000123',
    species: 'cattle',
    breed: 'White Fulani',
    sex: 'female',
    birthDate: '2022-03-15',
    tagId: 'TAG-KD-0412',
    eid: 'RFID-982-000123',
    ownerUserId: 'user-adamu',
    state: 'Kaduna',
    lga: 'Zaria',
    status: 'alive',
    sireId: 'NG-BOV-KD-000011',
    damId: 'NG-BOV-KD-000087',
    notes: 'Lead cow of the Zaria herd.',
    createdAt: '2026-05-02T08:00:00.000Z',
    updatedAt: '2026-07-20T09:30:00.000Z'
  },
  {
    id: 'NG-CAP-KD-000045',
    species: 'goat',
    breed: 'Red Sokoto',
    sex: 'male',
    birthDate: '2024-09-01',
    tagId: 'TAG-KD-0788',
    ownerUserId: 'user-adamu',
    state: 'Kaduna',
    lga: 'Zaria',
    status: 'alive',
    createdAt: '2026-05-02T08:10:00.000Z',
    updatedAt: '2026-05-02T08:10:00.000Z'
  },
  {
    id: 'NG-OVI-KN-000067',
    species: 'sheep',
    breed: 'Yankasa',
    sex: 'female',
    ownerUserId: 'user-adamu',
    state: 'Kano',
    lga: 'Dala',
    status: 'sold',
    createdAt: '2026-04-11T10:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z'
  },
  {
    id: 'NG-BOV-KD-000087',
    species: 'cattle',
    breed: 'Sokoto Gudali',
    sex: 'female',
    birthDate: '2019-06-20',
    ownerUserId: 'user-adamu',
    state: 'Kaduna',
    lga: 'Zaria',
    status: 'alive',
    createdAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-01T08:00:00.000Z'
  }
];

export const demoLots: LivestockLot[] = [
  {
    id: 'LOT-AVI-KD-000007',
    species: 'chicken',
    quantity: 120,
    ownerUserId: 'user-adamu',
    state: 'Kaduna',
    lga: 'Zaria',
    formationRule: 'Broiler cycle 2026-Q3, same hatch date',
    status: 'open',
    createdAt: '2026-06-15T07:00:00.000Z',
    updatedAt: '2026-07-28T07:00:00.000Z'
  },
  {
    id: 'LOT-CAP-KD-000003',
    species: 'goat',
    quantity: 14,
    ownerUserId: 'user-adamu',
    state: 'Kaduna',
    lga: 'Zaria',
    status: 'open',
    createdAt: '2026-05-20T07:00:00.000Z',
    updatedAt: '2026-05-20T07:00:00.000Z'
  }
];

export const demoLotDetail: LotWithAnimals = {
  ...demoLots[1],
  animalIds: ['NG-CAP-KD-000045']
};

export const demoTransfers: OwnershipTransfer[] = [
  {
    id: 'transfer-1',
    animalId: 'NG-BOV-KD-000123',
    fromUserId: 'user-hassan',
    toUserId: 'user-adamu',
    transferType: 'sale',
    effectiveAt: '2026-05-02T08:00:00.000Z',
    recordedBy: 'user-hassan',
    createdAt: '2026-05-02T08:00:00.000Z'
  },
  {
    id: 'transfer-2',
    animalId: 'NG-BOV-KD-000123',
    fromUserId: 'user-adamu',
    toUserId: 'user-adamu',
    transferType: 'programme',
    effectiveAt: '2026-06-10T09:00:00.000Z',
    recordedBy: 'user-admin',
    createdAt: '2026-06-10T09:00:00.000Z'
  }
];

export const demoPastoralistProfile: PastoralistProfile = {
  userId: 'user-adamu',
  grazingZoneId: 'GZ-NORTH-KADUNA-04',
  migrationPattern: 'Dry-season transhumance south towards Kachia; wet-season return to Zaria.',
  primarySpecies: ['cattle', 'goat'],
  updatedAt: '2026-07-01T08:00:00.000Z'
};

export const demoHealthRecords: AnimalHealthRecord[] = [
  {
    id: 'hr-1',
    animalId: 'NG-BOV-KD-000123',
    recordType: 'vaccination',
    product: 'FMD',
    batchNumber: 'FMD-2026-041',
    dose: '2 ml',
    administeredAt: '2026-06-01T09:00:00.000Z',
    vetUserId: 'user-vet',
    notes: 'Annual FMD round, Zaria zone.',
    signature: 'm8Q1vDEMO-signature-fmd',
    signedAt: '2026-06-01T09:01:00.000Z',
    createdAt: '2026-06-01T09:01:00.000Z'
  },
  {
    id: 'hr-2',
    animalId: 'NG-BOV-KD-000123',
    recordType: 'treatment',
    product: 'Oxytetracycline',
    batchNumber: 'OXY-2026-118',
    dose: '10 ml',
    administeredAt: '2026-07-10T14:00:00.000Z',
    withdrawalUntil: '2026-07-24T14:00:00.000Z',
    vetUserId: 'user-vet',
    signature: 'x2K9pDEMO-signature-oxy',
    signedAt: '2026-07-10T14:02:00.000Z',
    createdAt: '2026-07-10T14:02:00.000Z'
  },
  {
    id: 'hr-3',
    animalId: 'NG-BOV-KD-000123',
    recordType: 'vaccination',
    product: 'Anthrax',
    batchNumber: 'ANT-2025-066',
    dose: '1 ml',
    administeredAt: '2025-11-12T09:00:00.000Z',
    vetUserId: 'user-vet',
    notes: 'Reversed: cold-chain breach on batch ANT-2025-066.',
    signature: 'q7R3tDEMO-signature-ant',
    signedAt: '2025-11-12T09:01:00.000Z',
    createdAt: '2025-11-12T09:01:00.000Z'
  },
  {
    id: 'hr-4',
    animalId: 'NG-BOV-KD-000123',
    recordType: 'vaccination',
    product: 'Anthrax',
    batchNumber: 'ANT-2025-066',
    dose: '1 ml',
    administeredAt: '2025-11-12T09:00:00.000Z',
    vetUserId: 'user-vet',
    notes: 'Reversal of hr-3 (batch recall).',
    signature: 'z5W8yDEMO-signature-ant-rev',
    signedAt: '2025-11-19T10:00:00.000Z',
    reversalOfId: 'hr-3',
    createdAt: '2025-11-19T10:00:00.000Z'
  }
];

export const demoHealthVerification: HealthRecordVerification = {
  recordId: 'hr-1',
  ok: true,
  reversed: false
};

export const demoMovements: AnimalMovement[] = [
  {
    id: 'move-1',
    animalId: 'NG-BOV-KD-000123',
    fromState: 'Kaduna',
    fromLga: 'Zaria',
    toState: 'Kano',
    toLga: 'Dala',
    departedAt: '2026-06-20T06:00:00.000Z',
    arrivedAt: '2026-06-22T17:30:00.000Z',
    transportMode: 'truck',
    purpose: 'market',
    permitId: 'permit-1',
    recordedBy: 'user-adamu',
    createdAt: '2026-06-20T06:00:00.000Z'
  },
  {
    id: 'move-2',
    animalId: 'NG-BOV-KD-000123',
    fromState: 'Kano',
    fromLga: 'Dala',
    toState: 'Kaduna',
    toLga: 'Zaria',
    departedAt: '2026-07-26T05:30:00.000Z',
    transportMode: 'trek',
    purpose: 'grazing',
    recordedBy: 'user-adamu',
    createdAt: '2026-07-26T05:30:00.000Z'
  }
];

export const demoPermits: MovementPermit[] = [
  {
    id: 'permit-1',
    permitNumber: 'PMT-KD-KN-3F9A2C71',
    fromState: 'Kaduna',
    toState: 'Kano',
    validFrom: '2026-06-18T00:00:00.000Z',
    validUntil: '2026-06-25T00:00:00.000Z',
    status: 'issued',
    issuedBy: 'user-vet',
    createdAt: '2026-06-18T10:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z'
  }
];

export const demoPermitVerification: PermitVerificationResult = {
  permit: demoPermits[0],
  subjects: [{ permitId: 'permit-1', subjectType: 'animal', subjectId: 'NG-BOV-KD-000123' }],
  verification: 'expired'
};

export const demoRecalls: LivestockRecall[] = [
  {
    id: 'recall-1',
    scope: 'region',
    state: 'Kaduna',
    fromDate: '2026-07-01',
    toDate: '2026-07-15',
    batchNumber: 'OXY-2026-118',
    reason: 'Antibiotic batch OXY-2026-118 failed quality control; trace treated animals.',
    status: 'notified',
    initiatedBy: 'user-regulator',
    createdAt: '2026-07-18T11:00:00.000Z',
    notifiedAt: '2026-07-18T11:05:00.000Z'
  },
  {
    id: 'recall-2',
    scope: 'lot',
    lotId: 'LOT-AVI-KD-000007',
    reason: 'Suspected Newcastle exposure at source hatchery.',
    status: 'initiated',
    initiatedBy: 'user-regulator',
    createdAt: '2026-07-30T09:00:00.000Z'
  }
];

export const demoRecallDetail: RecallWithAnimals = {
  recall: demoRecalls[0],
  animals: [{ recallId: 'recall-1', animalId: 'NG-BOV-KD-000123', ownerUserId: 'user-adamu' }]
};

export const demoDiseaseFlags: DiseaseFlag[] = [
  {
    id: 'flag-1',
    disease: 'PPR',
    state: 'Kaduna',
    lga: 'Kachia',
    suspectedSpecies: 'goat',
    reporterUserId: 'user-adamu',
    status: 'confirmed',
    confirmedBy: 'user-vet',
    createdAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z'
  },
  {
    id: 'flag-2',
    disease: 'Newcastle',
    state: 'Kano',
    suspectedSpecies: 'chicken',
    reporterUserId: 'user-vet',
    status: 'reported',
    createdAt: '2026-07-29T15:00:00.000Z',
    updatedAt: '2026-07-29T15:00:00.000Z'
  }
];

export const demoDiseaseMap: DiseaseMapEntry[] = [
  {
    state: 'Kaduna',
    disease: 'PPR',
    confirmedFlags: 3,
    latestReportedAt: '2026-07-23T10:00:00.000Z'
  },
  {
    state: 'Sokoto',
    disease: 'CBPP',
    confirmedFlags: 1,
    latestReportedAt: '2026-07-12T09:00:00.000Z'
  }
];

export const demoAnimalGrade: AnimalGradeResult = {
  animalId: 'NG-BOV-KD-000123',
  species: 'cattle',
  grade: 'B',
  score: 68,
  components: {
    vaccinationCoverage: 2 / 3,
    vaccinationPoints: 30,
    treatmentPoints: 12,
    movementPoints: 10,
    agePoints: 16,
    movementCount: 2,
    requiredVaccinations: ['FMD', 'CBPP', 'Anthrax'],
    completedVaccinations: ['FMD', 'Anthrax']
  },
  computedAt: '2026-07-31T08:00:00.000Z'
};

export const demoCertifiedListings: CertifiedListing[] = [
  {
    id: 'listing-cert-1',
    subjectType: 'animal',
    subjectId: 'NG-BOV-KD-000123',
    sellerUserId: 'user-adamu',
    species: 'cattle',
    breed: 'White Fulani',
    askingPriceKobo: 450_000_00,
    status: 'active',
    provenance: {
      subjectType: 'animal',
      subjectId: 'NG-BOV-KD-000123',
      species: 'cattle',
      breed: 'White Fulani',
      ownershipDepth: 1,
      consentGranted: true
    },
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-21T09:00:00.000Z'
  }
];

export const demoOfftakeTemplates: OfftakeTemplate[] = [
  {
    id: 'template-1',
    name: 'Festive season beef offtake',
    description: 'Standard Q4 beef offtake for certified cattle, Lagos abattoirs.',
    species: 'cattle',
    defaultQuantity: 20,
    defaultPricePerUnitKobo: 420_000_00,
    deliveryWindowDays: 45,
    defaultQualityGrade: 'B',
    status: 'active',
    createdByUserId: 'user-partner',
    createdAt: '2026-06-01T08:00:00.000Z',
    updatedAt: '2026-06-01T08:00:00.000Z'
  }
];

export const demoOfftakeContracts: OfftakeContract[] = [
  {
    id: 'contract-1',
    templateId: 'template-1',
    farmerUserId: 'user-adamu',
    buyerUserId: 'user-buyer',
    species: 'cattle',
    quantity: 10,
    pricePerUnitKobo: 420_000_00,
    totalKobo: 4_200_000_00,
    deliveryWindowStart: '2026-10-01T00:00:00.000Z',
    deliveryWindowEnd: '2026-11-15T00:00:00.000Z',
    qualityGrade: 'B',
    status: 'active',
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z'
  }
];

export const demoExportDocuments: ExportDocument[] = [
  {
    id: 'export-doc-1',
    documentType: 'certificate_of_origin',
    subjectType: 'animal',
    subjectId: 'NG-BOV-KD-000123',
    version: 1,
    status: 'draft',
    payload: {
      watermark: 'DRAFT — generated for review only; not submitted to any authority',
      documentType: 'certificate_of_origin',
      version: 1,
      consignment: {
        subjectType: 'animal',
        subjectId: 'NG-BOV-KD-000123',
        species: 'cattle',
        breed: 'White Fulani',
        quantity: 1,
        originState: 'Kaduna',
        originLga: 'Zaria',
        ownerUserId: 'user-adamu'
      },
      certificateOfOrigin: {
        originCountry: 'Nigeria',
        exporterUserId: 'user-adamu',
        destinationCountry: 'Ghana',
        hsCode: '0102'
      },
      generatedAt: '2026-07-28T12:00:00.000Z'
    },
    createdByUserId: 'user-adamu',
    createdAt: '2026-07-28T12:00:00.000Z'
  }
];

export const demoLiens: LivestockLien[] = [
  {
    id: 'lien-1',
    subjectType: 'animal',
    subjectId: 'NG-BOV-KD-000123',
    lenderUserId: 'user-lender',
    borrowerUserId: 'user-adamu',
    principalKobo: 300_000_00,
    terms: '6-month input credit; lien discharges on full repayment.',
    status: 'active',
    registeredAt: '2026-06-05T09:00:00.000Z',
    createdAt: '2026-06-05T09:00:00.000Z',
    updatedAt: '2026-06-05T09:00:00.000Z'
  }
];

export const demoInsurancePolicies: InsurancePolicy[] = [
  {
    id: 'policy-1',
    holderUserId: 'user-adamu',
    insurerUserId: 'user-insurer',
    subjectType: 'animal',
    subjectId: 'NG-BOV-KD-000123',
    species: 'cattle',
    premiumKobo: 22_500_00,
    coverageKobo: 450_000_00,
    status: 'bound',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2027-06-30T00:00:00.000Z',
    createdAt: '2026-06-28T10:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z'
  }
];

export const demoInsuranceClaims: InsuranceClaim[] = [
  {
    id: 'claim-1',
    policyId: 'policy-1',
    claimantUserId: 'user-adamu',
    trigger: 'recall',
    recallId: 'recall-1',
    animalIds: ['NG-BOV-KD-000123'],
    status: 'submitted',
    notes: 'Recall recall-1 (batch OXY-2026-118) — withdrawal losses.',
    createdAt: '2026-07-19T09:00:00.000Z',
    updatedAt: '2026-07-19T09:00:00.000Z'
  }
];

export const demoDisbursements: DonorDisbursement[] = [
  {
    id: 'disb-1',
    donorUserId: 'user-donor',
    programmeId: 'prog-women-poultry',
    milestone: 'vaccination',
    amountKobo: 50_000_00,
    beneficiaryUserId: 'user-adamu',
    status: 'scheduled',
    createdAt: '2026-07-26T08:00:00.000Z',
    updatedAt: '2026-07-26T08:00:00.000Z'
  },
  {
    id: 'disb-2',
    donorUserId: 'user-donor',
    programmeId: 'prog-women-poultry',
    milestone: 'registration',
    amountKobo: 25_000_00,
    beneficiaryUserId: 'user-adamu',
    status: 'released',
    releasedAt: '2026-07-02T09:00:00.000Z',
    createdAt: '2026-06-28T08:00:00.000Z',
    updatedAt: '2026-07-02T09:00:00.000Z'
  }
];

export const demoAggregationPoints: AggregationPoint[] = [
  {
    id: 'point-1',
    name: 'Zaria Livestock Collection Hub',
    state: 'Kaduna',
    lga: 'Zaria',
    managerUserId: 'user-partner',
    capacity: 500,
    lotIds: ['LOT-AVI-KD-000007'],
    status: 'active',
    createdAt: '2026-06-10T08:00:00.000Z',
    updatedAt: '2026-07-28T07:00:00.000Z'
  }
];

/**
 * Offline fallback for the farmer dashboard livestock summary card — the
 * pre-computed shape of components/livestock-dashboard-widget's summary
 * (kept in sync with demoAnimals + demoHealthRecords above).
 */
export const demoLivestockSummary = {
  total: 3,
  bySpecies: [
    { species: 'cattle', count: 2 },
    { species: 'goat', count: 1 }
  ],
  pendingHealthTasks: 3,
  overdueHealthTasks: 1,
  openRecalls: null as number | null
};

/**
 * Wave M offline fallbacks: seller analytics, promotions and return queue
 * fixtures — rendered only when the commerce API is unreachable, always
 * behind an offline notice.
 */
export const demoSellerAnalytics: SellerAnalytics = {
  sellerId: 'user-adamu',
  revenueKobo: 12_450_000,
  orderCounts: { completed: 8, delivered: 2, in_fulfilment: 1, cancelled: 1, disputed: 1 },
  totalOrders: 13,
  fulfilmentRate: 0.833,
  disputeRate: 0.077,
  returnRate: 0.1,
  topVariants: [
    { variantId: 'variant-maize-50kg', sku: 'MAIZE-50KG-A', name: 'Grade A — 50kg bag', unitsSold: 24, revenueKobo: 8_400_000 },
    { variantId: 'variant-cassava-25kg', sku: 'CASSAVA-25KG-B', name: 'Grade B — 25kg bag', unitsSold: 18, revenueKobo: 4_050_000 }
  ],
  sellerRating: {
    id: 'user-adamu',
    userId: 'user-adamu',
    reviewCount: 9,
    ratingSum: 41,
    average: 4.56,
    updatedAt: '2026-08-01T09:00:00.000Z'
  }
};

export const demoPromotions: Promotion[] = [
  {
    id: 'promo-harvest-week',
    code: 'HARVEST10',
    name: 'Harvest week — 10% off',
    kind: 'percentage',
    value: 1000,
    automatic: false,
    usedCount: 14,
    usageLimit: 100,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-31T23:59:59.000Z',
    isActive: true,
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T08:00:00.000Z'
  },
  {
    id: 'promo-coop-freight',
    name: 'Coop freight support',
    kind: 'fixed',
    value: 50_000,
    automatic: true,
    minOrderKobo: 5_000_000,
    usedCount: 6,
    isActive: true,
    createdAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-20T08:00:00.000Z'
  }
];

export const demoReturnRequests: ReturnRequest[] = [
  {
    id: 'return-demo-1',
    orderId: 'order-adamu-soya',
    buyerId: 'user-hassan',
    reason: 'Two bags arrived torn',
    status: 'requested',
    restock: true,
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z'
  },
  {
    id: 'return-demo-2',
    orderId: 'order-adamu-cassava',
    buyerId: 'user-buyer',
    reason: 'Moisture level above contract',
    status: 'approved',
    restock: false,
    createdAt: '2026-07-30T09:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z'
  }
];

/* ========================================================================
 * Farms & crop-production (farms wave) — offline fallbacks only; live data
 * comes from GET /api/v1/farms/*.
 * ====================================================================== */

export const demoFarmPlots: FarmPlot[] = [
  {
    id: 'plot-demo-zaria-north',
    ownerUserId: 'user-adamu',
    name: 'Zaria North Plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.0855,
    centroidLong: 7.7199,
    boundaryGeojson: {
      type: 'Polygon',
      coordinates: [
        [
          [7.7199, 11.0855],
          [7.7219, 11.0855],
          [7.7219, 11.0875],
          [7.7199, 11.0875],
          [7.7199, 11.0855]
        ]
      ]
    },
    sizeHectares: 2.5,
    soilType: 'loamy',
    createdAt: '2026-04-12T08:00:00.000Z',
    updatedAt: '2026-07-18T09:30:00.000Z',
    version: 3,
    clientId: 'mobile-capture-042'
  },
  {
    id: 'plot-demo-samaru',
    ownerUserId: 'user-adamu',
    name: 'Samaru Cassava Field',
    state: 'Kaduna',
    lga: 'Sabon Gari',
    centroidLat: 11.1701,
    centroidLong: 7.6275,
    sizeHectares: 1.75,
    soilType: 'sandy',
    createdAt: '2026-05-03T07:30:00.000Z',
    updatedAt: '2026-05-03T07:30:00.000Z',
    version: 1
  }
];

export const demoCropPlantings: CropPlanting[] = [
  {
    id: 'planting-demo-maize',
    plotId: 'plot-demo-zaria-north',
    crop: 'Maize',
    variety: 'Oba Super 2',
    season: '2026-wet',
    plantedAt: '2026-05-15T00:00:00.000Z',
    expectedHarvestAt: '2026-09-15T00:00:00.000Z',
    status: 'growing',
    createdAt: '2026-05-15T08:00:00.000Z',
    updatedAt: '2026-05-15T08:00:00.000Z',
    version: 1
  },
  {
    id: 'planting-demo-cassava',
    plotId: 'plot-demo-samaru',
    crop: 'Cassava',
    variety: 'TME 419',
    season: '2026-wet',
    plantedAt: '2026-04-20T00:00:00.000Z',
    expectedHarvestAt: '2027-04-20T00:00:00.000Z',
    status: 'growing',
    createdAt: '2026-04-20T08:00:00.000Z',
    updatedAt: '2026-04-20T08:00:00.000Z',
    version: 1
  }
];

export const demoHarvestRecords: HarvestRecord[] = [
  {
    id: 'harvest-demo-1',
    plantingId: 'planting-demo-maize',
    harvestedAt: '2025-09-22T00:00:00.000Z',
    quantity: 42,
    unit: 'bags',
    qualityGrade: 'A',
    createdAt: '2025-09-22T10:00:00.000Z'
  }
];

export const demoFarmExpenses: FarmExpense[] = [
  {
    id: 'expense-demo-1',
    plotId: 'plot-demo-zaria-north',
    category: 'fertilizer',
    amountKobo: 750_000,
    incurredAt: '2026-06-01T00:00:00.000Z',
    note: 'NPK 20-10-10, 5 bags',
    createdAt: '2026-06-01T09:00:00.000Z'
  },
  {
    id: 'expense-demo-2',
    plotId: 'plot-demo-zaria-north',
    category: 'labour',
    amountKobo: 320_000,
    incurredAt: '2026-06-10T00:00:00.000Z',
    createdAt: '2026-06-10T15:00:00.000Z'
  }
];

export const demoFarmSummary: FarmSummary = {
  ownerUserId: 'user-adamu',
  plotCount: 2,
  totalHectares: 4.25,
  activePlantings: 2,
  harvestByCrop: [{ crop: 'Maize', totalQuantity: 42, harvestCount: 1 }],
  totalExpensesKobo: 1_070_000
};
