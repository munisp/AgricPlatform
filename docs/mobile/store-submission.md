# Mobile store submission checklist

Store-readiness checklist for the AgricPlatform mobile app (`apps/mobile`,
bundle id / package `com.agricplatform.app`). E2E flows are in `maestro/`
(see `docs/mobile/e2e.md`); app/store config is `apps/mobile/app.config.js`
+ `apps/mobile/eas.json`.

## Build credentials & secrets

- **No credentials in the repo.** `eas.json` contains build profiles only;
  signing keys, the App Store Connect API key and the Play service-account
  key live outside git.
- `EAS_TOKEN` (Expo access token for CI builds) belongs in **CI secrets**
  (GitHub Environments, per `docs/security-compliance.md` §6). Never commit
  it; never paste it into `eas.json` or `app.config.js`.
- Android upload keystore: EAS-managed credentials (default) or a keystore
  in the org password manager; iOS: EAS-managed distribution certificate +
  provisioning profile.

## Build configuration (EAS) — current state

- **API base URL (P0-3)**: `app.config.js` reads
  `process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1'`. Each
  eas.json build profile sets `API_BASE_URL`: `development` keeps
  localhost; `preview`/`production` carry **documented placeholders**
  (`https://REPLACE-WITH-STAGING-API-HOST.example.com/api/v1`,
  `https://REPLACE-WITH-PRODUCTION-API-HOST.example.com/api/v1`). Replace
  them with the real HTTPS API hosts when the domains are assigned — never
  ship a build to testers/review without this substitution.
- **OTA updates (expo-updates)**: `runtimeVersion: { policy: 'appVersion' }`
  is active and `updates.url` is wired, but it points at the all-zero UUID
  placeholder. **Run `eas init` to create the EAS project**, then replace
  both `updates.url` (`https://u.expo.dev/<project-id>`) and
  `extra.eas.projectId` with the generated ID. Update channels
  (`development`/`preview`/`production`) already map to the eas.json build
  profiles; `eas update --channel preview` works once the project exists.
- **eas submit**: `submit.production` carries placeholders
  (`android.serviceAccountKeyPath: ./secrets/play-service-account.json` —
  gitignored, never committed; iOS `appleId`/`ascAppId`/`appleTeamId` —
  replace with the real App Store Connect values). `eas submit` fails
  loudly until these are filled in; that is intentional.
- **Deep links**: the app scheme is `agricplatform://`. Universal/app links
  (associated domains / intent filters) are not configured yet — add them
  with the first deep-linked screen.
- **Metered-connection sync**: on a metered connection the app flushes the
  user's own queued writes but skips background sync pulls (documented
  behaviour for data conservation); pulls resume on unmetered connections
  and on explicit screen syncs.

## Google Play (Android)

- [ ] Production AAB from `eas build --profile production --platform android`.
- [ ] App name `AgricPlatform`, package `com.agricplatform.app`
      (`app.config.js`), `versionCode` bumped per release.
- [ ] **Permissions declaration**: the app declares `ACCESS_FINE_LOCATION`
      (plus the implicit `INTERNET`) for the plot-capture GPS feature
      (`android.permissions` in `app.config.js`). The Play permission
      declaration form must state the purpose: **mapping the farmer's plot
      centre point and boundary during plot capture, while the app is in
      use** — no background location, no ads/analytics use. No camera,
      contacts or storage permissions are requested.
- [ ] Screenshots (required): min 2, 1080×1920 or larger — capture Home
      dashboard, Marketplace, My orders, My livestock (register-animal
      form), Notifications. Capture on a mid-range device (see QA matrix).
- [ ] Feature graphic 1024×500 and 512×512 hi-res icon — derive from
      `apps/web/public/icon.svg` (`npm run icons:generate -w
      @agric-platform/mobile` already produces the 1024 master).
- [ ] Privacy policy URL: the platform privacy page —
      `https://<platform-domain>/privacy` (served by the web app at
      `apps/web/app/privacy`; use the production web domain once assigned —
      do not publish a placeholder).
- [ ] **Data safety form** — map to the NDPA data inventory below.
- [ ] Target audience & content rating questionnaire (no ads; not
      child-directed).
- [ ] News/health declarations: not applicable (agriculture/education).

## Apple App Store (iOS)

- [ ] Production IPA from `eas build --profile production --platform ios`,
      submitted via `eas submit` (App Store Connect API key in CI secrets).
- [ ] Bundle identifier `com.agricplatform.app`, `buildNumber` bumped per
      upload (`app.config.js`).
- [ ] `ITSAppUsesNonExemptEncryption=false` is already set in
      `ios.infoPlist` (HTTPS/TLS only) — export-compliance prompt is
      pre-answered.
- [ ] `NSLocationWhenInUseUsageDescription` is declared in `ios.infoPlist`
      for plot boundary/centre mapping (honest, in-use-only copy). App Store
      review notes must mention the GPS plot-capture flow. Camera/photos/
      contacts/mic remain unused — if a future feature adds one, add the
      matching `infoPlist` string with a justification comment.
