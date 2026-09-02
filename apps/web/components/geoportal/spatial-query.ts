import type { Bbox, PortalPlot } from './portal-plot';
import { plotInBbox } from './portal-plot';

/**
 * Client-side spatial queries on DuckDB-WASM — the GeoLibre
 * (github.com/opengeos/GeoLibre) in-browser GIS pattern: plot rows are
 * loaded into an in-browser DuckDB table and the drawn-bbox selection runs
 * as SQL (`WHERE long BETWEEN … AND lat BETWEEN …` — centroid-in-box, no
 * spatial extension download required).
 *
 * Lazy + fail-closed:
 *  - The WASM engine (~40 MB) is only fetched when the user first runs a
 *    spatial query; it is never in the page bundle.
 *  - Assets come from NEXT_PUBLIC_DUCKDB_CDN (default: jsDelivr, matching
 *    duckdb-wasm's own getJsDelivrBundles()). Production deployments that
 *    tighten CSP can self-host the four dist files and point the env var at
 *    their own origin.
 *  - The worker script is fetched as text and instantiated from a blob: URL
 *    so cross-origin worker construction is not needed; this requires
 *    `worker-src blob:` + `connect-src <cdn>` in CSP (see next.config.ts).
 *  - If the engine cannot initialise (offline, CDN unreachable, CSP), the
 *    caller gets a typed error and the UI shows an honest notice — the
 *    pure JS fallback (plotInBbox) is exported separately for tests.
 */

/** Row shape loaded into the DuckDB table. */
export interface SpatialPlotRow {
  id: string;
  name: string;
  source: string;
  lat: number;
  long: number;
  hectares: number;
  state?: string;
  practice?: string;
}

export class SpatialEngineError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SpatialEngineError';
  }
}

const DEFAULT_CDN = 'https://cdn.jsdelivr.net';

function duckdbCdnBase(): string {
  return (process.env.NEXT_PUBLIC_DUCKDB_CDN ?? DEFAULT_CDN).replace(/\/+$/, '');
}

type DuckDbModule = typeof import('@duckdb/duckdb-wasm');
type AsyncDuckDB = import('@duckdb/duckdb-wasm').AsyncDuckDB;

let enginePromise: Promise<AsyncDuckDB> | null = null;

/**
 * Build same-origin blob workers for a duckdb-wasm bundle. The npm CDN URLs
 * are cross-origin, which `new Worker(url)` rejects; fetching the script and
 * re-serving it from a blob keeps CSP at `worker-src blob:`.
 */
async function blobWorker(workerUrl: string): Promise<Worker> {
  const response = await fetch(workerUrl);
  if (!response.ok) {
    throw new SpatialEngineError(`DuckDB worker download failed (${response.status})`);
  }
  const source = await response.text();
  return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
}

async function createEngine(): Promise<AsyncDuckDB> {
  const duckdb: DuckDbModule = await import('@duckdb/duckdb-wasm');
  const cdn = duckdbCdnBase();
  const bundles = duckdb.getJsDelivrBundles();
  // Rebasing onto NEXT_PUBLIC_DUCKDB_CDN when operators self-host the dist files.
  const rebase = (url: string) => url.replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@duckdb\/duckdb-wasm@[^/]+\/dist/, cdn);
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: rebase(bundles.mvp.mainModule!),
      mainWorker: rebase(bundles.mvp.mainWorker!)
    },
    ...(bundles.eh
      ? {
          eh: {
            mainModule: rebase(bundles.eh.mainModule!),
            mainWorker: rebase(bundles.eh.mainWorker!)
          }
        }
      : {})
  });
  if (!bundle.mainWorker) {
    throw new SpatialEngineError('DuckDB bundle has no browser worker entry');
  }
  const worker = await blobWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

/** Singleton lazy engine; a failed attempt clears the cache so retry works. */
function getEngine(): Promise<AsyncDuckDB> {
  if (!enginePromise) {
    enginePromise = createEngine().catch((error) => {
      enginePromise = null;
      throw error instanceof SpatialEngineError
        ? error
        : new SpatialEngineError('DuckDB-WASM engine failed to initialise', error);
    });
  }
  return enginePromise;
}

/** Test hook: drop the cached engine between specs. */
export function resetSpatialEngine(): void {
  enginePromise = null;
}

/**
 * Run the drawn-bbox selection in DuckDB-WASM. Returns the matching plot
 * ids ordered by area (largest first), mirroring `plotInBbox` semantics.
 */
export async function queryPlotIdsInBbox(plots: PortalPlot[], bbox: Bbox): Promise<string[]> {
  // Bounds are interpolated into SQL below — reject non-finite values so the
  // statement can never be malformed (map bounds are always finite numbers).
  if (![bbox.minLong, bbox.minLat, bbox.maxLong, bbox.maxLat].every(Number.isFinite)) {
    throw new SpatialEngineError('Spatial query bounds are not finite numbers');
  }
  const rows: SpatialPlotRow[] = plots.map((plot) => ({
    id: plot.id,
    name: plot.name,
    source: plot.source,
    lat: plot.centroidLat,
    long: plot.centroidLong,
    hectares: plot.hectares,
    state: plot.state,
    practice: plot.practiceType
  }));

  const db = await getEngine();
  const conn = await db.connect();
  try {
    await conn.query('DROP TABLE IF EXISTS portal_plots');
    await db.registerFileText('portal_plots.json', JSON.stringify(rows));
    await conn.query(
      "CREATE TABLE portal_plots AS SELECT * FROM read_json_auto('portal_plots.json')"
    );
    const result = await conn.query(
      `SELECT id FROM portal_plots
       WHERE long >= ${bbox.minLong} AND long <= ${bbox.maxLong}
         AND lat >= ${bbox.minLat} AND lat <= ${bbox.maxLat}
       ORDER BY hectares DESC`
    );
    return (result.toArray() as Array<{ id: unknown }>).map((row) => String(row.id));
  } catch (error) {
    throw new SpatialEngineError('DuckDB spatial query failed', error);
  } finally {
    await conn.close();
  }
}

/** Pure fallback used when the engine is unavailable and in tests. */
export function queryPlotIdsInBboxPure(plots: PortalPlot[], bbox: Bbox): string[] {
  return plots
    .filter((plot) => plotInBbox(plot, bbox))
    .sort((a, b) => b.hectares - a.hectares)
    .map((plot) => plot.id);
}
