# Sync Protocol v2 — Record-Level Offline Sync (Server Contract)

**Status:** v2, implemented by Wave SYNCSRV + FP-4 (change-set cursors,
claim-guarded push apply, tombstone ownership hardening). The first writable
entity (`farm_plot`) shipped in Wave W-SYNCWRITE. This document is the
contract the client-sync wave builds against (mobile/web offline stores).
Server code: `apps/api/src/modules/sync/`; schema: `infra/postgres/
024_sync.sql` + `infra/postgres/080_sync_change_seq.sql`.

The design ports the proven semantics from `munisp/farmer-data-collection`
(`server/sync-router.ts` idempotent push/pull, `mobile/.../conflict-resolver.ts`
version-vector conflict detection) onto the platform's NestJS repository
pattern. The protocol is deliberately **server-wins**: the server is the
authority; the protocol never silently overwrites server state.

**What changed in v2 (FP-4):**

1. **Pull cursors operate on a GLOBAL monotonic `change_seq`**, not on the
   per-record `version`. v1 compared `version > since`, so a cursor minted
   by a frequently-edited record permanently skipped every record whose
   per-record version lagged behind — silent, irreversible divergence across
   devices. v2 stamps every ledger write with the next value of a global
   sequence (migration 080 backfills existing rows in write order).
2. **Legacy-cursor guard:** pulls carrying a non-zero `since` MUST declare
   `v=2`. Anything else is answered **409 `sync_resync_required`** so
   pre-v2 devices fail loudly and resync instead of silently diverging (§6).
3. **Claim-guarded push apply:** the version-row CAS is held *around* the
   entity write (not after it), so a losing concurrent push never touches
   the source row (§9).
4. **Conflicts are recomputed, not ledgered** (§5), and conflict handling is
   hardened against entityId takeover via tombstones (§3).

---

## 1. Transport & Authentication

- Base path: `/api/v1/sync` (global `api/v1` prefix).
- All three endpoints require an authenticated identity
  (`Authorization: Bearer <OIDC JWT>`; the `x-user-id` development header only
  where dev-header auth is enabled). Anonymous callers get **401**.
- Every operation is **scoped to the caller** (see §3). There is no way to
  read or mutate another user's sync scope; admins may push to any record but
  pull/status remain per-caller scopes.
- Content type: `application/json`. All responses use the platform
  `{ "data": ... }` envelope.
- Rate limited by the global throttler (300 req/min/identity); sync clients
  should batch (§6).

## 2. Entities & the Registry

Only entities registered in the `SyncEntityRegistry` participate. The
registry ships two **read-only** proof entities plus the first **writable**
production entity:

| Entity key           | Source table                  | Owner (scope) field | Writable |
|----------------------|-------------------------------|---------------------|----------|
| `marketplace_listing`| `marketplace.listings`        | `sellerId`          | no       |
| `notification`       | `notifications.notifications` | `userId`            | no       |
| `farm_plot`          | `farms.farm_plots`            | `ownerUserId`       | **yes**  |

- **Read-only** means the server is the only writer: pulls work; push items
  for these entities are rejected per item with `error: "read_only_entity"`.
- **`farm_plot` (Wave W-SYNCWRITE)** accepts `upsert` and `delete` pushes:
  - Upsert payloads are full replacements validated like the REST DTO
    (`name`, `state`, `lga`, `centroidLat`, `centroidLong`, `sizeHectares`
    required; `boundaryGeojson`, `soilType`, `clientId` optional). A create
    (`baseVersion: 0`) persists the plot under the client-stable `entityId`,
    so the sync ledger and the source row share one identity; the
    `clientMutationId` is stored as the plot's `clientId` on creates.
  - Deletes cascade exactly like the REST delete (child plantings,
    harvests and expenses go with the plot) and leave a tombstone version
    row scoped to the original owner.
  - Writes through the REST endpoints (`FarmsService.createPlot` /
    `updatePlot` / `removePlot`) also advance `sync.entity_versions` under
    the same claim guard (§9), so server-side writes are sync-visible on
    the next pull and can never become sync-invisible silently.
  - Field-agent on-behalf capture is NOT routed through sync in v2: the
    field-agents module has no plot-capture write path to reuse, so
    `farm_plot` push/pull is scoped to the owning farmer (admins may push,
    per §3). If agent capture is added later it must come with its existing
    consent checks before joining this entity's writable path.
  - Tombstones need no `farm_plots` schema change: they live in
    `sync.entity_versions.deleted` (migration 024), whose `owner_id`
    captured at bump time keeps scoping intact after the source row is
    hard-deleted.
