# EUDR Traceability Passport (wave-eudr)

Plot-to-shipment chain-of-custody for EU Deforestation Regulation (Regulation
(EU) 2023/1115) due-diligence evidence, with a DDS-shaped JSON export.

- API module: `apps/api/src/modules/traceability/`
- Persistence: `traceability` schema, migrations `infra/postgres/029_traceability.sql`
  and `030_traceability_dds.sql`
- Web console: `apps/web/app/traceability/` (+ `components/traceability-live.tsx`)
- Exporter surface: `/partner/traceability/*` behind the partner-api API-key /
  client-credentials guard (scopes `traceability:read` / `traceability:write`)

## Data model

| Table | Purpose | Mutability |
| --- | --- | --- |
| `traceability.commodity_lots` | A marketable quantity of one crop from one harvest window, owned by the creating farmer/cooperative. `parent_lot_ids` (jsonb) records genealogy. | Mutable: `status`, `quantity` (splits), `updated_at` only |
| `traceability.custody_events` | Append-only custody chain: `CREATED`, `AGGREGATED`, `SPLIT`, `TRANSFORMED`, `SHIPPED`, `RECEIVED`. | **Append-only** (no update/delete path in code) |
| `traceability.lot_plot_links` | Immutable geolocation evidence: a **copy** of the plot's lat/long (+ optional H3 cell) at link time. | **Append-only** |
| `traceability.shipments` | The unit a DDS is issued against. | `status` only (`created` → `exported`) |
| `traceability.shipment_lots` | Shipment composition, fixed at creation. | Append-only |

### Why geometry snapshots, not live FKs

EUDR Annex II requires the geolocation of production plots **as evidence**. A
live foreign key to `farms.farm_plots` would let a later plot edit
(re-survey, correction) silently rewrite the evidence attached to a
historical lot. `lot_plot_links` therefore copies `latitude`, `longitude`
(and optional `h3_cell`, computed app-side with h3-js — no PostGIS) at link
time and is never updated. Splits copy the parent's snapshots to the child;
aggregations inherit the union (deduped by plot id).

### Append-only without triggers

Platform migrations deliberately avoid triggers (portable plain SQL, no
hidden server-side behaviour, CI runs `postgres:16-alpine` without PostGIS).
DB-level immutability would need exactly such triggers, so custody integrity
is instead enforced by two cooperating mechanisms:

1. **App-level append-only**: the repository ports for `custody_events` and
   `lot_plot_links` expose `append/create/find` only — there is no update or
   delete statement anywhere in the codebase for these tables.
2. **Hash chain** (below): tamper evidence. Even a superuser editing a row
   directly breaks recomputation, and every verifier sees it.

Indexes include `custody_events.event_hash UNIQUE` and
`UNIQUE (lot_id, seq)` so a rewritten history collides at insert time.

## Hash-chain scheme

Each custody event stores `prev_event_hash` and `event_hash`:

```
prev_event_hash(event 0) = '0' * 64                     (genesis)
prev_event_hash(event n) = event_hash(event n-1)
event_hash = sha256_hex(canonical_json(payload))
```

Canonicalisation rules (must match to recompute):

- JSON with **object keys sorted recursively** (arrays keep order).
- No insignificant whitespace (`JSON.stringify` of the canonicalised value).
- `undefined` fields are dropped; optional fields are normalised to
  explicit `null` **before** hashing, so the form is writer-independent.
- `parentLotIds` is sorted before hashing.

Hashed payload (exactly these keys, sorted):

```
actorId, h3Cell, latitude, longitude, lotId, note, occurredAt,
parentLotIds, prevEventHash, quantity, seq, type, unit
```

`id` and `createdAt` are storage metadata and are deliberately not hashed.
`seq` is hashed and verified, so deleting a middle event is detectable.

Worked vector (pinned by `traceability-hash.spec.ts`):

```
canonical: {"actorId":"user-1","h3Cell":null,"latitude":11.0855,"longitude":7.7199,
            "lotId":"lot-1","note":null,"occurredAt":"2026-01-01T00:00:00.000Z",
            "parentLotIds":[],"prevEventHash":"000…000","quantity":100,"seq":0,
            "type":"CREATED","unit":"kg"}
sha256:    78ed49017f82cc6cd21d12dc0aa22d477a1a5f79bf4425615851ee316235fb2f
```

