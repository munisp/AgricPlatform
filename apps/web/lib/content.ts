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
  AuditEvent,
  Certificate,
  ChapterEvent,
  CreditProfile,
  ForumTopic,
  IntegrationStatus,
  MentorRequest,
  NotificationMessage,
  Order,
  UserRole,
  VaultDocument
} from '@agric-platform/shared';

export const ROLE_LABELS: Record<UserRole, string> = {
  farmer: 'Farmer',
  student: 'Student',
  buyer: 'Buyer',
  supplier: 'Supplier',
  chapter_lead: 'Chapter Lead',
  partner: 'Partner',
  admin: 'Admin',
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
  lender: 'Register and manage liens over livestock collateral.',
  insurer: 'Bind livestock insurance policies and settle claims.',
  regulator: 'Export compliance reports across the livestock registry.',
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
