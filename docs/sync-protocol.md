# Sync Protocol v1 — Record-Level Offline Sync (Server Contract)

**Status:** v1, implemented by Wave SYNCSRV; first writable entity
(`farm_plot`) shipped by Wave W-SYNCWRITE. This document is the contract the
client-sync wave builds against (mobile/web offline stores). Server code:
`apps/api/src/modules/sync/`; schema: `infra/postgres/024_sync.sql`.

The design ports the proven semantics from `munisp/farmer-data-collection`
(`server/sync-router.ts` idempotent push/pull, `mobile/.../conflict-resolver.ts`
version-vector conflict detection) onto the platform's NestJS repository
pattern. v1 is deliberately **server-wins**: the server is the authority; the
protocol never silently overwrites server state.

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
    `updatePlot` / `removePlot`) also bump `sync.entity_versions`, so
    server-side writes are sync-visible on the next pull.
  - Field-agent on-behalf capture is NOT routed through sync in v1: the
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
  `sync.entity_versions` via `EntityVersionRepository.bumpExpected`).
  No sync-module changes are required — `farm_plot` is the reference
  implementation (`apps/api/src/modules/farms/farms-sync.ts`). Writes
  through the entity's service must call
  `SyncVersioningService.recordChange(...)` so server-side writes become
  sync-visible.

## 3. Scoping Rules

- Every record's sync scope is its **owner id**, captured in
  `sync.entity_versions.owner_id` at bump time (so scoping survives deletion
  of the source row — tombstones still reach the owner).
- Pull and status only ever return rows whose `owner_id` equals the
  caller's user id.
- Push: the caller must be the record's owner or an admin. For an upsert of a
  record that does not exist yet, the caller becomes its owner. Violations
  return per-item `error: "forbidden"` and nothing is applied.

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
| `baseVersion`      | Server version the change is based on. `0` = "this is a new record".   |
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
  server version. An audit record and a `sync.mutation.applied` domain event
  are emitted per applied item.
- **`conflict`** — `baseVersion` did not equal the current server version.
  The server state is untouched (never a silent overwrite). `serverVersion`
  and the current `serverPayload` are returned so the client can rebase.
  **Server-wins resolution for v1:** the client discards or rebases its local
  change onto the server payload, then may re-push with the fresh
  `baseVersion`. (The farmer-data-collection resolver's merge/local-wins
  strategies are client-side concerns and out of scope for server v1.)
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
- Only deterministic data outcomes (`applied`, `conflict`) are ledgered.
  Transient `error` results are recomputed on retry so a later attempt can
  succeed.
- Reusing a `clientMutationId` for a *different* mutation (different entity,
  entityId or op) is a client bug: the item fails with
  `error: "mutation_id_reused"`.

## 6. Pull — `GET /api/v1/sync/pull?entity=X&since=N&limit=M`

Query parameters:

- `entity` (required): registered entity key; unknown keys → 400.
- `since` (optional, default `0`): the cursor from the previous pull; `0`
  performs a full initial sync. Must be a non-negative integer → else 400.
- `limit` (optional, default `200`, max `500`): page size, clamped silently.

Response:

```json
{
  "data": {
    "entity": "marketplace_listing",
    "items": [
      { "entityId": "listing-1", "version": 7, "deleted": false, "payload": { "...": "..." } },
      { "entityId": "listing-2", "version": 8, "deleted": true,  "payload": null }
    ],
    "cursor": 8,
    "hasMore": true
  }
}
```

Semantics:

- Items are the caller-owned records with `version > since`, **ordered by
  version ascending**.
- `cursor` is the maximum version returned (or `since` on an empty page) and
  is **monotonic per (caller, entity)**: it never regresses, even across
  empty pages or out-of-order requests. Pass it back as `since` on the next
  pull.
- `hasMore` is true when additional visible rows exist beyond this page;
  keep pulling until `hasMore` is false.
- The server also stores the latest handed-out cursor in `sync.sync_cursors`
  (monotonic `GREATEST`), surfaced via `/sync/status`. This is a
  diagnostic/recovery aid — the client-supplied `since` remains authoritative
  for what is returned.

## 7. Tombstones

- Deletes travel as `{ deleted: true, payload: null }` items. Clients MUST
  purge the local record and keep the version for `baseVersion` bookkeeping.
- Tombstones are scoped like any row (`owner_id` captured at bump time), so a
  deleted record still reaches its owner's pull.
- If a live version row's source record is missing (out-of-band hard delete),
  the server fails closed and serves it as a tombstone rather than a stale
  payload.

## 8. Status — `GET /api/v1/sync/status`

```json
{ "data": [ { "entity": "notification", "serverMaxVersion": 42, "cursor": 40 } ] }
```

One entry per registered entity, scoped to the caller: `serverMaxVersion` is
the highest version visible in the caller's scope (0 when nothing visible),
`cursor` the server-recorded pull cursor. Clients use this to cheaply detect
"am I behind?" (`serverMaxVersion > cursor`) before pulling.

## 9. Versioning Model

- Versions are **per-record monotonic integers** starting at 1, kept in
  `sync.entity_versions` (`(entity, entity_id)` PK). Every sync-visible write
  bumps exactly once.
- Bumps are performed by **application code, not DB triggers** —
  `pgsql-ast-parser` (the migration linter) cannot parse `CREATE TRIGGER`, so
  `024_sync.sql` deliberately ships no trigger; entity services call
  `SyncVersioningService.recordChange` after their primary write (additive,
  non-fatal). See the design note in the migration.
- Push concurrency control is a compare-and-set on the version
  (`bumpExpected`): the bump only lands when the current version equals the
  item's `baseVersion`. Two concurrent pushes for the same record cannot both
  win; the loser gets `conflict`.
- Server-side write paths currently bumping: `MarketplaceService`
  (create/update listing), `NotificationsService` (send, markRead),
  `FarmsService` (create/update/remove plot — plus the sync push apply path
  itself, which CAS-bumps via `bumpExpected`).

## 10. Client Retry Guidance

- Transport failures (5xx, timeouts, offline): retry with **exponential
  backoff with jitter** (suggested base 1 s, factor 2, cap 60 s), keeping
  `clientMutationId`s stable — replays are free.
- 401: refresh the token; do not retry the batch until re-authenticated.
  (The existing mobile/web transport queues already park on 401.)
- 400: the batch is malformed — do not retry unchanged; fix the payload.
- Per-item `conflict`: apply server-wins (take `serverPayload`, rebase or
  drop the local change); optionally re-push with the corrected
  `baseVersion` under a **new** `clientMutationId`.
- Per-item `error`: `forbidden`/`read_only_entity`/`unknown_entity`/
  `mutation_id_reused` are permanent — drop the mutation and surface
  diagnostics; `apply_failed`/`replay_unavailable` may be retried later.
- Pull loops: page with `limit` ≤ 500 until `hasMore` is false; persist the
  cursor locally so app restarts resume incrementally.

## 11. Size Limits (summary)

| Limit                                   | Value   |
|-----------------------------------------|---------|
| Push batch items                        | 1–200   |
| Per-item payload                        | 64 KiB  |
| `clientMutationId` / `entityId` length  | 128     |
| Pull `limit` (default / max)            | 200/500 |
| Entity key length                       | 64      |
