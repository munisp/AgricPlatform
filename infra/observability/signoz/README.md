# SigNoz stack assets (wave W4)

SigNoz is the platform's alert + notification + exploration backend. The
**hub collector** (`../otel-collector-config.yaml`) forwards all telemetry to
`signoz-otel-collector:4317`, which stores it in ClickHouse; alerts are
evaluated by the SigNoz query-service and dispatched by its alertmanager.

## Layout

| Path | Contents |
|---|---|
| `alerts/*.json` | Alert rules in SigNoz rule API format (one file per rule) |
| `channels/*.json` | Notification channel templates (slack / webhook / email) |

## Image pins (used by the compose snippet in ../README.md)

| Service | Image |
|---|---|
| clickhouse | `clickhouse/clickhouse-server:24.1.2-alpine` |
| zookeeper | `bitnami/zookeeper:3.7.1` |
| query-service | `signoz/query-service:0.55.0` |
| frontend | `signoz/frontend:0.55.0` |
| alertmanager | `signoz/alertmanager:0.23.5` |
| signoz-otel-collector | `signoz/signoz-otel-collector:0.111.13` |
| schema migrator | `signoz/signoz-schema-migrator:0.111.13` |

These pair per SigNoz's deploy repo conventions (0.5x era: query-service +
frontend + alertmanager as separate images; clickhouse 24.1.2-alpine is the
shipped default). NOTE: SigNoz >= 0.76 consolidates query-service/frontend/
alertmanager into the single `signoz/signoz` image — if you upgrade past
that, collapse the three services accordingly.

## Importing alert rules

Each `alerts/*.json` is a SigNoz `PostableRule` body (prom-query threshold
rules). Import with an API key from Settings -> API Keys:

```sh
for f in alerts/*.json; do
  curl -X POST "$SIGNOZ_URL/api/v1/rules" \
    -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" \
    -H 'Content-Type: application/json' --data @"$f"
done
```

…or paste each query into Alerts -> New Alert in the UI (threshold rule,
prom query tab). Rules reference notification channels by name
(`preferredChannels`) — create channels first, or strip that field.

## Creating notification channels

Each `channels/*.json` matches the SigNoz channel-create API
(`POST /api/v1/channels`). ALL VALUES ARE LABELLED DEV PLACEHOLDERS —
`REPLACE_WITH_*` strings must be substituted from the secret store; nothing
here is a real credential. Alternatively create them via
Settings -> Notification Channels in the UI with the same fields.
