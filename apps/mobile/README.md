# @agric-platform/mobile — NYFN mobile shell

Expo / React Native (TypeScript) shell for the NYFN platform: Login (phone +
OTP against the same `/api/v1/auth` endpoints as the web app), Home dashboard
(training progress, opportunities count, weather card), Courses list/detail,
Marketplace listings/detail, and Profile, navigated with React Navigation
native-stack (`App.tsx`).

## Test strategy: vitest + react-test-renderer (not jest-expo)

Tests run with **vitest** (already the repo-wide runner) plus
**react-test-renderer**, with `react-native` aliased to a manual mock
(`test/mocks/react-native.tsx`, configured in `vitest.config.ts`). jest-expo
was deliberately not used: it pulls in the full jest + babel-preset-expo +
Metro transform chain, which is heavy for CI and unnecessary for a shell
whose screens consume the API through a typed client. The mock renders RN
primitives as plain host elements so screen smoke tests run in plain Node.

## Adapters (offline-first)

- **TokenStore** (`src/api/token-store.ts`): bearer-token persistence. The
  interface matches `expo-secure-store` (get/set/delete); the in-memory
  implementation is the documented fallback for tests and CI. Swap in a
  SecureStore-backed adapter when native builds start.
- **Offline queue** (`src/offline/queue.ts`): replayable mutation queue
  mirroring the web PWA queue concept. Any AsyncStorage-compatible
  `KeyValueStorage` works — production passes
  `@react-native-async-storage/async-storage` directly; tests use the
  in-memory implementation. Entries carry stable idempotency keys; `flush`
  replays in order, drops successes and keeps failures queued.

## API client

`src/api/client.ts` mirrors `apps/web/lib/api/client.ts` (envelope handling,
error mapping, automatic idempotency keys on mutations) but is constructed
with an explicit base URL from app config (`app.json` → `expo.extra.apiBaseUrl`,
read in `src/config.ts`) and a `TokenStore`. Typed endpoint wrappers live in
`src/api/endpoints.ts`.

## Running

```bash
npm install                 # from the repo root (npm workspaces)
npm run typecheck -w apps/mobile
npm run lint -w apps/mobile
npm run test -w apps/mobile
npm run start -w apps/mobile   # Expo dev server (requires Expo tooling; not exercised in CI)
```

No native modules beyond Expo defaults, no app-store assets, no secrets —
the API base URL is public configuration, overridable per build flavour.