- Unknown entity keys are rejected: per-item `error: "unknown_entity"` on
  push, **400** on pull.
- **Extensibility (later waves):** the owning module injects
  `SyncEntityRegistry` and registers a `SyncableEntityDescriptor`
  (`name`, `ownerField`, `writable`, `getOwnerId`, `getPayloads`, and for
  writable entities `apply(actor, item)` which MUST advance
  `sync.entity_versions` via `EntityVersionRepository.applyGuarded` — the
  v2 claim guard, §9). No sync-module changes are required — `farm_plot` is
  the reference implementation (`apps/api/src/modules/farms/farms-sync.ts`).
  Writes through the entity's service must advance the ledger atomically
  with the entity write (claim-guarded, as `FarmsService` does) so
  server-side writes become sync-visible; `SyncVersioningService.recordChange`
  remains only as the legacy non-fatal hook for modules not yet on the
  guard, and its failures are counted by
  `agric_sync_version_bump_failures_total` (alertable, never silent).

## 3. Scoping Rules

- Every record's sync scope is its **owner id**, captured in
  `sync.entity_versions.owner_id` at bump time (so scoping survives deletion
  of the source row — tombstones still reach the owner).
- Pull and status only ever return rows whose `owner_id` equals the
  caller's user id.
- Push: the caller must be the record's owner or an admin. For an upsert of a
  record that does not exist yet, the caller becomes its owner. Violations
  return per-item `error: "forbidden"` and nothing is applied.
- **Tombstone ownership (v2):** when the live source row is gone, ownership
  resolves from the version ledger's `owner_id`. A create-style push over a
  **foreign tombstone** is `forbidden` — no entityId takeover — and it is
  rejected *before* the version CAS is evaluated, so the response carries no
  `serverVersion`/`serverPayload` oracle a caller could use to guess the
  tombstone's version. The original owner (or an admin) may re-create over
  their own tombstone through the normal CAS (§4).

## 4. Push — `POST /api/v1/sync/push`

Request:

```json
{
  "items": [
    {
      "entity": "farm",
      "entityId": "farm-123",
      "clientMutationId": "device-7-00041",
      "baseVersion": 3,
      "op": "upsert",
      "payload": { "...": "..." }
    }
  ]
}
```

| Field              | Rules                                                                 |
|--------------------|-----------------------------------------------------------------------|
| `entity`           | Registered entity key, 1–64 chars.                                     |
| `entityId`         | Client-stable text id, 1–128 chars.                                    |
| `clientMutationId` | Unique per (user, mutation), 1–128 chars. Drives idempotency (§5).     |
| `baseVersion`      | **Per-record** server version the change is based on. `0` = new record. This is the CAS counter only — never a pull cursor (§6). |
| `op`               | `"upsert"` (create/replace) or `"delete"` (tombstone).                 |
| `payload`          | Required for `upsert`, omitted for `delete`. ≤ 64 KiB JSON per item.   |

Batch limits: 1–200 items per request. Violations of batch shape, payload
presence/size, or field constraints fail the **whole request** with 400
(fail-closed; nothing is processed).

Response (always 200 for a well-formed batch — outcomes are per item):

