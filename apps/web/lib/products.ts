/**
 * Product catalogue + navigation architecture (Wave UIUX).
 *
 * Single source of truth for:
 *  1. PRODUCT_GROUPS — every platform area (live and planned), rendered as
 *     the /products hub. Planned innovation areas (voice agronomist, geo
 *     credit, insurance, warehouse receipts, agent banking, carbon,
 *     vouchers, livestock passport, mechanization) are listed honestly
 *     with a "Coming soon" badge and no link — the same not-set-up
 *     honesty as the flood-risk card. Each incoming product wave then
 *     only flips `status`/`href` and adds a descKey.
 *  2. PRIMARY_LINKS / MORE_LINKS — the restructured top nav: a curated
 *     primary row plus an overflow menu, so 12+ links stop crowding the
 *     header. Every overflow destination is also on the /products hub.
 *  3. QUICK_ACTIONS — role-aware dashboard shortcuts.
 *
 * All copy resolves through the en dictionary (typed TranslationKey);
 * ha/yo/ig scaffolds stay empty until native-speaker review.
 */
import type { UserRole } from '@agric-platform/shared';
import type { TranslationKey } from '@/lib/i18n';

export type ProductStatus = 'live' | 'beta' | 'planned';

/** Glyph families map to the CSS-only .product-glyph shapes in globals.css. */
export type ProductGlyph = 'leaf' | 'earth' | 'clay' | 'amber';

export interface ProductDef {
  id: string;
  /** Live/beta products link somewhere real; planned products never do. */
  href?: string;
  glyph: ProductGlyph;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  status: ProductStatus;
}

export interface ProductGroup {
  id: string;
  titleKey: TranslationKey;
  products: ProductDef[];
}

