# Dapr on Kubernetes (agric-platform)

Optional Dapr control plane for the platform. Everything here mirrors the
compose deployment (`infra/dapr/`, compose profile `dapr`).

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
kubectl apply -f infra/k8s/dapr/component-pubsub-redpanda.yaml
kubectl apply -f infra/k8s/dapr/component-statestore-redis.yaml
kubectl apply -f infra/k8s/dapr/configuration.yaml
```

- `component-pubsub-redpanda.yaml` — `pubsub.kafka` -> Redpanda (`:9092`),
  mirrors `infra/dapr/components/pubsub-redpanda.yaml`.
- `component-statestore-redis.yaml` — `state.redis` -> `agric-redis:6379`,
  mirrors `infra/dapr/components/statestore-redis.yaml`.
- `configuration.yaml` — OTLP tracing to `otel-collector:4317`
  (samplingRate 1 for dev), Prometheus metrics on sidecar `:9090`.

Both components are `scopes:`-restricted to `agric-api` / `agric-event-gw`.

## Sidecar injection

`patch-api-annotations.yaml` is a kustomize patch adding the injector
annotations to the `api` Deployment. It is deliberately NOT referenced from
`infra/k8s/kustomization.yaml`; enable it per overlay:

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

Runtime `1.18.3` everywhere (compose images `daprio/daprd:1.18.3`,
`daprio/placement:1.18.3`; chart `dapr/dapr` 1.18.3 — chart version tracks
runtime version for Dapr releases).
