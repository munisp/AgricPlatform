# Mojaloop integration (agric-platform)

AgricPlatform integrates Mojaloop as its payment switch. This directory is
the decision record + local-dev entry point; the actual deployments are:

| Path                          | What runs                                        | Use for                                   |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------- |
| compose profile `mojaloop`     | Testing Toolkit backend `v18.19.1` + UI `v16.7.4` | Local dev: hub emulator for the API adapter (`MOJALOOP_DRIVER=simulator`) |
| `infra/k8s/mojaloop/`          | Official Helm chart `mojaloop/mojaloop` **17.2.0** (full switch + TTK + simulators) | Dev/staging clusters, adapter integration tests |

## Why Helm for the switch, not compose

A faithful compose of the switch needs account-lookup-service, quoting-service,
transaction-requests-service, ml-api-adapter, central-ledger (+event-processor,
+settlement), each with exact startup ordering, plus MySQL, Kafka, MongoDB and
Redis with Mojaloop-specific schemas/topics — and Mojaloop upstream dropped
official docker-compose support years ago in favour of the Helm chart. A
hand-rolled compose would be unverifiable here (no docker in CI sandbox) and
would drift from the pinned, release-tested chart. The chart (17.2.0) pins
every app image (ALS v17.15.2, quoting v17.14.3, transaction-requests
v14.4.7, ml-api-adapter v16.9.2, central-ledger v19.12.7, TTK v18.19.1) and
its companion `example-mojaloop-backend` chart pins the data stores.

The compose Testing Toolkit is the *same component* the chart ships, so the
dev simulator path exercises the real FSPIOP surface (parties/quotes/
transfers + callbacks) rather than a mock.

## Local dev quickstart

```bash
docker compose -f infra/docker-compose.yml --profile mojaloop up -d
# TTK FSPIOP API:  http://localhost:4040   (adapter target)
# TTK admin API:   http://localhost:5050
# TTK UI:          http://localhost:6060   (test collections, hub emulator)
```

Then point the API at it (env is commented in the compose `api` service and
`.env.example`):

```dotenv
MOJALOOP_DRIVER=simulator
MOJALOOP_SIM_URL=http://mojaloop-ttk:4040
```

## Adapter env contract (live driver, another wave)

| Env var                      | Compose/TTK dev                       | K8s Helm switch (release `moja`, ns `agric-mojaloop`)                 |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `MOJALOOP_ALS_ENDPOINT`        | `http://mojaloop-ttk:4040` (emulated) | `http://moja-account-lookup-service.agric-mojaloop.svc.cluster.local` |
| `MOJALOOP_QUOTING_ENDPOINT`    | `http://mojaloop-ttk:4040` (emulated) | `http://moja-quoting-service.agric-mojaloop.svc.cluster.local`        |
| `MOJALOOP_TRANSFERS_ENDPOINT`  | `http://mojaloop-ttk:4040` (emulated) | `http://moja-ml-api-adapter.agric-mojaloop.svc.cluster.local`         |
| `MOJALOOP_DFSP_ID`             | `agricdfsp`                           | `agricdfsp` (onboard via TTK provisioning collection)                 |

(Helm service names carry the release-name prefix — `moja-*` above assumes
`helm install moja`; chart Services publish port 80 → the app's FSPIOP port.)

DFSP onboarding, callback rules and the golden-path transfer collection live
in the TTK (UI → Test Runner / Provisioning). No secrets are involved in dev;
staging/prod JWS + TLS material must come from the secrets pipeline, never
this repo.

## Observability

- TTK backend/UI log to stdout (collected by the observability overlay).
- Helm-deployed switch services expose Prometheus metrics natively on their
  admin ports (`/metrics`) — scrape snippet handed to the observability coder
  in W3's report.