Verification (`GET /traceability/shipments/:id/dds/verify`, or the per-lot
timeline) recomputes every hash and prev link and returns per-event validity:
`hashValid` (payload untouched) and `prevLinkValid` (chain intact, no gap).

## DDS field mapping → EUDR Annex II information requirements

| DDS field | Annex II requirement | Honesty note |
| --- | --- | --- |
| `operator` | (a) operator name, address, EORI | **Placeholder** (`TO_BE_COMPLETED_BY_EXPORTER`, all nulls). The exporter legal entity must complete it; see Limits. |
| `commodity` / `quantity` | (b/c) commodity description and quantity | Crops and summed quantity per shipment; `unit: 'mixed'` when lots disagree. |
| `countryOfProduction` | (d) country of production | `NG` (platform scope). |
| `productionPlots` | (e) geolocation of all plots of land | From the immutable snapshots; includes `snapshotAt`. |
| `harvestWindow` | (e/f) production time range | Min start / max end across lots. |
| `custodySummary` | Supporting chain-of-custody evidence | Event count, types, first/last timestamps. |
| `deforestationRisk` | (Art. 10 risk-assessment inputs) | Proxy inputs via the geo-intel port; `basis` is honest (`stub`/`live`/`unavailable`/`none`). |
| `chainIntegrity` | Supporting evidence integrity | Recomputed hash-chain result + event count at export time. |

## API surface

Internal (authenticated platform users; ownership enforced in the service —
farmers own their lots, aggregator roles `buyer|supplier|partner|chapter_lead`
may append custody events and read lots already in their custody trail,
admins full access; `assertSelfOrAdmin`-style defence in depth):

```
POST /traceability/lots                 GET  /traceability/lots
GET  /traceability/lots/:id             POST /traceability/lots/aggregate
POST /traceability/lots/:id/events      GET  /traceability/lots/:id/timeline
POST /traceability/lots/:id/split       POST /traceability/lots/:id/plots
GET  /traceability/lots/:id/plots
POST /traceability/shipments            GET  /traceability/shipments[/:id]
GET  /traceability/shipments/:id/dds
GET  /traceability/shipments/:id/dds/verify
```

Exporter (partner-api guard, unchanged pattern):

```
POST /partner/traceability/shipments        scope traceability:write
GET  /partner/traceability/shipments/:id/dds         scope traceability:read
GET  /partner/traceability/shipments/:id/dds/verify  scope traceability:read
```

Partner-created shipments are owned by `partner:<clientId>`; DDS export and
verification are confined to shipments the same client created.

Domain events (outbox; stub-bus safe): `traceability.lot.created`,
`traceability.custody.recorded`, `traceability.lot.split`,
`traceability.lot.aggregated`, `traceability.plot.linked`,
`traceability.shipment.created`, `traceability.dds.exported`.

## Honest limits

- **Legal DDS submission is an external gate.** A submittable DDS requires
  the operator's registered legal identity (EORI) and legal review, and must
  be lodged by the operator in the EU Information System. This platform
  produces the evidence JSON and clearly marks the operator block
  `TO_BE_COMPLETED_BY_EXPORTER`; it does not and cannot submit.
- **No EU Information System integration** has been performed or verified.
- **Deforestation risk depends on geo providers.** The default deployment
  uses the geo-intel stub (deterministic simulated fixture): the DDS then
  says `deforestationRisk.basis = 'stub'`. With `FLOOD_ML_DRIVER=http` the
  basis is `live` when the sidecar answers and `unavailable` (fail-closed,
  never silently stubbed) when it does not. A dedicated deforestation feed
  is **not** integrated in this wave — the field is an environmental risk
  proxy and the note says so.
- **Hash chain is evidence, not prevention.** A database superuser can still
  rewrite rows; the chain guarantees any such rewrite is detected by every
  verifier. Full DB-level prevention would require triggers/RLS, avoided by
  platform convention (see above).
- h3 cells are computed app-side at res 7 where present; no PostGIS anywhere.
