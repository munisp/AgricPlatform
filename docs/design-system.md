# AgricPlatform Design System

Reference for the shared visual language across **apps/web** (Next.js PWA) and
**apps/mobile** (Expo). Wave UIUX established tokens v2, the `/products` hub
navigation, and the mobile UI kit v2 that the incoming product waves (voice
agronomist, traceability, geo credit, insurance, warehouse receipts, agent
banking, carbon, vouchers, livestock passport, mechanization) plug into.

## Brand constraints (non-negotiable)

1. **Warm, low-saturation earth palette** — field greens, sand, ochre, clay.
   This is an agriculture platform. **No blue/purple hues, no blue-purple
   gradients, no Google Material styling.** Guarded by
   `apps/web/test/tokens.test.ts` (hue band 200–300° rejected in `:root`).
2. **One accent green** (`--green-700`) for primary actions; clay is reserved
   for destructive/secondary emphasis; amber for warnings.
3. **Generous whitespace on an 8pt rhythm** — compose with the spacing scale,
   never ad-hoc pixel values.
4. **Low-literacy copy rules** (enforced by dictionary convention and tests):
   - Max ~8 words per UI string; verbs first on buttons; digits not words.
   - Sentence case, never ALL CAPS; no idioms, metaphors or jokes (CEFR A2).
   - Never icon-only buttons; every action keeps a text label.
5. **Honest states** — a product that is not configured or not built yet says
   so ("Coming soon", "Not set up"), never fakes readiness. The flood-risk
   card and the planned `/products` cards are the reference pattern.
6. **en-only i18n for now** — all copy flows through the typed dictionary in
   `apps/web/lib/i18n/dictionaries/en.ts`. The ha/yo/ig scaffolds stay EMPTY
   until native-speaker review (never machine-translate).
7. **Touch targets ≥ 44pt** everywhere (`--target-min` / `tokens.targetMin`).
8. **Contrast** — text pairs meet WCAG 2.1 AA (4.5:1; muted text held to a
   5:1 safety floor). Gain contrast by darkening text, never by saturating
   backgrounds. Guarded by `apps/web/test/contrast.test.ts`.

## Design tokens

Web tokens live in `apps/web/app/globals.css` (`:root`); mobile mirrors them in
`apps/mobile/src/screens/ui.tsx` (`tokens` export). Keep the two in sync.

### Color (web → mobile `tokens.colors`)

| Token | Value | Use |
| --- | --- | --- |
| `--green-950 … --green-100` | `#17251b … #dde5d2` | Brand greens; 700 = one accent |
| `--sand-50 … --sand-300` | `#fbfaf6 … #ddd2b8` | Warm neutral surfaces |
| `--earth-600/500` | `#6e5535 / #9c7f5b` | Kickers, info badges |
| `--clay-600/500` | `#a35f3c / #b0724a` | Down-trends, secondary CTA |
| `--amber-500` | `#c99a3f` | Warning accents |
| `--red-600` | `#a34a3c` | Errors |
| `--ink / --ink-soft / --ink-mute` | `#22301f / #43503f / #5f6b58` | Text hierarchy |
| `--line`, `--card` | `#d9d2bf`, `#fffef9` | Borders, card surface |
| `--focus` | `#3c6f4d` | Focus-visible outline |

### Spacing (8pt rhythm, 4px half-step)

`--space-1..8` = 4, 8, 12, 16, 24, 32, 48, 64px. Mobile: `tokens.spacing[1..8]`.
`--space-4` (16px) is the default card rhythm.

### Radius

`--radius-s` 8px (controls) · `--radius-m` 14px (cards) · `--radius-l` 22px
(hero/panels) · `--radius-full` 999px (pills/chips).

### Elevation

`--shadow-s` resting card · `--shadow-m` hover/popover · `--shadow-l`
modal/dropdown · `--shadow-focus` soft focus ring. Shadows are green-tinted
(`rgba(31,61,43,…)`), never pure black.

### Type

`--text-xs` 12px (floor — nothing smaller carries meaning) · `--text-sm` 13.6 ·
`--text-base` 16 (body minimum for readability) · `--text-lg` 17.6 ·
`--text-xl` 21.6 · `--text-2xl` 28.8 · `--text-3xl` 41.6. Headings use clamp()
fluid sizes; numerals in metrics use `font-variant-numeric: tabular-nums`.

### Interaction

- `:focus-visible` — 3px solid `--focus` outline, 2px offset, on everything.
- `--target-min: 44px` minimum hit area (buttons, chips, nav links, inputs,
  bottom tabs, mobile primitives).
- Blanket `prefers-reduced-motion` reduction already covers all transitions.

## Web primitive catalog (`components/ui.tsx` + globals.css)