```json
{
  "data": {
    "results": [
      { "entity": "farm", "entityId": "farm-123", "clientMutationId": "device-7-00041",
        "status": "applied", "newVersion": 4 },
      { "entity": "farm", "entityId": "farm-9", "clientMutationId": "device-7-00042",
        "status": "conflict", "serverVersion": 2, "serverPayload": { "...": "..." } },
      { "entity": "farm", "entityId": "farm-x", "clientMutationId": "device-7-00043",
        "status": "error", "error": "forbidden" }
    ]
  }
}
```

Per-item `status`:

- **`applied`** — the mutation was applied; `newVersion` is the record's new
  per-record server version. An audit record and a `sync.mutation.applied`
  domain event are emitted per applied item.
- **`conflict`** — `baseVersion` did not equal the current server version.
  The server state is untouched (never a silent overwrite; under the v2
  claim guard a *raced* push also surfaces as `conflict`, not a retryable
  `apply_failed`, because its payload provably never landed). `serverVersion`
  and the current `serverPayload` are returned so the client can rebase.
  **Server-wins resolution:** the client discards or rebases its local
  change onto the server payload, then may re-push with the fresh
  `baseVersion`. (The farmer-data-collection resolver's merge/local-wins
  strategies are client-side concerns and out of scope for the server.)
- **`error`** — not applied. Machine-readable `error` codes:
  `unknown_entity`, `read_only_entity`, `forbidden`, `mutation_id_reused`,
  `apply_failed`, `replay_unavailable`.

Items are independent: one conflict/error never blocks siblings.

## 5. Push Idempotency

- Outcomes are recorded in `sync.mutations` keyed by `(user_id,
  client_mutation_id)` — the `events.processed_events` dedup-ledger pattern,
  extended to store the outcome.
- Re-sending a batch (retry after timeout, offline-queue replay) returns the
  **original recorded outcome** for each already-seen `clientMutationId`;
  nothing is applied twice. Clients MUST keep `clientMutationId` stable across
  retries of the same logical mutation and MUST generate a fresh one for each
  new logical mutation.
- **Only `applied` outcomes are ledgered (v2).** A ledgered conflict would
  replay its stale `serverPayload` verbatim forever, regressing client caches
  that have since pulled a fresher version; conflicts are therefore
  **recomputed on retry** against current server state (a client that pushes
  a truly stale `baseVersion` deterministically gets a conflict back, so
  correctness is preserved without freezing payloads). Transient `error`
  results are likewise recomputed so a later attempt can succeed.
- Reusing a `clientMutationId` for a *different* mutation (different entity,
  entityId or op) is a client bug: the item fails with
  `error: "mutation_id_reused"`.
- **Retention (v2):** the ledger is pruned by the
  `SyncMutationRetentionService` sweeper (default: rows older than 90 days,
  batched, idempotent; `SWEEPERS_ENABLED=true` arms the in-process timer,
  or an external scheduler may invoke `sweep()`). Replays older than the
  retention window are realistically gone, so pruning cannot break dedup.

## 6. Pull — `GET /api/v1/sync/pull?entity=X&since=N&limit=M&v=2`

Query parameters:

- `entity` (required): registered entity key; unknown keys → 400.
- `since` (optional, default `0`): the **change_seq cursor** from the
  previous pull; `0` performs a full initial sync. Must be a non-negative
  integer → else 400.
- `limit` (optional, default `200`, max `500`): page size, clamped silently.
- `v` (required whenever `since > 0`): the protocol version the cursor
  belongs to — **2**. See the legacy-cursor guard below.

Response:

```json
{
  "data": {
    "entity": "marketplace_listing",
    "items": [
      { "entityId": "listing-1", "version": 7, "changeSeq": 41, "deleted": false, "payload": { "...": "..." } },
      { "entityId": "listing-2", "version": 8, "changeSeq": 42, "deleted": true,  "payload": null }
    ],
    "cursor": 42,
    "hasMore": true,
    "protocol": 2
  }
}
```

Semantics:

