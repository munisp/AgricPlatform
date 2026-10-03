# Dapr on Kubernetes (agric-platform)

> **Decommission decision (GAP-L04, event-reliability program): the Dapr
> pub/sub component is REMOVED.** The `pubsub.kafka` → Redpanda component
> (`infra/dapr/components/pubsub-redpanda.yaml`,
> `infra/k8s/dapr/component-pubsub-redpanda.yaml`) and the compose `daprd`
> sidecar wiring (`api-dapr`, `event-gw-dapr`, `dapr-placement` in
> `infra/docker-compose.yml`) were deleted: the outbox bus
> (`apps/api/src/core/event-bus.ts`) has fluvio/kafka drivers for the
> `EVENT_BUS_DRIVER` env, but NO driver ever consumed Dapr pub/sub — the
> component was provisioned-but-unused infrastructure, exactly the
> redundancy GAP-L04 flagged. Decision: **decommission-if-unused** rather
> than wire a third bus driver for zero consumers. If a Dapr-native bus is
> ever wanted, re-introduce it as an `EVENT_BUS_DRIVER=dapr` driver behind
> the same env-flag pattern as the fluvio/kafka stubs, with consumer
> offsets in Postgres (not broker-managed).
>
> The manifests below (state store component, tracing configuration,
> injector patch) remain as **opt-in reference material only** — nothing
> applies them by default and no sidecars are wired anywhere.

Optional Dapr control plane for the platform. What remains here mirrors the
(now sidecar-free) compose deployment for the state-store use case only.

## Install the control plane (official Helm chart)

```bash
helm repo add dapr https://dapr.github.io/helm-charts/
helm repo update
# Pinned to the same runtime version as the compose sidecars.
helm upgrade --install dapr dapr/dapr \
  --version 1.18.3 \
  --namespace dapr-system --create-namespace \
  --set global.ha.enabled=false \
  --wait
```

The chart installs the injector, operator, placement, and the `dapr.io/v1alpha1`
CRDs used by the manifests in this directory.

## Apply platform components

```bash
kubectl apply -f infra/k8s/dapr/component-statestore-redis.yaml
kubectl apply -f infra/k8s/dapr/configuration.yaml
```

- `component-statestore-redis.yaml` — `state.redis` -> `agric-redis:6379`,
  mirrors `infra/dapr/components/statestore-redis.yaml`.
- `configuration.yaml` — OTLP tracing to `otel-collector:4317`
  (samplingRate 1 for dev), Prometheus metrics on sidecar `:9090`.

The component is `scopes:`-restricted to `agric-api` / `agric-event-gw`.

## Sidecar injection

`patch-api-annotations.yaml` is a kustomize patch adding the injector
annotations to the `api` Deployment. It is deliberately NOT referenced from
`infra/k8s/base/kustomization.yaml`; enable it per overlay:

```yaml
# infra/k8s/overlays/<env>/kustomization.yaml (example)
patches:
  - path: ../../dapr/patch-api-annotations.yaml
```

The annotations are inert on clusters without the Dapr injector. The
event-gateway has no K8s manifest yet (compose-only service); when one is
added it takes the same annotations with `dapr.io/app-id: "agric-event-gw"`
and `dapr.io/app-port: "8090"`.

## Versioning

Runtime `1.18.3` everywhere (chart `dapr/dapr` 1.18.3 — chart version
tracks runtime version for Dapr releases).