- [ ] Screenshots (required): 6.7″ (1290×2796) and 6.5″ (1242×2688) —
      same screens as Play; iPad 12.9″ set only if `supportsTablet` stays
      true.
- [ ] App privacy "nutrition labels" — mirror the Play data-safety mapping
      below (App Store Connect privacy section).
- [ ] Privacy policy URL — same platform `/privacy` page as above.
- [ ] Review notes (below) + a demo account.

## Data safety / privacy labels → NDPA data inventory mapping

The NDPA/NDPR inventory and consent model live in
`docs/security-compliance.md` §4–5 and the privacy module
(`apps/api/src/modules/privacy` — consent records carry purpose, source,
timestamp and revocation). Map the store forms to it as follows:

| Store field | Platform data | Source of truth |
| --- | --- | --- |
| Phone number (required, account) | OTP login identifier | `identity.users`; consent at registration |
| Name / profile, farm details | Profile enrichment | `profiles`; consent-gated enrichment (§4) |
| Location — **precise (GPS), collected** | Plot centre point + boundary polygon captured in the field; coarse state/LGA for listings, weather, livestock registry | `geo` plots / `farms` plot records; `profiles.location`, `livestock.animals.state`. Declare on Play data-safety: *Precise location — collected, app functionality (farm plot mapping), not shared with third parties, not used for advertising*. When-in-use only; every stored point carries its measured accuracy |
| Financial info (orders/payments) | Marketplace orders, escrow | `commerce` domain; processed by Paystack — declare "data processed, not sold" |
| Livestock & health records | Animal registry, vet-signed health ledger | `livestock` schema; `livestock_records` consent purpose |
| Messages/notifications | Notification delivery logs | channel-level consent (§4) |
| App activity (learning progress) | Enrolments, pathway progress | `learning`/`pathways` domains |
| Diagnostics | Error tracking (no PII payloads) | `ErrorTrackingService`; declare "diagnostics, not linked" |
| Data sold/shared with third parties | **No** | — |
| Data encrypted in transit | **Yes** (TLS 1.3) | §7 OWASP mapping |
| Data deletion requestable | **Yes** — in-app privacy dashboard + web `/privacy` | §5 export & deletion |

## Review notes (paste into both consoles)

- Login: phone + SMS OTP. Demo account: seeded reviewer phone; outside
  production the OTP is returned in the `devCode` field of
  `POST /api/v1/auth/otp/request` (state this explicitly for the reviewer,
  with the seeded number).
- The app targets Nigerian farmers; English UI with Hausa/Yoruba/Igbo
  content in learning modules.
- Offline behaviour: dashboard and lists degrade gracefully (inline
  error + retry); no personal data leaves the device except to the
  platform API over TLS.

## Known follow-ups (out of scope for the current wave — do not claim as done)

- **Push notifications** (expo-notifications): needs the real Expo project
  ID plus FCM/APNs credentials — human-gated. The notification inbox is
  currently pull/sync-based only.
- **Writable sync routing for plot capture**: plot saves still go through
  the legacy durable offline queue (src/offline/queue.ts). Routing plot
  writes through the record-level sync outbox is owned by wave W-SYNCWRITE
  (server + client change together).
- **Per-record conflict detail UI**: sync conflicts resolve server-wins and
  are counted in the conflict log; a detail screen is not built yet.
- **react-test-renderer replacement**: the test stack still uses
  react-test-renderer (deprecated upstream); migrating to
  @testing-library/react-native is a separate cleanup.
- **Device/emulator testing** of the GPS, secure-store and OTA flows is a
  human gate (see the QA matrix below) — CI evidence is unit tests plus
  `expo export`.

## Device-QA checklist (run before each submission)

Run the Maestro flows (`docs/mobile/e2e.md`) plus this manual matrix.
Record results in the release PR; do not claim a cell without a real run.

| Axis | Coverage |
| --- | --- |
| Android API levels | API 29 (Android 10) minimum-supported sanity, API 33 (13), API 35 (15) latest emulator |
| iOS versions | iOS 16 (oldest supported), iOS 17, latest iOS 18 simulator |
| Device classes | 1 GB–2 GB RAM low-end Android (small screen 5″), mid-range 6.4″, iPhone SE, iPhone Pro Max, one tablet |
| Offline scenarios | Cold start offline (dashboard error + retry), go offline mid-session then recover, registration submit while offline (error shown; queue replay once screen wiring lands — see `offline-queue.yaml`), token-expiry mid-session (401 → refresh rotation → retry succeeds; reuse-revoked refresh → forced re-login) |
| Auth | OTP login, refresh-token rotation across app restarts, logout revokes session |
| Locale/accessibility | English + Hausa content spot-check, 200% font scaling, screen-reader labels on inputs/buttons |