- Items are the caller-owned records with `change_seq > since`, **ordered by
  `change_seq` ascending**. Each item also carries its per-record `version`
  (needed for push `baseVersion` bookkeeping — and for nothing else).
- `cursor` is the maximum `change_seq` on the page (or `since` on an empty
  page) and is **monotonic per (caller, entity)**: it never regresses, even
  across empty pages or out-of-order requests. Pass it back as `since` (with
  `v=2`) on the next pull.
- `hasMore` is true when additional visible rows exist beyond this page;
  keep pulling until `hasMore` is false.
- The server also stores the latest handed-out cursor in `sync.sync_cursors`
  (monotonic `GREATEST`, stamped `protocol = 2`), surfaced via
  `/sync/status`. This is a diagnostic/recovery aid — the client-supplied
  `since` remains authoritative for what is returned. Pre-v2 cursor rows
  (`protocol = 1`) are stale and read as `0`.

### Legacy-cursor guard (the v1 → v2 migration rule)

v1 cursors counted **per-record versions**; v2 cursors count the global
`change_seq`. The two integer domains are unrelated, so accepting a v1
cursor as a v2 `since` would silently skip records forever. Therefore:

- A pull with `since > 0` and `v` missing or `< 2` is rejected with
  **409** and body `{ "statusCode": 409, "error": "sync_resync_required",
  "message": "resync_required: ..." }`.
- A pull with `since = 0` (full sync) is always accepted, with or without
  `v` — that *is* the recovery path.
- **Client recovery (mandatory):** on 409 `sync_resync_required`, the client
  resets its local cursor for that entity to `0` and re-pulls from scratch.
  The reference mobile/web stores do exactly this, once, before surfacing
  any further error. Legacy (v1) clients that cannot resync fail loudly on
  every pull — by design; the alternative was silent divergence.

## 7. Tombstones

- Deletes travel as `{ deleted: true, payload: null }` items. Clients MUST
  purge the local record and keep the per-record version for `baseVersion`
  bookkeeping.
- Tombstones are scoped like any row (`owner_id` captured at bump time), so a
  deleted record still reaches its owner's pull.
- If a live version row's source record is missing (out-of-band hard delete),
  the server fails closed and serves it as a tombstone rather than a stale
  payload.

## 8. Status — `GET /api/v1/sync/status`

```json
{ "data": [ { "entity": "notification", "serverMaxVersion": 42, "cursor": 40 } ] }
```

One entry per registered entity, scoped to the caller. **v2 field-name
note:** `serverMaxVersion` keeps its v1 wire name but now carries the
highest **change_seq** visible in the caller's scope (0 when nothing
visible) — it is comparable against v2 pull cursors only. `cursor` is the
server-recorded v2 pull cursor (stale v1 records are not surfaced). Clients
use this to cheaply detect "am I behind?" (`serverMaxVersion > cursor`)
before pulling.

## 9. Versioning Model

Two counters, two jobs (this replaces the v1 single-counter model and
resolves the old §6-vs-§9 contradiction):

- **`version`** — **per-record** monotonic integer starting at 1, kept in
  `sync.entity_versions` (`(entity, entity_id)` PK). It exists for exactly
  one purpose: the push **compare-and-set** on `baseVersion` (§4). It is
  never used to order pulls.
- **`change_seq`** — **global** monotonic sequence
  (`sync.entity_versions_change_seq_seq`, migration 080) stamped on every
  ledger write. Pulls order and filter on it; the pull cursor is a
  `change_seq` value. Existing rows were backfilled in write order
  (`updated_at, entity, entity_id`) during the migration.

Rules:

- Bumps are performed by **application code, not DB triggers** —
  `pgsql-ast-parser` (the migration linter) cannot parse `CREATE TRIGGER`,
  so `024_sync.sql` deliberately ships no trigger. See the design note in
  the migration.