export const PRODUCT_GROUPS: ProductGroup[] = [
  {
    id: 'grow',
    titleKey: 'products.groups.grow',
    products: [
      { id: 'farms', href: '/farms', glyph: 'leaf', titleKey: 'products.items.farms.title', descKey: 'products.items.farms.desc', status: 'live' },
      { id: 'advisory', href: '/advisory', glyph: 'amber', titleKey: 'products.items.advisory.title', descKey: 'products.items.advisory.desc', status: 'live' },
      { id: 'learning', href: '/learning', glyph: 'leaf', titleKey: 'products.items.learning.title', descKey: 'products.items.learning.desc', status: 'live' },
      { id: 'knowledge', href: '/knowledge', glyph: 'leaf', titleKey: 'products.items.knowledge.title', descKey: 'products.items.knowledge.desc', status: 'live' }
    ]
  },
  {
    id: 'trade',
    titleKey: 'products.groups.trade',
    products: [
      { id: 'marketplace', href: '/marketplace', glyph: 'earth', titleKey: 'products.items.marketplace.title', descKey: 'products.items.marketplace.desc', status: 'live' },
      { id: 'services', href: '/services', glyph: 'clay', titleKey: 'products.items.services.title', descKey: 'products.items.services.desc', status: 'live' },
      { id: 'mechanization', glyph: 'clay', titleKey: 'products.items.mechanization.title', descKey: 'products.items.mechanization.desc', status: 'planned' },
      { id: 'warehouseReceipts', glyph: 'clay', titleKey: 'products.items.warehouseReceipts.title', descKey: 'products.items.warehouseReceipts.desc', status: 'planned' }
    ]
  },
  {
    id: 'money',
    titleKey: 'products.groups.money',
    products: [
      { id: 'finance', href: '/finance', glyph: 'earth', titleKey: 'products.items.finance.title', descKey: 'products.items.finance.desc', status: 'live' },
      { id: 'credit', href: '/credit', glyph: 'earth', titleKey: 'products.items.credit.title', descKey: 'products.items.credit.desc', status: 'live' },
      { id: 'geoCredit', glyph: 'earth', titleKey: 'products.items.geoCredit.title', descKey: 'products.items.geoCredit.desc', status: 'planned' },
      { id: 'insurance', glyph: 'amber', titleKey: 'products.items.insurance.title', descKey: 'products.items.insurance.desc', status: 'planned' },
      { id: 'agentBanking', glyph: 'earth', titleKey: 'products.items.agentBanking.title', descKey: 'products.items.agentBanking.desc', status: 'planned' },
      { id: 'vouchers', glyph: 'earth', titleKey: 'products.items.vouchers.title', descKey: 'products.items.vouchers.desc', status: 'planned' }
    ]
  },
  {
    id: 'livestock',
    titleKey: 'products.groups.livestock',
    products: [
      { id: 'livestock', href: '/livestock', glyph: 'leaf', titleKey: 'products.items.livestock.title', descKey: 'products.items.livestock.desc', status: 'live' },
      { id: 'traceability', href: '/livestock/health', glyph: 'amber', titleKey: 'products.items.traceability.title', descKey: 'products.items.traceability.desc', status: 'live' },
      { id: 'livestockTrade', href: '/livestock/trade', glyph: 'earth', titleKey: 'products.items.livestockTrade.title', descKey: 'products.items.livestockTrade.desc', status: 'live' },
      { id: 'livestockPassport', glyph: 'amber', titleKey: 'products.items.livestockPassport.title', descKey: 'products.items.livestockPassport.desc', status: 'planned' }
    ]
  },
  {
    id: 'community',
    titleKey: 'products.groups.community',
    products: [
      { id: 'community', href: '/community', glyph: 'leaf', titleKey: 'products.items.community.title', descKey: 'products.items.community.desc', status: 'live' },
      { id: 'chapters', href: '/chapters', glyph: 'leaf', titleKey: 'products.items.chapters.title', descKey: 'products.items.chapters.desc', status: 'live' },
      { id: 'opportunities', href: '/opportunities', glyph: 'amber', titleKey: 'products.items.opportunities.title', descKey: 'products.items.opportunities.desc', status: 'live' },
      { id: 'programmes', href: '/programmes', glyph: 'leaf', titleKey: 'products.items.programmes.title', descKey: 'products.items.programmes.desc', status: 'live' },
      { id: 'pathways', href: '/pathways', glyph: 'leaf', titleKey: 'products.items.pathways.title', descKey: 'products.items.pathways.desc', status: 'live' },
      { id: 'agents', href: '/agents', glyph: 'clay', titleKey: 'products.items.agents.title', descKey: 'products.items.agents.desc', status: 'live' }
    ]
  },
  {
    id: 'climate',
    titleKey: 'products.groups.climate',
    products: [
      { id: 'floodRisk', href: '/advisory', glyph: 'amber', titleKey: 'products.items.floodRisk.title', descKey: 'products.items.floodRisk.desc', status: 'beta' },
      { id: 'voiceAgronomist', glyph: 'amber', titleKey: 'products.items.voiceAgronomist.title', descKey: 'products.items.voiceAgronomist.desc', status: 'planned' },
      { id: 'carbon', glyph: 'leaf', titleKey: 'products.items.carbon.title', descKey: 'products.items.carbon.desc', status: 'planned' }
    ]
  },
  {
    id: 'ops',
    titleKey: 'products.groups.ops',
    products: [
      { id: 'partner', href: '/partner', glyph: 'clay', titleKey: 'products.items.partner.title', descKey: 'products.items.partner.desc', status: 'live' },
      { id: 'admin', href: '/admin', glyph: 'clay', titleKey: 'products.items.admin.title', descKey: 'products.items.admin.desc', status: 'live' },
      { id: 'moduleStatus', href: '/admin/status', glyph: 'clay', titleKey: 'products.items.moduleStatus.title', descKey: 'products.items.moduleStatus.desc', status: 'live' },
      { id: 'fieldQueue', href: '/agents/my-queue', glyph: 'clay', titleKey: 'products.items.fieldQueue.title', descKey: 'products.items.fieldQueue.desc', status: 'live' }
    ]
  }
];

/** Flat lookup used by tests and the hub renderer. */
export const ALL_PRODUCTS: ProductDef[] = PRODUCT_GROUPS.flatMap((group) => group.products);

export interface NavLink {
  href: string;
  labelKey: TranslationKey;
}

