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

**MapLibre upgrade path** (if a richer basemap is wanted later): add
`maplibre-gl`, point a GeoJSON source at `GET /geo/farms/clusters` joined
client-side with `GET /geo/cells/:h3` boundaries (both already exist), and
configure a free tile source (e.g. OpenStreetMap raster tiles
`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, attribution required)
via a `NEXT_PUBLIC_MAP_TILES_URL` env var documented in `.env.example`.
The endpoints and data shapes do not change.