| Primitive | Class / component | Usage |
| --- | --- | --- |
| Page header | `<PageHeader kicker title description>` | Every route; h1 is a programmatic focus target (`tabIndex={-1}`) |
| Section | `<Section kicker title>` | Landing/dashboard sections |
| Card | `<Card title>` / `.card` | Default surface |
| Module card | `<ModuleCard>` / `.module-card` | Linked feature cards |
| Product card | `.product-card` + `.product-glyph.glyph-{leaf,earth,clay,amber}` | `/products` hub; `.is-planned` = dashed, non-linked honest placeholder |
| Status badge | `<StatusBadge tone>` / `.badge-*` | success / warning / critical / info / neutral |
| Metric | `<MetricCard>` / `.metric-*` | Big-number indicators |
| Empty state | `<EmptyState>` / `.empty` | Honest nothing-here |
| Notices | `.notice`, `.notice-info`, `.notice-success` | Offline fallbacks, warnings |
| Skeletons | `.skeleton-line`, `.skeleton-card`, `.skeleton-title`, `.skeleton-chip` | Loading placeholders (route `loading.tsx` uses `<RouteLoading>`) |
| Quick actions | `.quick-actions` + `.chip` links | Role shortcuts on the dashboard |
| Forms | `<Field>`, `.input/.select/.textarea`, `.check-row` | 44px controls, wired hints |

## Mobile primitive catalog (`apps/mobile/src/screens/ui.tsx`)

All primitives read from `tokens` (mirrors web) and keep 44pt+ targets.

```tsx
import {
  tokens, SectionCard, StatusPill, EmptyState, MetricTile, FormField, ListItem
} from '../screens/ui';

<SectionCard kicker="Products" title="Explore" action={<StatusPill tone="info" label="3 new" />}>
  <MetricTile value={7} label="open grants" trend="12%" />
</SectionCard>

<EmptyState
  title="Not set up yet"
  hint="Connect a driver to begin."
  actionLabel="Set up"
  onAction={openSetup}
/>

<FormField label="Phone number" hint="Used for OTP sign-in" error={phoneError}>
  <TextInput … />
</FormField>

<ListItem title="My orders" subtitle="2 active" onPress={openOrders} />
```

- **SectionCard** — kicker + title + optional trailing action; the standard
  section container for new screens.
- **StatusPill** — tones `success | warning | critical | info | neutral`,
  mirrors the web badge palette exactly.
- **EmptyState** — CSS-shape glyph + title + hint + optional action.
- **MetricTile** — value/label/trend; down-trends render in clay.
- **FormField** — label + control + hint/error; the error replaces the hint
  and is announced via `accessibilityLiveRegion="polite"`.
- **ListItem** — full-row hit area (52pt) with chevron; pass `right` to
  override the chevron (e.g. a StatusPill).

### Home hub (mobile)

`HomeScreen` renders a role-aware tile grid from the data-driven `HUB_TILES`
registry. **Adding an innovation screen is a one-line `HUB_TILES` entry plus
one callback prop** — tiles render only when wired, and
`orderTilesForRoles(roles)` surfaces the tiles each role uses most (e.g.
enumerators see the field queue first).

## Navigation architecture (web)

- **Primary row** (`PRIMARY_LINKS` in `lib/products.ts`): Dashboard, Learning,
  Opportunities, Marketplace, Livestock, Farms, Advisory + the accent
  **All products** link to `/products`.
- **"More" overflow menu** (`MORE_LINKS`): Community, Chapters, Field agents,
  Finance, Credit, Partner, Admin. Keyboard contract: button toggles,
  `aria-expanded`/`aria-controls` wired, Escape closes and returns focus to
  the button, outside click closes, route change closes.
- **`/products` hub** (`PRODUCT_GROUPS` in `lib/products.ts`): every platform
  area as a card, grouped by journey (Farm and grow · Trade and services ·
  Money and risk · Livestock and traceability · Community and programmes ·
  Climate and data · Platform operations). Live products link; **planned**
  products render dashed, non-linked cards with a "Coming soon" badge. A new
  product wave flips `status`/`href` and updates its `descKey` — nothing else.
- **Bottom tab bar** (mobile web): unchanged — Home, Dashboard, Learn,
  Opportunities, Market.

## Accessibility checklist for new surfaces

1. Page starts with `<PageHeader>` (h1 is a focus target).
2. axe-clean: add the surface to `apps/web/test/a11y.test.tsx` (color-contrast
   is covered separately by `contrast.test.ts`).
3. Any new text/background pair must be added to `contrast.test.ts`
   `VAR_PAIRS`/`RULE_PAIRS`.
4. Mobile: primitives only from `ui.tsx`; custom Pressables keep ≥44pt and an
   `accessibilityRole`.
5. Copy through the en dictionary with typed keys; ha/yo/ig stay empty.
