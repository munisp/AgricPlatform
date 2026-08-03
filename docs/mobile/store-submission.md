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

## Google Play (Android)

- [ ] Production AAB from `eas build --profile production --platform android`.
- [ ] App name `AgricPlatform`, package `com.agricplatform.app`
      (`app.config.js`), `versionCode` bumped per release.
- [ ] **Permissions declaration is trivially clean**: the app declares no
      permissions beyond the implicit `INTERNET` (`android.permissions: []`
      in `app.config.js`) — no camera/location/contacts prompts to justify.
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
- [ ] No usage-description keys are declared (camera/photos/location/
      contacts/mic are unused). If a future feature adds one, add the
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
| Location (coarse: state/LGA only) | Listings, weather, livestock registry | `profiles.location`, `livestock.animals.state` — **no GPS collection by the app** |
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
