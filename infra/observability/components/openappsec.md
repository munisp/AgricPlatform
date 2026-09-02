# open-appsec telemetry (wave W4 snippet)

Compose services: `openappsec-agent` + `openappsec-nginx` (profile
`openappsec`, `ghcr.io/openappsec/agent` / `ghcr.io/openappsec/nginx-attachment`).

Honest status: **PARTIAL**. The nano-agent is closed-source instrumentation
with no OTel SDK; coverage is metrics scrape + log collection.

## Metrics — Prometheus port

The nano-agent exposes Prometheus-style metrics; open-appsec deployment
manifests conventionally use **port 8002**. The hub collector scrapes
`openappsec-agent:8002/metrics` (job `openappsec`). UNVERIFIED against the
pinned `:latest` image in this wave — if the port differs, retarget the job.
No config change exists in this repo to enable it; verify with:

```sh
docker compose --profile openappsec exec openappsec-agent \
  sh -c 'netstat -lnt 2>/dev/null || ss -lnt'
```

## Logs — filelog receiver

Agent logs land in the compose volume `appsec-logs` (`/var/log/nano_agent`),
nginx-attachment logs on the nginx container's stdout/volume. The hub
collector's `filelog/openappsec` receiver reads them from
`/var/log/openappsec/**` — which requires the integrator (W3) to mount the
volume read-only into the collector container:

```yaml
# otel-collector service addition:
volumes:
  - appsec-logs:/var/log/openappsec/nano_agent:ro
```

Security events (blocked requests, policy decisions) then appear as logs in
SigNoz with `log.source=openappsec`.

## Traces — none

The nginx attachment can propagate W3C `traceparent` headers upstream, but the
agent emits no spans. WAF decisions correlate to traces via the request log
lines above, not via span events.
