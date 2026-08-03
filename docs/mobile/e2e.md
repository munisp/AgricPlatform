# Mobile E2E tests (Maestro)

End-to-end flows for the AgricPlatform mobile app (`apps/mobile`), written with
[Maestro](https://maestro.mobile.dev/). The flows live in the repo-root
`maestro/` directory so they can drive any build of the app regardless of
workspace.

> **Honest status:** these flows are **authored scaffolding — they have not
> been executed on a device or emulator, and they are not wired into CI**
> (no runner with an Android emulator / iOS simulator exists yet). Treat
> them as the starting point for device QA, not as passed tests.

## Prerequisites

1. **Maestro CLI** — `curl -Ls "https://get.maestro.mobile.dev" | bash`
   (not an npm dependency; install on the dev machine or CI runner).
2. **A booted device** — Android emulator (`adb devices` shows exactly one
   device) or iOS simulator, with a development build of the app installed
   (`eas build --profile development`, see `apps/mobile/eas.json`).
3. **The API reachable from the device** — start it locally
   (`npm run dev -w @agric-platform/api`, port 3001). On the Android
   emulator run `adb reverse tcp:3001 tcp:3001` so the app's default dev
   base URL (`http://localhost:3001/api/v1`) resolves to the host.
4. **A dev OTP code** — outside production, `POST /auth/otp/request` returns
   the code as `devCode` in the response:
   ```bash
   OTP=$(curl -s -X POST http://localhost:3001/api/v1/auth/otp/request \
     -H 'Content-Type: application/json' \
     -d '{"phone":"+2348012345678"}' | jq -r .data.devCode)
   ```

## Running

```bash
# Everything (from the repo root or via the workspace script):
npm run e2e:mobile -w @agric-platform/mobile
# …which is just:
maestro test maestro/

# A single flow with the dev OTP injected:
maestro test -e OTP_CODE=$OTP maestro/flows/auth-login.yaml
```

## What is covered

| Flow | Coverage |
| --- | --- |
| `maestro/flows/auth-login.yaml` | Phone OTP login (dev `devCode`), lands on the Home dashboard. |
| `maestro/flows/marketplace-order.yaml` | Browse marketplace → open a listing → My orders → confirm an agent-drafted order ("checkout"; the mobile app has no cart — buyers confirm draft orders). Requires a seeded draft order, otherwise the confirm steps are skipped (`optional`). |
| `maestro/flows/livestock-add.yaml` | Register-animal form: species/breed/sex pickers (✓ assertions), ear tag, submit, animal appears in the list. |
| `maestro/flows/offline-queue.yaml` | Airplane-mode pattern (Android emulator via `maestro/scripts/airplane-mode.sh` + adb): offline list load shows inline error + Retry, recovery after reconnect. The persistent offline queue (`src/offline/queue.ts`, dedup + 401 auth-park) is unit-tested but **not yet wired into the screens** — the queue-replay assertions are documented but commented out in the flow until that wiring lands. |

## Airplane-mode notes

- **Android emulator**: `maestro/scripts/airplane-mode.sh on|off` wraps
  `adb shell settings put global airplane_mode_on …` + the broadcast intent.
- **iOS simulator**: no airplane-mode API exists. Use Network Link
  Conditioner on a physical device, or toggle the host Mac's network. That
  path is manual for now.

## CI wiring (future)

Running these in CI needs a runner with hardware acceleration (e.g.
`reactivecircus/android-emulator-runner` on Linux, or a macOS runner for the
iOS simulator), a seeded API, and the dev-OTP capture step above. Until that
exists the flows run on demand before store submissions.
