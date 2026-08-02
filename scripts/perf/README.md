# Performance gates (Wave P3)

k6 scripts for the core API surface. No k6 version is pinned in the repo —
install k6 locally or run it in a container:

```bash
# local install: https://grafana.com/docs/k6/latest/set-up/install-k6/
docker run --rm -i --network host -v "$PWD:/work" -w /work grafana/k6 run scripts/perf/k6-smoke.js
```

## Routes under test

Both scripts hit the API under its global `/api/v1` prefix (see
`k6-targets.js`):

| Route | Method | Notes |
| --- | --- | --- |
| `/health` | GET | liveness |
| `/auth/otp/request` | POST | body `{ phone }` |
| `/dashboard/:userId` | GET | `DASHBOARD_USER_ID` env (default `user-adamu`, seeded) |
| `/courses` | GET | catalogue list |
| `/listings` | GET | marketplace list |

## Smoke (`k6-smoke.js`)

1 VU for 30s; asserts status codes only (`http_req_failed < 1%`).

```bash
k6 run scripts/perf/k6-smoke.js
BASE_URL=https://staging-api.example.com k6 run scripts/perf/k6-smoke.js
```

## Latency gate (`k6-gate.js`)

Ramps to 10 VUs and **fails the run** (non-zero exit) when the budget is
breached:

- `http_req_duration: p(95)<500` overall **and per route**
- `http_req_failed: rate<0.01`

Run it against staging before cutting a release:

```bash
BASE_URL=https://staging-api.example.com DASHBOARD_USER_ID=<staging-user> \
  k6 run scripts/perf/k6-gate.js
```

Because k6 exits non-zero on threshold failure, release automation can invoke
this script directly as a blocking gate.