/**
 * Primary top-nav row: the everyday destinations. Everything else moves to
 * the overflow menu + the /products hub.
 */
export const PRIMARY_LINKS: NavLink[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard' },
  { href: '/learning', labelKey: 'nav.learning' },
  { href: '/opportunities', labelKey: 'nav.opportunities' },
  { href: '/marketplace', labelKey: 'nav.marketplace' },
  { href: '/livestock', labelKey: 'nav.livestock' },
  { href: '/farms', labelKey: 'nav.farms' },
  { href: '/advisory', labelKey: 'nav.advisory' }
];

/** Overflow ("More") menu destinations — each is also a /products card. */
export const MORE_LINKS: NavLink[] = [
  { href: '/community', labelKey: 'nav.community' },
  { href: '/chapters', labelKey: 'nav.chapters' },
  { href: '/agents', labelKey: 'nav.agents' },
  { href: '/finance', labelKey: 'nav.finance' },
  { href: '/credit', labelKey: 'nav.credit' },
  { href: '/partner', labelKey: 'nav.partner' },
  { href: '/admin', labelKey: 'nav.admin' }
];

export interface QuickAction {
  href: string;
  labelKey: TranslationKey;
}

/**
 * Role-aware dashboard quick actions (2–3 per role, most frequent tasks
 * first). Labels reuse existing dictionary keys wherever possible.
 */
export const QUICK_ACTIONS: Record<UserRole, QuickAction[]> = {
  farmer: [
    { href: '/farms', labelKey: 'nav.farms' },
    { href: '/advisory', labelKey: 'nav.advisory' },
    { href: '/credit', labelKey: 'nav.credit' }
  ],
  student: [
    { href: '/learning', labelKey: 'nav.learning' },
    { href: '/pathways', labelKey: 'footer.pathways' },
    { href: '/opportunities', labelKey: 'nav.opportunities' }
  ],
  buyer: [
    { href: '/marketplace', labelKey: 'nav.marketplace' },
    { href: '/services', labelKey: 'footer.services' }
  ],
  supplier: [
    { href: '/marketplace', labelKey: 'nav.marketplace' },
    { href: '/services', labelKey: 'footer.services' }
  ],
  chapter_lead: [
    { href: '/chapters', labelKey: 'nav.chapters' },
    { href: '/community', labelKey: 'nav.community' },
    { href: '/agents', labelKey: 'nav.agents' }
  ],
  partner: [
    { href: '/partner', labelKey: 'nav.partner' },
    { href: '/programmes', labelKey: 'footer.programmes' }
  ],
  admin: [
    { href: '/admin', labelKey: 'nav.admin' },
    { href: '/admin/status', labelKey: 'dashboard.quick.moduleStatus' },
    { href: '/admin/feature-flags', labelKey: 'dashboard.quick.featureFlags' }
  ],
  vet: [
    { href: '/livestock/health', labelKey: 'dashboard.quick.animalHealth' },
    { href: '/livestock', labelKey: 'nav.livestock' }
  ],
  lender: [
    { href: '/livestock/trade', labelKey: 'dashboard.quick.certifiedTrade' },
    { href: '/finance', labelKey: 'nav.finance' }
  ],
  insurer: [
    { href: '/livestock/trade', labelKey: 'dashboard.quick.certifiedTrade' },
    { href: '/finance', labelKey: 'nav.finance' }
  ],
  regulator: [
    { href: '/livestock/health', labelKey: 'dashboard.quick.animalHealth' },
    { href: '/livestock/trade', labelKey: 'dashboard.quick.certifiedTrade' }
  ],
  donor: [
    { href: '/livestock/trade', labelKey: 'dashboard.quick.certifiedTrade' },
    { href: '/programmes', labelKey: 'footer.programmes' }
  ],
  enumerator: [
    { href: '/agents/my-queue', labelKey: 'dashboard.quick.fieldQueue' },
    { href: '/agents', labelKey: 'nav.agents' }
  ],
  // wave-voice: role exists for the agent-assist console; hub links stay
  // unwired here (orchestrator wires them).
  agronomist: []
};
