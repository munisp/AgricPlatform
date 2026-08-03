# geo-compute — geospatial batch-compute sidecar (Rust)

CPU-heavy geospatial compute offloaded from the NestJS API: **H3
indexing/compaction** (pure-Rust [`h3o`](https://github.com/HydroniumLabs/h3o),
same H3 index space as the platform's `h3-js` 4.5.0), **polygon
validation/metrics**, and **geofence batch checks**. Stateless, single binary,
axum HTTP on port **8200**. Fail-closed doctrine mirrors
`services/event-gw` and `services/crop-ml` (`docs/flood-ml.md`).

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/healthz` | — | `{"status":"ok","mode","version"}` |
| GET | `/readyz` | — | readiness: mode, resolved **h3o version** (from Cargo.lock via build.rs), uptime, checks |
| POST | `/v1/geo/h3/index` | `{polygon: [[lat,lng],...], resolution: 1..15}` | `{cells, count, resolution, basis}` — polygon→cell coverage (centroid containment). **Cap: 100 000 cells** (env-tunable), 422 `H3_CELL_LIMIT` above, with a fail-fast upper-bound guard for pathological inputs |
| POST | `/v1/geo/h3/compact` | `{cells: [...]}` | `{cells, before, after, basis}` — h3o in-place compaction; input deduplicated; mixed resolutions → 422 `H3_MIXED_RESOLUTIONS`; bad cell → 422 `INVALID_H3_CELL` |
| POST | `/v1/geo/polygon/metrics` | `{polygon}` | `{area_hectares, perimeter_km, centroid, bbox, valid, errors[], winding, basis}` |
| POST | `/v1/geo/geofence/batch` | `{points: [{id,lat,lng}], polygon}` | `{inside: [ids], outside: [ids], distances_m: {id: m}, count, basis}` |

Errors: `{"error":{"code":"MACHINE_CODE","message":"..."}}` — **422** for
validation/limit failures (`INVALID_COORDINATES`, `INVALID_POLYGON`,
`INVALID_RESOLUTION`, `H3_CELL_LIMIT`, `INVALID_H3_CELL`,
`H3_MIXED_RESOLUTIONS`, `H3_COMPACTION`, `DUPLICATE_POINT_ID`,
`TOO_MANY_POINTS`, `TOO_MANY_CELLS`, `POLYGON_TOO_COMPLEX`), **400**
`BAD_JSON` for malformed bodies.

## Input validation & geometry conventions (documented choices)

- `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`, finite (422 otherwise). Polygon
  ≥ 3 distinct vertices, ≤ 10 000 vertices.
- **Ring closure is auto-fixed**: a duplicated closing vertex is dropped, an
  open ring is treated as implicitly closed. (Alternative — 422 on unclosed
  rings — was rejected for interop with callers submitting open rings.)
- **Winding normalization**: rings are normalized to CCW before metrics are
  computed; `winding:"ccw"` in the response states the post-normalization
  state. Area/perimeter are winding-independent.
- **Area**: Chamberlain–Duquette spherical approximation
  `A = R²/2 · |Σ (λᵢ₊₁−λᵢ)(sin φᵢ + sin φᵢ₊₁)|`, R = 6 371 008.8 m (IUGG
  mean radius). Sub-1 % error for plot-scale polygons; grows for polygons
  spanning many degrees. Verified: 1 ha reference square within 1 %.
- **Perimeter**: haversine sum. **Centroid**: area-weighted, computed in a
  local equirectangular projection anchored at the first vertex (avoids
  catastrophic cancellation). **bbox**: plain min/max — antimeridian-crossing
  polygons are NOT specially handled (known limitation).
- **Self-intersection**: O(n²) segment-pair test; any crossing *or touching*
  between non-adjacent segments → `valid:false` + named error
  (`self-intersection between segments i and j`). Bowtie covered by test.
- **Ray casting** (geofence): half-open vertex rule; **boundary points count
  as inside**; distance to boundary is spherical cross-track clamped to
  segment endpoints. Geofence polygons that self-intersect are rejected 422
  (ray casting is ill-defined there).
- Planar tests operate on raw degrees (plot-scale approximation; edges are
  not treated as great circles for intersection/containment).

## Fail-closed modes

| `GEOCOMPUTE_MODE` | Behaviour |
|---|---|
| `stub` (**default**) | `/v1/geo/h3/*` returns **deterministic hand-rolled grid approximations — NOT H3**. Cell ids are self-labelling (`STUB{res}:{i}:{j}`, square grid sized by the H3 average edge-length table, ray-casting containment) and do not parse as H3. A loud startup warning is printed. Every response carries `"basis":"stub"`. Development/CI only. |
| `live` | `/v1/geo/h3/*` backed by h3o (real H3). Responses carry `"basis":"live"`. **Production claims require live mode.** |
| anything else | **FATAL startup error, exit 1** (verified: `GEOCOMPUTE_MODE=bogus` → exit 1) |

Polygon metrics and geofence math are always computed in-process with the
documented formulas (there is no external geometry engine to swap); `basis`
still reflects the configured mode for governance parity.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GEOCOMPUTE_MODE` | `stub` | `stub` or `live` (fail-closed; unknown → startup exit 1) |
| `GEOCOMPUTE_PORT` | `8200` | Listen port |
| `GEOCOMPUTE_MAX_CELLS` | `100000` | Cap on `/v1/geo/h3/index` coverage (422 above) |
| `GEOCOMPUTE_MAX_POINTS` | `100000` | Cap on `/v1/geo/geofence/batch` points (422 above) |
| `GEOCOMPUTE_MAX_COMPACT_INPUT` | `1000000` | Cap on `/v1/geo/h3/compact` input cells (422 above) |

## Verification evidence

Toolchain: **rustc 1.97.1 (8bab26f4f 2026-07-14), cargo 1.97.1 (c980f4866
2026-06-30)**, resolved h3o **0.9.5**, axum 0.8.9, tokio 1.53.1, geo 0.33
(default-features off — same instance h3o pulls; adds zero crates to the
tree). Dependency set deliberately minimal: `axum`, `tokio`, `serde`,
`serde_json`, `h3o`, `geo` (+ build.rs reading Cargo.lock for the resolved
h3o version reported by `/readyz`).

All commands run from `services/geo-compute/`, exit codes captured to files:

```bash
cargo fmt --check                  # EXIT=0
cargo clippy --all-targets -- -D warnings   # EXIT=0
cargo test                         # EXIT=0 — 50 tests
#   42 lib tests + 8 HTTP contract tests (real axum server on an ephemeral
#   port, raw HTTP/1.1 over TcpStream — no extra dev-dependencies)
cargo build --release              # EXIT=0 (binary: target/release/geo-compute)
```

Test coverage includes:

- **Known-answer H3 vectors shared with the API**: Zaria (11.0855, 7.7199) →
  `85581b97fffffff` / `87581b966ffffff` / `89581b96683ffff` and Kano
  (12.0022, 8.5920) → `85580a47fffffff` / `87580a4edffffff` /
  `89580a4ed37ffff` at res 5/7/9 — the same ground truth (h3-js 4.5.0) as
  `apps/api/src/modules/geo/h3.service.spec.ts`. h3o matches h3-js exactly.
- Compaction: full 7-child res-9 set → exactly the res-8 parent; mixed
  resolutions → 422; garbage cells → 422; input dedup.
- Area of a 1 ha reference square within 1 %; 1°² equatorial cell vs known
  spherical value; perimeter of the 1 ha square ≈ 400 m; centroid of a
  square is its centre; bbox; winding normalization; ring closure both ways.
- Self-intersecting bowtie → `valid:false` with named segment error
  (unit + HTTP); concave L-ring is valid; adjacent segments never false-positive.
- Ray-casting edge cases: vertex-height rays, point exactly on a vertex,
  point exactly on an edge (inside, distance ~0); cross-track clamped to
  endpoints; known 111.195 m offset within 1 %.
- Batch split inside/outside + per-point distances; duplicate ids → 422;
  caps → 422; coordinate validation rejections; mode gating (unknown mode
  refuses to boot).
- **Stub determinism**: same request → byte-identical response bodies
  (asserted over HTTP); stub ids are self-labelling and do not parse as H3.
- **Soft perf budget**: 10 000 points against a 64-vertex ring completed in
  **394 ms in a debug build** (`[perf]` line via `--nocapture`); the test
  asserts a generous 30 s ceiling — it is a smoke budget, not a benchmark.

Live smoke run of the release binary (stub + live modes): `/healthz`,
`/readyz` (reports `h3o_version:"0.9.5"`), `/v1/geo/h3/index` returning real
H3 cells including the Kano known-answer cell `89580a4ed37ffff`,
`/v1/geo/polygon/metrics` (120.939308 ha for the 0.01°² Kano square),
`/v1/geo/geofence/batch`, stub-mode `STUB9:*` ids, and
`GEOCOMPUTE_MODE=bogus` → exit 1.

### Docker

**Not executed in the authoring sandbox (no docker daemon).** Intended:

```bash
docker build -t agricplatform/geo-compute:local services/geo-compute
docker run --rm -p 8200:8200 -e GEOCOMPUTE_MODE=live agricplatform/geo-compute:local
```

Multi-stage `rust:1.97-slim-bookworm` build (`cargo build --release
--locked`, Cargo.lock committed) → `gcr.io/distroless/cc-debian12:nonroot`,
EXPOSE 8200. The distroless image has no shell/curl — health-check
`/healthz` from outside the container.

### Compose fragment

`compose.geo-compute.yml` is a **service fragment only** (profile
`geo-compute`); merge instructions in its header. It does not modify the
root compose file.

## Lakehouse / Sedona bridge (intended, NOT wired)

These outputs (H3 coverages, compaction results, plot metrics, geofence
verdicts) are designed to land as **parquet in the MinIO lakehouse via the
batch path**, where the one-shot Apache Sedona job
(`infra/sedona/batch-geo.py`, profile `sedona` — see
`docs/integration-fabric.md` §11) can consume them with spatial SQL. Direct
coupling to a Sedona/Spark cluster from this service is **intentionally
avoided**: geo-compute stays a stateless CPU sidecar on the request-adjacent
path; Sedona stays batch-only.

## Honest limitations — NOT verified

- **Docker build was not executed** (no docker daemon in the sandbox). The
  Dockerfile follows the sibling services' pattern but is not build-verified.
- **No load profile**: the only timing evidence is the 10k-point debug-build
  smoke number above. No concurrency/throughput benchmarking was done.
- **No live cluster integration**: nothing calls this service yet; the
  NestJS↔geo-compute wiring and the lakehouse/Sedona handoff are designed
  (above) but not implemented here.
- Antimeridian-crossing and pole-spanning polygons are not specially
  handled; planar tests treat degrees as a plane (documented plot-scale
  approximation).
- Stub-mode output is a development fixture. Consumers must check `basis`
  before treating H3 endpoints' output as real H3.
