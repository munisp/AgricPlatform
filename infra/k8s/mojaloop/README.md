# Mojaloop switch on Kubernetes (agric-platform)

Integration-grade dev/staging deployment of the Mojaloop payment switch.
**Decision record**: Mojaloop upstream has no supported docker-compose for the
switch (the last compose quickstarts were removed years ago; the official
deployment vehicle is the Helm umbrella chart). A hand-rolled compose of
ALS + quoting + transaction-requests + ml-api-adapter + central-ledger +
MySQL + Kafka would be unmaintainable and unverifiable, so:

- **Full switch (this directory): official Helm chart `mojaloop/mojaloop`,
  pinned version 17.2.0** — used for staging and adapter integration tests.
- **Compose (profile `mojaloop`): only the Testing Toolkit pair**
  (`ml-testing-toolkit` + `-ui`, the same pinned app versions the chart
  ships), acting as the hub-emulator counterparty for our API adapter in
  `MOJALOOP_DRIVER=simulator` mode. See `infra/mojaloop/README.md`.

## Install

```bash
helm repo add mojaloop http://mojaloop.io/helm/repo/
helm repo update

# 1. Backend data stores (MySQL, Kafka, MongoDB, Redis — versions pinned by
#    the companion chart's own pinned app images)
helm upgrade --install backend mojaloop/example-mojaloop-backend \
  --version 17.2.0 -n agric-mojaloop --create-namespace --wait

# 2. The switch
helm upgrade --install moja mojaloop/mojaloop \
  --version 17.2.0 -n agric-mojaloop \
  -f infra/k8s/mojaloop/values.yaml --wait

# 3. TTK test collections / provisioning smoke
helm test moja -n agric-mojaloop   # chart ships TTK provisioning tests
```

`values.yaml` enables exactly the services the adapter needs
(account-lookup-service, quoting-service, transaction-requests-service,
ml-api-adapter, central-ledger) plus the Testing Toolkit and
mojaloop-simulator as counterparties; bulk/thirdparty subcharts are off.

## Adapter wiring

In-cluster endpoints for the live adapter. Helm service names carry the
release-name prefix (`moja-*` below assumes `helm install moja`); chart
Services publish port 80 → the app's FSPIOP port:

| Env var                      | Value (release `moja`, namespace agric-mojaloop)                          |
| ---------------------------- | ------------------------------------------------------------------------- |
| `MOJALOOP_ALS_ENDPOINT`        | `http://moja-account-lookup-service.agric-mojaloop.svc.cluster.local`     |
| `MOJALOOP_QUOTING_ENDPOINT`    | `http://moja-quoting-service.agric-mojaloop.svc.cluster.local`            |
| `MOJALOOP_TRANSFERS_ENDPOINT`  | `http://moja-ml-api-adapter.agric-mojaloop.svc.cluster.local`             |
| `MOJALOOP_DFSP_ID`             | `agricdfsp` (onboarded via the TTK provisioning collection)               |

From a dev laptop use `kubectl -n agric-mojaloop port-forward svc/moja-account-lookup-service 4002:80`
etc. Confirm per-service names/ports with `kubectl -n agric-mojaloop get svc`
after install; the live adapter (MOJALOOP_DRIVER=live) is another wave's code
— these four env names are the agreed contract.

## Observability

All Mojaloop services expose Prometheus metrics natively (admin API `/metrics`,
event-sidecar pattern). Scrape targets: pods labelled per subchart in
namespace `agric-mojaloop` — snippet handed to the observability coder in
W3's report. Tracing: the platform OTel collector endpoint can be injected
via `global.opentelemetry` keys in the chart when enabling it for staging.
