import type { AdvisoryItem, Chapter, Course, MarketplaceListing, Opportunity, PlatformMetric } from './domain.js';

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo',
  'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
  'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba',
  'Yobe', 'Zamfara'
] as const;

export const VALUE_CHAINS = [
  'Cassava', 'Maize', 'Rice', 'Poultry', 'Aquaculture', 'Tomato', 'Yam', 'Sorghum',
  'Cowpea', 'Cocoa', 'Oil Palm', 'Livestock', 'Vegetables', 'Agro-processing', 'Logistics'
] as const;

export const seedCourses: Course[] = [
  {
    id: 'course-cassava-foundations',
    title: 'Cassava Production Foundations',
    category: 'Crop Production',
    level: 'beginner',
    durationMinutes: 45,
    language: 'en',
    enrolmentCount: 1240,
    offlineAvailable: true
  },
  {
    id: 'course-poultry-business',
    title: 'Profitable Poultry Business',
    category: 'Livestock',
    level: 'intermediate',
    durationMinutes: 60,
    language: 'en',
    enrolmentCount: 940,
    offlineAvailable: true
  },
  {
    id: 'course-agribusiness-finance',
    title: 'Agribusiness Financial Literacy',
    category: 'Finance',
    level: 'beginner',
    durationMinutes: 50,
    language: 'en',
    enrolmentCount: 2110,
    offlineAvailable: true
  },
  {
    id: 'course-post-harvest',
    title: 'Post-Harvest Handling and Storage',
    category: 'Value Addition',
    level: 'intermediate',
    durationMinutes: 40,
    language: 'en',
    enrolmentCount: 760,
    offlineAvailable: true
  },
  {
    id: 'course-climate-smart',
    title: 'Climate-Smart Farming Practices',
    category: 'Climate',
    level: 'advanced',
    durationMinutes: 70,
    language: 'en',
    enrolmentCount: 530,
    offlineAvailable: false
  }
];

export const seedOpportunities: Opportunity[] = [
  {
    id: 'opp-cbn-youth-agri',
    title: 'CBN Youth Agri-Enterprise Facility',
    type: 'loan',
    description: 'Financing pathway for verified young farmers with production history and training records.',
    states: [...NIGERIAN_STATES],
    valueChains: ['Cassava', 'Maize', 'Rice', 'Poultry'],
    eligibility: ['18-35 years', 'Verified profile', 'Tier 1 KYC'],
    deadline: '2026-10-30T23:59:59.000Z',
    isActive: true
  },
  {
    id: 'opp-women-poultry',
    title: 'Women in Poultry Accelerator',
    type: 'programme',
    description: 'Cohort-based training, mentorship and starter grant for women poultry entrepreneurs.',
    states: ['Anambra', 'Kaduna', 'Kano', 'Oyo', 'Benue'],
    valueChains: ['Poultry'],
    eligibility: ['Women members', 'NYFN Women programme', 'Profile score 60%+'],
    deadline: '2026-09-15T23:59:59.000Z',
    isActive: true
  },
  {
    id: 'opp-nysc-agribusiness',
    title: 'NYSC Agribusiness Innovation Challenge',
    type: 'competition',
    description: 'National competition for corps members building market-ready agricultural ventures.',
    states: [...NIGERIAN_STATES],
    valueChains: [...VALUE_CHAINS],
    eligibility: ['NYSC participant', 'Student pathway enrolled'],
    deadline: '2026-11-20T23:59:59.000Z',
    isActive: true
  }
];

export const seedChapters: Chapter[] = [
  { id: 'chapter-national', name: 'NYFN National', level: 'national', state: 'FCT', memberCount: 2000000, active: true },
  { id: 'chapter-kaduna', name: 'Kaduna State Chapter', level: 'state', parentId: 'chapter-national', state: 'Kaduna', memberCount: 4200, active: true },
  { id: 'chapter-kano', name: 'Kano State Chapter', level: 'state', parentId: 'chapter-national', state: 'Kano', memberCount: 5100, active: true },
  { id: 'chapter-anambra', name: 'Anambra State Chapter', level: 'state', parentId: 'chapter-national', state: 'Anambra', memberCount: 3600, active: true }
];

export const seedAdvisory: AdvisoryItem[] = [
  {
    id: 'adv-maize-calendar',
    kind: 'crop_calendar',
    title: 'Maize planting window — Northern Guinea Savanna',
    summary: 'Prepare land, confirm seed quality, and align planting with forecast rainfall onset.',
    state: 'Kaduna',
    crop: 'Maize',
    severity: 'info',
    publishedAt: '2026-08-01T08:00:00.000Z'
  },
  {
    id: 'adv-fall-armyworm',
    kind: 'pest_alert',
    title: 'Fall armyworm watch',
    summary: 'Inspect early-morning whorl damage and escalate severe outbreaks to your chapter lead.',
    state: 'Kano',
    crop: 'Maize',
    severity: 'warning',
    publishedAt: '2026-08-01T09:00:00.000Z'
  },
  {
    id: 'adv-cassava-price',
    kind: 'price',
    title: 'Cassava price signal',
    summary: 'Buyer demand is strengthening around processing clusters; compare transport cost before accepting offers.',
    state: 'Lagos',
    crop: 'Cassava',
    severity: 'info',
    publishedAt: '2026-08-01T10:00:00.000Z'
  }
];

export const seedListings: MarketplaceListing[] = [
  {
    id: 'listing-cassava-kaduna',
    sellerId: 'user-adamu',
    kind: 'produce',
    title: 'Fresh cassava tubers — 5 tonnes',
    crop: 'Cassava',
    quantity: 5,
    unit: 'tonne',
    priceNaira: 185000,
    location: { state: 'Kaduna', lga: 'Zaria' },
    harvestDate: '2026-08-10',
    isActive: true
  },
  {
    id: 'listing-maize-kano',
    sellerId: 'user-farmer-2',
    kind: 'produce',
    title: 'Quality maize grain — 2 tonnes',
    crop: 'Maize',
    quantity: 2,
    unit: 'tonne',
    priceNaira: 420000,
    location: { state: 'Kano', lga: 'Kano Municipal' },
    isActive: true
  },
  {
    id: 'listing-tractor-sokoto',
    sellerId: 'user-hassan',
    kind: 'service',
    title: 'Tractor hire and land preparation',
    quantity: 12,
    unit: 'hectare slots',
    priceNaira: 85000,
    location: { state: 'Sokoto', lga: 'Sokoto North' },
    isActive: true
  }
];

/**
 * Deterministic seed fixture (basis 'seed'): offline fallback for clients
 * and non-production demos. The API serves repository-computed metrics
 * (basis 'live') and refuses seed numbers in production responses.
 */
export const platformMetrics: PlatformMetric[] = [
  { key: 'members', label: 'Registered members', value: 10482, trend: 18, basis: 'seed' },
  { key: 'active_chapters', label: 'Active chapters', value: 24, trend: 6, basis: 'seed' },
  { key: 'course_completions', label: 'Course completions', value: 531, trend: 22, basis: 'seed' },
  { key: 'opportunities', label: 'Open opportunities', value: 37, trend: 9, basis: 'seed' },
  { key: 'marketplace_listings', label: 'Marketplace listings', value: 126, trend: 14, basis: 'seed' },
  { key: 'credit_profiles', label: 'Credit profiles', value: 618, trend: 12, basis: 'seed' }
];