- **Claim-guarded apply (v2, CAS discipline):** a writable entity's
  `apply()` MUST claim the version row atomically *around* the entity write
  via `EntityVersionRepository.applyGuarded`:
  1. The claiming statement (`INSERT … ON CONFLICT DO NOTHING` for creates,
     `UPDATE … WHERE version = :baseVersion` otherwise) runs in a
     transaction; on pg its row lock is held until COMMIT, so a concurrent
     claimant for the same record **blocks, then fails its CAS** — the
     loser NEVER runs its entity write, and its payload never touches the
     source row.
  2. Only the claimant performs the entity write. If the write throws, the
     claim rolls back, so the ledger never advances without the write.
  3. A lost claim surfaces as a per-item `conflict` (with the fresh
     `serverVersion`/`serverPayload`), never a retryable `apply_failed` and
     never a silent overwrite.
  The in-memory driver implements the same semantics (claim first, restore
  on failure); the pg driver holds the transaction across the write.
  `FarmsService` REST write paths (`createPlot`/`updatePlot`/`removePlot`)
  use the identical guard — a REST write that loses the claim gets **409
  Conflict** instead of silently overwriting a record a sync push just
  moved, and a failed REST write rolls its ledger claim back with it.
- The plain `bumpExpected` CAS remains available for code paths that do not
  perform an entity write; new writable sync entities MUST use
  `applyGuarded`.
- Server-side write paths advancing the ledger: `MarketplaceService`
  (create/update listing), `NotificationsService` (send, markRead),
  `FarmsService` (create/update/remove plot — claim-guarded — plus the sync
  push apply path itself). Legacy `recordChange` hook failures are
  observable via the `agric_sync_version_bump_failures_total` metric.

## 10. Client Retry Guidance

- Transport failures (5xx, timeouts, offline): retry with **exponential
  backoff with jitter** (suggested base 1 s, factor 2, cap 60 s), keeping
  `clientMutationId`s stable — replays are free.
- 401: refresh the token; do not retry the batch until re-authenticated.
  (The existing mobile/web transport queues already park on 401.)
- 400: the batch is malformed — do not retry unchanged; fix the payload.
- **409 `sync_resync_required` (pull):** reset the entity cursor to `0` and
  re-pull from scratch (§6). Do not retry with the old cursor.
- 409 Conflict (REST plot write): the record was modified concurrently —
  re-read and retry the edit; do not force the write.
- Per-item `conflict`: apply server-wins (take `serverPayload`, rebase or
  drop the local change); optionally re-push with the corrected
  `baseVersion` under a **new** `clientMutationId`. Clients MUST NOT apply a
  conflict payload whose `serverVersion` is older than the locally cached
  version (stale/replayed outcome — the reference stores ignore it).
- Per-item `error`: `forbidden`/`read_only_entity`/`unknown_entity`/
  `mutation_id_reused` are permanent — drop the mutation and surface
  diagnostics; `apply_failed`/`replay_unavailable` may be retried later.
- Offline outbox (client-side, reference stores): sequential offline edits
  to one record **coalesce** into a single pending entry rebased on the
  original `baseVersion` (latest payload wins — upserts are full
  replacements); the merged entry gets a fresh `clientMutationId` so a
  secretly-applied earlier mutation still surfaces as a proper conflict.
- Pull loops: page with `limit` ≤ 500 until `hasMore` is false; persist the
  cursor locally so app restarts resume incrementally.
- Offline mutation queue (mobile): queued requests carry per-kind TTLs —
  expired entries are dropped un-replayed and surfaced in the flush result
  (a month-old mutation must not apply month-old prices as current truth);
  entries sharing an explicit `chainKey` stop-on-error together, so a
  dependent mutation never replays after its parent failed.

## 11. Size Limits (summary)

| Limit                                   | Value   |
|-----------------------------------------|---------|
| Push batch items                        | 1–200   |
| Per-item payload                        | 64 KiB  |
| `clientMutationId` / `entityId` length  | 128     |
| Pull `limit` (default / max)            | 200/500 |
| Entity key length                       | 64      |
