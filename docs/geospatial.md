# Geospatial pack (Wave GEO)

Best-of-both merge of the farmer-data-collection geospatial features (H3
analysis, map views, GIS workspace) onto AgricPlatform conventions.

## Hard constraint: no PostGIS

CI `db-contract` runs `postgres:16-alpine`, which ships **without** the
PostGIS extension. All geo data therefore stays in plain `double precision`
lat/long columns plus JSONB (`farms.farm_plots.boundary_geojson`, merged on
main in migration 022). Spatial indexing is computed in the **application
layer** with the [`h3-js`](https://github.com/uber/h3-js) library and
persisted to ordinary tables — no `CREATE EXTENSION` anywhere.

### Optional future ops upgrade: PostGIS

If operations later provisions a Postgres image with PostGIS (e.g.
`postgis/postgis:16-3.4`), the upgrade path is:

1. Add a migration with `CREATE EXTENSION IF NOT EXISTS postgis;` (guarded —
this repo's lint forbids unguarded DDL but extensions parse fine).
2. Add generated `geometry(Point, 4326)` columns beside the existing
   lat/long columns and `GIST` indexes; keep the JSONB columns as the source
   of truth so rollbacks stay lossless.
3. Swap `H3Service`-backed queries for `ST_DWithin` / `ST_Intersects` behind
   the same repository ports (`H3IndexRepository`, `GeoBoundaryRepository`)
   — services and controllers do not change.

Nothing in the current schema or API contract blocks this; it is purely an
ops decision and is **not required** for correctness today.

## Schema (migration 026, `geo` schema)

- `geo.h3_index` — one row per geo-located entity, PK `(entity, entity_id)`,
  with precomputed H3 cells at resolutions 5/7/9 (`h3_res5`, `h3_res7`,
  `h3_res9`), the raw `lat`/`long`, and `updated_at`. Indexed on
  `h3_res5`/`h3_res7` for ring/neighbourhood lookups.
- `geo.geo_boundaries` — named boundaries (`state | lga | ward | custom`)
  with an optional `parent_id` (state → lga → ward hierarchy) and the raw
  GeoJSON geometry as JSONB. Nothing is seeded; admins register boundaries
  via `POST /geo/boundaries`.

## Indexing flow

- `H3Service` (`apps/api/src/modules/geo/h3.service.ts`) is the only place
  h3-js is imported: `latLngToCell` at res 5/7/9, `gridDisk` for k-ring
  neighbourhoods, `cellToBoundary` for rendering polygons.
- **Event-driven auto-indexing:** the geo module subscribes to the farms
  module's domain events (`farms.plot.created` / `.updated` / `.removed`)
  via the `DomainEventsService` registry — the farms module is NOT
  modified. Handler failures are logged and never break the source write;
  the reindex endpoint repairs drift. Index changes publish
  `geo.h3_index.updated` / `geo.h3_index.removed` domain events.
- **Admin reindex:** `POST /geo/reindex` (admin, idempotent upserts, audit
  logged as `geo.reindex`, publishes `geo.h3_index.reindexed`) reports
  `{ scanned, indexed, skipped }` per entity. Coverage:
  - `farm_plot` — every plot's centroid (clean accessor:
    `FarmPlotRepository.all()`).
  - `profile` — member profiles whose `location.latitude/longitude` were
    captured (clean accessor: `ProfileRepository.all()`); profiles without
    coordinates are reported as `skipped`.
  - NOT covered (no coordinates to index): livestock-trade aggregation
    points and marketplace listings carry `state`/`lga` only. If they gain
    lat/long later, add them to `GEO_INDEXED_ENTITIES` and the reindex loop.

## Query API

| Endpoint | Authz | Purpose |
| --- | --- | --- |
| `GET /geo/farms/near?lat&long&res&ring` | authenticated | Farms in the k-ring around the cell at (lat, long). Managers (`admin`/`partner`/`chapter_lead`) see all plots; everyone else only their own (farms owner-scoping pattern). `res` ∈ {5,7,9}, `ring` ≤ 10 (fail-closed). |
| `GET /geo/farms/clusters?res=5` | `admin`/`partner`/`chapter_lead` | Farm counts per H3 cell for map rendering. |
| `GET /geo/boundaries?kind=` | authenticated | List named boundaries. |
| `POST /geo/boundaries` | `admin` | Register a boundary (audit logged). |
| `GET /geo/cells/:h3` | authenticated | Cell boundary as a closed GeoJSON Polygon for rendering. |
| `POST /geo/contains` | authenticated | Point-in-boundary check; see below. |

## Point-in-boundary helper (`POST /geo/contains`)

Ray casting over GeoJSON Polygon/MultiPolygon geometries — no geometry
library, no PostGIS (`packages/shared/src/geo.ts`,
`pointInGeojsonGeometry`). Accepts either a stored `boundaryId` or an
inline `geojson` geometry (exactly one). Deterministic semantics: a point
exactly on an edge or vertex counts as **inside**; points inside a polygon
hole (including the hole's edge) count as outside.

Introduced for **livestock movement-permit zone checks** (L1c follow-up):
a permit can require the destination point to lie inside an authorised
state/LGA boundary without any database geometry extension.

## Web cluster map (`/admin/geo`) — SVG, not MapLibre (deliberate)

The admin cluster map renders H3 cell polygons as an **SVG grid** coloured
by farm count (`apps/web/components/geo-cluster-map.tsx`). Rationale:

- MapLibre GL JS requires WebGL, which jsdom (the test environment) and
  some low-end field devices lack — the map would be untestable in CI.
- MapLibre pulls raster tiles from an external tile service at runtime;
  the SVG view is fully offline/self-contained.
- SVG output is deterministic (fixed viewBox + equirectangular projection),
  so tests assert exact geometry.

**MapLibre upgrade path** (if a richer basemap is wanted later): point a
GeoJSON source at `GET /geo/farms/clusters` joined client-side with
`GET /geo/cells/:h3` boundaries (both already exist). `maplibre-gl` and the
`NEXT_PUBLIC_MAP_TILES` tile-source env var (OSM default, `.env.example`)
landed with the `/map` portal — see the GeoPortal section below. The
endpoints and data shapes do not change.

## Farm-plot map portal (`/map`) — GeoLibre stack (wave W6)

The web app ships a production map portal at **`/map`**
(`apps/web/components/geoportal/` + `apps/web/app/map/`), built on the
[GeoLibre](https://github.com/opengeos/GeoLibre) client-side GIS stack:
React + MapLibre GL + DuckDB-WASM.

**Package decision (reimplementation, not npm dependency).** The portal is
built on GeoLibre's stack/design, NOT the vendored npm packages, for
React-dedupe and bundle-budget reasons (details below). GeoLibre ships
primarily as an application. It does publish npm packages
(`@geolibre/core`, `@geolibre/map`, `@geolibre/embed`), but they are not
consumable here: `@geolibre/map@2.8.0` lists `react`/`react-dom@^19.2.8` in
**dependencies** (not only peerDependencies), which would install a second,
mismatched React copy beside the platform's pinned `react@^19.1.0` and
break hooks, and it drags in Cesium, geotiff, pmtiles and the full turf
suite — none of which a plot portal needs and all of which the 250 KB
shell-bundle budget forbids. `@geolibre/core` is a Zustand store, a state
library this codebase deliberately avoids. The portal therefore
re-implements the GeoLibre component stack directly on `maplibre-gl` +
`@duckdb/duckdb-wasm` (the exact upstream stack), with header comments in
each `components/geoportal/` module crediting GeoLibre as the design and
component base. The module layout (`geoportal/` container, map view,
inspect/detail panel, filter bar, `spatial-query.ts` engine) mirrors the
upstream app's conventions so the container-deployed GeoLibre instance and
this portal stay structurally aligned.

**Data sources (all live; the portal fails closed, no fixtures):**

- Farm plots — `GET /farms/plots` (walked `boundaryGeojson` polygons;
  plots without a boundary render as centroid markers, never fabricated).
- Carbon MRV plots — `GET /vsla-carbon/plots`; the stored `h3Res9` index is
  expanded to a polygon client-side via `h3-js` `cellToBoundary` (the same
  derivation the API uses in `GET /geo/cells/:h3`).
- State boundaries — pinned public GeoJSON at
  `apps/web/public/geo/nigeria-states.geojson` (geoBoundaries gbOpen NGA
  ADM1, GRID3 source, CC BY 4.0, pinned commit `9469f09`, coordinates
  rounded to 4 dp; provenance in the file's `metadata` block). Also used
  client-side (ray casting, same algorithm as `geo.service contains()`) to
  tag carbon plots with a state so the state filter covers both sources.
- LGA/ward/custom boundaries — `GET /geo/boundaries` (admin-registered;
  drawn only when real geometry is returned).
- NDVI — provider badge from `GET /vsla-carbon/ndvi/status`; per-plot NDVI
  evidence shown in the detail panel when present.

**Client-side spatial query.** "Draw query box" → two clicks on the map →
`spatial-query.ts` loads the plotted rows into an in-browser DuckDB-WASM
table and selects plot ids with SQL (`long/lat BETWEEN …` — no spatial
extension download). The engine (~40 MB WASM) loads on demand only, from
`NEXT_PUBLIC_DUCKDB_CDN` (jsDelivr default; self-host the four dist files
to stay first-party). The worker is fetched as text and instantiated from a
`blob:` URL, so CSP needs only `worker-src blob:` + `connect-src <cdn>` —
no `script-src` relaxation. Engine failure shows an honest error panel with
an explicit built-in-filter fallback (`queryPlotIdsInBboxPure`, the tested
pure mirror of the SQL).

**Configuration.**

- `NEXT_PUBLIC_MAP_TILES` — raster tile URL template for the basemap
  (default `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, OSM
  attribution rendered on the map). No hardcoded API keys anywhere; pick a
  keyless source or self-host. The tile origin is added to CSP
  `img-src`/`connect-src` at build time (`next.config.ts`).
- `NEXT_PUBLIC_DUCKDB_CDN` — DuckDB-WASM asset origin (see above).

The map is loaded with `next/dynamic { ssr: false }`, so maplibre-gl never
enters the initial bundle (the `check:bundle` gate is unaffected) and the
page renders a skeleton until WebGL is ready; devices without WebGL get an
honest error panel and the plot lists remain available.
