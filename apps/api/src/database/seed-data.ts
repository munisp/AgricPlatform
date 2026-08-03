import type {
  Certificate,
  ChapterEvent,
  ConsentRecord,
  CreditProfile,
  Enrolment,
  ForumTopic,
  Lender,
  MarketplaceListing,
  MentorRequest,
  NotificationMessage,
  NotificationPreference,
  OpportunityApplication,
  Order,
  Profile,
  User,
  VaultDocument
} from '@agric-platform/shared';
import { seedListings } from '@agric-platform/shared';

const NOW = '2026-08-01T12:00:00.000Z';

export interface ChapterAnnouncement {
  id: string;
  chapterId: string;
  title: string;
  body: string;
  authorId: string;
  publishedAt: string;
}

export interface EventRsvp {
  id: string;
  eventId: string;
  userId: string;
  status: 'rsvp' | 'attended';
  createdAt: string;
  /** QR scan check-in metadata (Wave P3); absent for manual RSVP rows. */
  scannedAt?: string;
  scannerId?: string;
}

export interface OrderReview {
  id: string;
  orderId: string;
  authorId: string;
  rating: number;
  comment?: string;
  createdAt: string;
}

export interface TopicFlag {
  id: string;
  topicId: string;
  reporterId: string;
  reason: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface DeletionRequest {
  id: string;
  userId: string;
  status: 'pending' | 'completed';
  requestedAt: string;
  completedAt?: string;
}

export const seedUsers: User[] = [
  {
    id: 'user-adamu',
    phone: '+2348010000001',
    email: 'adamu@example.ng',
    fullName: 'Adamu Bello',
    roles: ['farmer'],
    preferredLanguage: 'ha',
    kycTier: 'tier_1',
    isVerified: true,
    createdAt: '2026-01-15T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-farmer-2',
    phone: '+2348010000002',
    fullName: 'Chiamaka Okafor',
    roles: ['farmer'],
    preferredLanguage: 'ig',
    kycTier: 'tier_1',
    isVerified: true,
    createdAt: '2026-02-03T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-hassan',
    phone: '+2348010000003',
    fullName: 'Hassan Abdullahi',
    roles: ['supplier'],
    preferredLanguage: 'ha',
    kycTier: 'tier_2',
    isVerified: true,
    createdAt: '2026-01-20T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-aisha',
    phone: '+2348010000004',
    fullName: 'Aisha Yusuf',
    roles: ['student'],
    preferredLanguage: 'en',
    kycTier: 'tier_0',
    isVerified: false,
    createdAt: '2026-05-11T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-buyer',
    phone: '+2348010000005',
    email: 'buyer@lagosfoods.ng',
    fullName: 'Lagos Foods Ltd',
    roles: ['buyer'],
    preferredLanguage: 'en',
    kycTier: 'tier_2',
    isVerified: true,
    createdAt: '2026-03-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-lead-kaduna',
    phone: '+2348010000006',
    fullName: 'Kaduna Chapter Lead',
    roles: ['chapter_lead'],
    preferredLanguage: 'en',
    kycTier: 'tier_2',
    isVerified: true,
    createdAt: '2025-12-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-partner',
    phone: '+2348010000007',
    email: 'programmes@agripartner.org',
    fullName: 'Agri Partner Foundation',
    roles: ['partner'],
    preferredLanguage: 'en',
    kycTier: 'tier_3',
    isVerified: true,
    createdAt: '2025-11-10T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-admin',
    phone: '+2348010000008',
    email: 'admin@nyfn.ng',
    fullName: 'NYFN Platform Admin',
    roles: ['admin'],
    preferredLanguage: 'en',
    kycTier: 'tier_3',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  // Wave L1c ALTP personas (appended): livestock finance + compliance actors.
  {
    id: 'user-lender',
    phone: '+2348010000009',
    fullName: 'Livestock Credit Cooperative',
    roles: ['lender'],
    preferredLanguage: 'en',
    kycTier: 'tier_3',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-insurer',
    phone: '+2348010000010',
    fullName: 'Sahel Livestock Insurance',
    roles: ['insurer'],
    preferredLanguage: 'en',
    kycTier: 'tier_3',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-regulator',
    phone: '+2348010000011',
    fullName: 'State Ministry of Livestock',
    roles: ['regulator'],
    preferredLanguage: 'en',
    kycTier: 'tier_3',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  {
    id: 'user-donor',
    phone: '+2348010000012',
    fullName: 'Rural Livelihoods Donor Programme',
    roles: ['donor'],
    preferredLanguage: 'en',
    kycTier: 'tier_3',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  // Wave AGENTS persona (appended): field enumerator who captures farmer
  // data on behalf of farmers.
  {
    id: 'user-enumerator',
    phone: '+2348010000013',
    fullName: 'Field Enumerator',
    roles: ['enumerator'],
    preferredLanguage: 'en',
    kycTier: 'tier_2',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  },
  // Wave VOICE persona (appended): agronomist who works the voice-agronomist
  // escalation queue (agent cases, agent-assist console).
  {
    id: 'user-agronomist',
    phone: '+2348010000014',
    fullName: 'Extension Agronomist',
    roles: ['agronomist'],
    preferredLanguage: 'en',
    kycTier: 'tier_2',
    isVerified: true,
    createdAt: '2025-10-01T09:00:00.000Z',
    lastActiveAt: NOW
  }
];

export const seedProfiles: Profile[] = [
  {
    userId: 'user-adamu',
    location: { state: 'Kaduna', lga: 'Zaria', ward: 'Tudun Wada' },
    farmingInterests: ['Cassava', 'Maize'],
    valueChains: ['Cassava'],
    bio: 'Smallholder cassava farmer with cooperative experience across Zaria.',
    farmSizeHectares: 3.5,
    yearsExperience: 8,
    completionScore: 100,
    badges: ['verified']
  },
  {
    userId: 'user-farmer-2',
    location: { state: 'Kano', lga: 'Kano Municipal' },
    farmingInterests: ['Maize', 'Cowpea'],
    valueChains: ['Maize'],
    bio: 'Maize and cowpea grower supplying Kano processors.',
    farmSizeHectares: 2,
    yearsExperience: 5,
    completionScore: 100,
    badges: ['verified']
  },
  {
    userId: 'user-hassan',
    location: { state: 'Sokoto', lga: 'Sokoto North' },
    farmingInterests: ['Mechanisation'],
    valueChains: ['Logistics'],
    bio: 'Tractor hire and land preparation services across Sokoto.',
    completionScore: 90,
    badges: ['verified']
  },
  {
    userId: 'user-aisha',
    location: { state: 'Anambra', lga: 'Awka South' },
    farmingInterests: ['Poultry'],
    valueChains: ['Poultry'],
    completionScore: 70,
    badges: ['complete']
  },
  {
    userId: 'user-buyer',
    location: { state: 'Lagos', lga: 'Ikeja' },
    farmingInterests: [],
    valueChains: ['Agro-processing'],
    bio: 'Processor buying cassava and maize at scale.',
    completionScore: 75,
    badges: ['complete']
  },
  {
    userId: 'user-lead-kaduna',
    location: { state: 'Kaduna', lga: 'Kaduna North' },
    farmingInterests: ['Extension'],
    valueChains: ['Maize'],
    completionScore: 65,
    badges: ['complete']
  },
  {
    userId: 'user-partner',
    location: { state: 'FCT', lga: 'Abuja Municipal' },
    farmingInterests: [],
    valueChains: [],
    completionScore: 35,
    badges: ['starter']
  },
  {
    userId: 'user-admin',
    location: { state: 'FCT', lga: 'Abuja Municipal' },
    farmingInterests: [],
    valueChains: [],
    completionScore: 35,
    badges: ['starter']
  }
];

export const seedConsents: ConsentRecord[] = [
  {
    id: 'consent-adamu-terms',
    userId: 'user-adamu',
    purpose: 'terms_of_service',
    granted: true,
    source: 'registration',
    grantedAt: '2026-01-15T09:05:00.000Z'
  },
  {
    id: 'consent-adamu-sms',
    userId: 'user-adamu',
    purpose: 'sms_notifications',
    granted: true,
    source: 'profile_settings',
    grantedAt: '2026-01-15T09:06:00.000Z'
  }
];

export const seedEnrolments: Enrolment[] = [
  {
    id: 'enrolment-adamu-cassava',
    courseId: 'course-cassava-foundations',
    userId: 'user-adamu',
    progressPercent: 100,
    status: 'completed',
    enrolledAt: '2026-03-10T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:00.000Z'
  },
  {
    id: 'enrolment-aisha-poultry',
    courseId: 'course-poultry-business',
    userId: 'user-aisha',
    progressPercent: 40,
    status: 'in_progress',
    enrolledAt: '2026-06-01T10:00:00.000Z'
  }
];

export const seedCertificates: Certificate[] = [
  {
    id: 'cert-adamu-cassava',
    userId: 'user-adamu',
    courseId: 'course-cassava-foundations',
    verificationCode: 'NYFN-CERT-2026-0001',
    issuedAt: '2026-03-20T10:05:00.000Z',
    verificationUrl: 'https://api.agricplatform.ng/api/v1/certificates/verify/NYFN-CERT-2026-0001'
  }
];

export const seedForumTopics: ForumTopic[] = [
  {
    id: 'topic-cassava-pricing',
    title: 'Cassava pricing around Zaria processing clusters',
    category: 'Market access',
    authorId: 'user-adamu',
    state: 'Kaduna',
    crop: 'Cassava',
    replyCount: 12,
    createdAt: '2026-07-21T08:00:00.000Z'
  },
  {
    id: 'topic-armyworm-control',
    title: 'Fall armyworm control that worked this season',
    category: 'Pest management',
    authorId: 'user-farmer-2',
    state: 'Kano',
    crop: 'Maize',
    replyCount: 34,
    createdAt: '2026-07-25T08:00:00.000Z'
  }
];

export const seedMentorRequests: MentorRequest[] = [
  {
    id: 'mentor-aisha-poultry',
    userId: 'user-aisha',
    crop: 'Poultry',
    state: 'Anambra',
    challenge: 'Reducing broiler mortality during brooding.',
    status: 'requested',
    createdAt: '2026-07-28T08:00:00.000Z'
  }
];

export const seedChapterEvents: ChapterEvent[] = [
  {
    id: 'event-kaduna-training',
    chapterId: 'chapter-kaduna',
    title: 'Climate-smart maize field training',
    type: 'training',
    startsAt: '2026-08-20T09:00:00.000Z',
    location: 'Zaria demonstration farm',
    rsvpCount: 1,
    attendanceCount: 0
  },
  {
    id: 'event-kano-meeting',
    chapterId: 'chapter-kano',
    title: 'Quarterly chapter meeting',
    type: 'meeting',
    startsAt: '2026-09-05T10:00:00.000Z',
    location: 'Kano chapter hall',
    rsvpCount: 0,
    attendanceCount: 0
  }
];

export const seedEventRsvps: EventRsvp[] = [
  {
    id: 'rsvp-adamu-training',
    eventId: 'event-kaduna-training',
    userId: 'user-adamu',
    status: 'rsvp',
    createdAt: '2026-07-30T08:00:00.000Z'
  }
];

export const seedAnnouncements: ChapterAnnouncement[] = [
  {
    id: 'ann-kaduna-inputs',
    chapterId: 'chapter-kaduna',
    title: 'Subsidised fertiliser window',
    body: 'Registered members can book subsidised fertiliser through the chapter secretariat until Friday.',
    authorId: 'user-lead-kaduna',
    publishedAt: '2026-07-29T08:00:00.000Z'
  }
];

export const seedApplications: OpportunityApplication[] = [
  {
    id: 'application-adamu-cbn',
    opportunityId: 'opp-cbn-youth-agri',
    userId: 'user-adamu',
    status: 'under_review',
    submittedAt: '2026-07-15T08:00:00.000Z',
    notes: 'Cassava expansion loan request.'
  }
];

export const seedOrders: Order[] = [
  {
    id: 'order-buyer-cassava',
    listingId: 'listing-cassava-kaduna',
    buyerId: 'user-buyer',
    sellerId: 'user-adamu',
    quantity: 2,
    totalNaira: 370000,
    status: 'confirmed',
    escrowRequired: true,
    createdAt: '2026-07-26T08:00:00.000Z'
  }
];

export const seedCreditProfiles: CreditProfile[] = [
  {
    userId: 'user-adamu',
    score: 62,
    trainingSignals: 20,
    transactionSignals: 18,
    productionSignals: 24,
    documentCount: 2,
    improvementActions: ['Verify land title', 'Complete agribusiness finance course']
  }
];

export const seedVaultDocuments: VaultDocument[] = [
  {
    id: 'doc-adamu-id',
    userId: 'user-adamu',
    kind: 'national_id',
    fileName: 'adamu-national-id.pdf',
    status: 'verified',
    uploadedAt: '2026-02-01T08:00:00.000Z'
  },
  {
    id: 'doc-adamu-land',
    userId: 'user-adamu',
    kind: 'land_title',
    fileName: 'adamu-land-title.pdf',
    status: 'uploaded',
    uploadedAt: '2026-07-01T08:00:00.000Z'
  }
];

export const seedNotificationPreferences: NotificationPreference[] = [
  { userId: 'user-adamu', channel: 'in_app', enabled: true },
  { userId: 'user-adamu', channel: 'sms', enabled: true },
  { userId: 'user-adamu', channel: 'whatsapp', enabled: false },
  { userId: 'user-aisha', channel: 'in_app', enabled: true },
  { userId: 'user-aisha', channel: 'email', enabled: true }
];

export const seedNotificationMessages: NotificationMessage[] = [
  {
    id: 'notification-adamu-welcome',
    userId: 'user-adamu',
    channel: 'in_app',
    title: 'Welcome to AgricPlatform',
    body: 'Complete your profile to unlock opportunities and credit readiness.',
    status: 'read',
    createdAt: '2026-01-15T09:10:00.000Z'
  }
];

export { seedListings };
export type { MarketplaceListing };

/* ---------------------------------------------------------------------------
 * Wave P2a seeds: lender directory for credit matching (integer kobo tickets).
 * ------------------------------------------------------------------------- */
export const seedLenders: Lender[] = [
  {
    id: 'lender-nyfn-coop',
    name: 'NYFN Cooperative Credit Window',
    product: 'Input financing (per season)',
    minTicketKobo: 5_000_000,
    maxTicketKobo: 50_000_000,
    minScore: 40,
    criteria: ['Credit score 40+', 'Verified membership'],
    isActive: true
  },
  {
    id: 'lender-partner-mfi',
    name: 'Partner MFI Network',
    product: 'Asset financing (equipment)',
    minTicketKobo: 25_000_000,
    maxTicketKobo: 300_000_000,
    minScore: 60,
    criteria: ['Credit score 60+', 'Two verified vault documents'],
    isActive: true
  },
  {
    id: 'lender-commercial-agri',
    name: 'Commercial Agri Desk',
    product: 'Working capital line',
    minTicketKobo: 100_000_000,
    maxTicketKobo: 1_000_000_000,
    minScore: 75,
    criteria: ['Credit score 75+', 'Tier 2 KYC'],
    isActive: true
  }
];
