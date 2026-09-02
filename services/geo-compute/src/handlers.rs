//! axum handlers: request/response contracts for the four compute endpoints
//! plus health/readiness.

use crate::config::{Config, Mode};
use crate::error::{ApiError, ValidatedJson};
use crate::geo::{self, GeoPoint};
use crate::{h3ops, stub};
use axum::extract::{MatchedPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tower_http::trace::TraceLayer;

/// OpenTelemetry server span for one request (picked up by the
/// `tracing-opentelemetry` layer when OTel is enabled; a plain tracing span
/// otherwise — fully no-op-safe). Named by the axum route template so span
/// names stay low-cardinality; `tenant.id` comes from the inbound
/// `x-tenant-id` header when present.
fn make_request_span(req: &axum::http::Request<axum::body::Body>) -> tracing::Span {
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());
    let tenant = req
        .headers()
        .get("x-tenant-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let span = tracing::info_span!(
        "http.request",
        "otel.kind" = "server",
        "otel.status_code" = tracing::field::Empty,
        "http.request.method" = %req.method(),
        "http.route" = %route,
        "url.path" = %req.uri().path(),
        "http.response.status_code" = tracing::field::Empty,
        "tenant.id" = tracing::field::Empty,
    );
    if let Some(tenant) = tenant {
        span.record("tenant.id", tenant);
    }
    span
}

/// Resolved h3o crate version (from Cargo.lock via build.rs).
pub const H3O_VERSION: &str = env!("GEOCOMPUTE_H3O_VERSION");

/// Shared application state.
pub struct AppState {
    pub config: Config,
    pub started: Instant,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            started: Instant::now(),
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/geo/h3/index", post(h3_index))
        .route("/v1/geo/h3/compact", post(h3_compact))
        .route("/v1/geo/polygon/metrics", post(polygon_metrics))
        .route("/v1/geo/geofence/batch", post(geofence_batch))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(make_request_span)
                .on_response(
                    |resp: &axum::http::Response<axum::body::Body>, _latency: std::time::Duration, span: &tracing::Span| {
                        span.record("http.response.status_code", resp.status().as_u16());
                    },
                ),
        )
        .with_state(state)
}

#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
    mode: String,
    version: &'static str,
}

async fn healthz(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        mode: state.config.mode.to_string(),
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
pub struct ReadyResponse {
    status: &'static str,
    mode: String,
    version: &'static str,
    /// Exact resolved h3o crate version (compiled in; used by the H3
    /// endpoints only in live mode).
    h3o_version: &'static str,
    uptime_seconds: u64,
    checks: BTreeMap<&'static str, &'static str>,
}

async fn readyz(State(state): State<Arc<AppState>>) -> Json<ReadyResponse> {
    let mut checks = BTreeMap::new();
    checks.insert("config", "ok");
    checks.insert("geometry_engine", "h3o compiled in-process");
    Json(ReadyResponse {
        status: "ready",
        mode: state.config.mode.to_string(),
        version: env!("CARGO_PKG_VERSION"),
        h3o_version: H3O_VERSION,
        uptime_seconds: state.started.elapsed().as_secs(),
        checks,
    })
}

// ---------- POST /v1/geo/h3/index ----------

#[derive(Deserialize)]
pub struct H3IndexRequest {
    /// `[[lat, lng], ...]`; open or closed ring, ≥3 distinct vertices.
    polygon: Vec<[f64; 2]>,
    resolution: u8,
}

#[derive(Serialize)]
pub struct H3IndexResponse {
    cells: Vec<String>,
    count: usize,
    resolution: u8,
    basis: &'static str,
}

async fn h3_index(
    State(state): State<Arc<AppState>>,
    ValidatedJson(req): ValidatedJson<H3IndexRequest>,
) -> Result<Json<H3IndexResponse>, ApiError> {
    let res = h3ops::parse_resolution(req.resolution)?;
    let ring = geo::normalize_ring(&req.polygon)?;
    let cells = match state.config.mode {
        Mode::Live => h3ops::polygon_to_cells(&ring, res, state.config.max_cells)?,
        Mode::Stub => stub::stub_polygon_to_cells(&ring, req.resolution, state.config.max_cells)?,
    };
    Ok(Json(H3IndexResponse {
        count: cells.len(),
        cells,
        resolution: req.resolution,
        basis: state.config.mode.basis(),
    }))
}

// ---------- POST /v1/geo/h3/compact ----------

#[derive(Deserialize)]
pub struct H3CompactRequest {
    cells: Vec<String>,
}

#[derive(Serialize)]
pub struct H3CompactResponse {
    cells: Vec<String>,
    before: usize,
    after: usize,
    basis: &'static str,
}

async fn h3_compact(
    State(state): State<Arc<AppState>>,
    ValidatedJson(req): ValidatedJson<H3CompactRequest>,
) -> Result<Json<H3CompactResponse>, ApiError> {
    if req.cells.len() > state.config.max_compact_input {
        return Err(ApiError::unprocessable(
            "TOO_MANY_CELLS",
            format!(
                "compact accepts at most {} input cells, got {}",
                state.config.max_compact_input,
                req.cells.len()
            ),
        ));
    }
    let before = req.cells.len();
    let cells = match state.config.mode {
        Mode::Live => h3ops::compact_cells(&req.cells)?,
        Mode::Stub => stub::stub_compact_cells(&req.cells)?,
    };
    let after = cells.len();
    Ok(Json(H3CompactResponse {
        cells,
        before,
        after,
        basis: state.config.mode.basis(),
    }))
}

// ---------- POST /v1/geo/polygon/metrics ----------

#[derive(Deserialize)]
pub struct PolygonMetricsRequest {
    polygon: Vec<[f64; 2]>,
}

#[derive(Serialize)]
pub struct CentroidResponse {
    lat: f64,
    lng: f64,
}

#[derive(Serialize)]
pub struct PolygonMetricsResponse {
    area_hectares: f64,
    perimeter_km: f64,
    centroid: CentroidResponse,
    /// `[min_lat, min_lng, max_lat, max_lng]`
    bbox: [f64; 4],
    valid: bool,
    errors: Vec<String>,
    /// Winding after normalization (input may be CW or CCW).
    winding: &'static str,
    basis: &'static str,
}

async fn polygon_metrics(
    State(state): State<Arc<AppState>>,
    ValidatedJson(req): ValidatedJson<PolygonMetricsRequest>,
) -> Result<Json<PolygonMetricsResponse>, ApiError> {
    let ring = geo::normalize_ring(&req.polygon)?;
    let ring = geo::to_ccw(&ring); // winding normalization

    let errors: Vec<String> = geo::self_intersections(&ring)
        .iter()
        .map(|(i, j)| format!("self-intersection between segments {i} and {j}"))
        .collect();

    let c = geo::centroid(&ring);
    Ok(Json(PolygonMetricsResponse {
        area_hectares: geo::round_dp(geo::area_m2(&ring) / 10_000.0, 6),
        perimeter_km: geo::round_dp(geo::perimeter_m(&ring) / 1_000.0, 6),
        centroid: CentroidResponse {
            lat: geo::round_dp(c.lat, 9),
            lng: geo::round_dp(c.lng, 9),
        },
        bbox: geo::bbox(&ring),
        valid: errors.is_empty(),
        errors,
        winding: "ccw",
        basis: state.config.mode.basis(),
    }))
}

// ---------- POST /v1/geo/geofence/batch ----------

#[derive(Deserialize)]
pub struct GeofencePoint {
    id: String,
    lat: f64,
    lng: f64,
}

#[derive(Deserialize)]
pub struct GeofenceBatchRequest {
    points: Vec<GeofencePoint>,
    polygon: Vec<[f64; 2]>,
}

#[derive(Serialize)]
pub struct GeofenceBatchResponse {
    inside: Vec<String>,
    outside: Vec<String>,
    /// Distance to the polygon boundary for every point, metres.
    distances_m: BTreeMap<String, f64>,
    count: usize,
    basis: &'static str,
}

/// Result of a geofence batch check.
pub type GeofenceOutcome = (Vec<String>, Vec<String>, BTreeMap<String, f64>);

/// Core batch check (also exercised directly by the perf test).
pub fn geofence_check(
    points: &[GeofencePoint],
    ring: &[GeoPoint],
    max_points: usize,
) -> Result<GeofenceOutcome, ApiError> {
    if points.len() > max_points {
        return Err(ApiError::unprocessable(
            "TOO_MANY_POINTS",
            format!(
                "batch accepts at most {max_points} points, got {}",
                points.len()
            ),
        ));
    }
    let mut seen = HashSet::with_capacity(points.len());
    let mut inside = Vec::new();
    let mut outside = Vec::new();
    let mut distances = BTreeMap::new();
    for pt in points {
        if pt.id.is_empty() {
            return Err(ApiError::unprocessable(
                "INVALID_POINT",
                "point id must be a non-empty string",
            ));
        }
        if !seen.insert(pt.id.clone()) {
            return Err(ApiError::unprocessable(
                "DUPLICATE_POINT_ID",
                format!("duplicate point id '{}'", pt.id),
            ));
        }
        geo::validate_lat_lng(pt.lat, pt.lng).map_err(|mut e| {
            e.message = format!("point '{}': {}", pt.id, e.message);
            e
        })?;
        let p = GeoPoint {
            lat: pt.lat,
            lng: pt.lng,
        };
        if geo::point_in_ring(p, ring) {
            inside.push(pt.id.clone());
        } else {
            outside.push(pt.id.clone());
        }
        distances.insert(
            pt.id.clone(),
            geo::round_dp(geo::distance_to_boundary_m(p, ring), 3),
        );
    }
    Ok((inside, outside, distances))
}

async fn geofence_batch(
    State(state): State<Arc<AppState>>,
    ValidatedJson(req): ValidatedJson<GeofenceBatchRequest>,
) -> Result<Json<GeofenceBatchResponse>, ApiError> {
    let ring = geo::normalize_ring(&req.polygon)?;
    // Ray casting is ill-defined on a self-intersecting ring: reject.
    let hits = geo::self_intersections(&ring);
    if !hits.is_empty() {
        return Err(ApiError::unprocessable(
            "INVALID_POLYGON",
            format!(
                "geofence polygon must not self-intersect (segments {} and {})",
                hits[0].0, hits[0].1
            ),
        ));
    }
    let (inside, outside, distances_m) =
        geofence_check(&req.points, &ring, state.config.max_points)?;
    let count = inside.len() + outside.len();
    Ok(Json(GeofenceBatchResponse {
        inside,
        outside,
        distances_m,
        count,
        basis: state.config.mode.basis(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::normalize_ring;

    fn kano_ring() -> Vec<GeoPoint> {
        normalize_ring(&[
            [12.000, 8.590],
            [12.000, 8.600],
            [12.010, 8.600],
            [12.010, 8.590],
        ])
        .unwrap()
    }

    fn pt(id: &str, lat: f64, lng: f64) -> GeofencePoint {
        GeofencePoint {
            id: id.to_string(),
            lat,
            lng,
        }
    }

    #[test]
    fn batch_splits_inside_outside_and_distances() {
        let ring = kano_ring();
        let points = vec![
            pt("in-1", 12.005, 8.595),
            pt("out-1", 12.100, 8.595),
            pt("edge-1", 12.000, 8.595), // on the boundary → inside
        ];
        let (inside, outside, distances) = geofence_check(&points, &ring, 100_000).unwrap();
        assert_eq!(inside, vec!["in-1", "edge-1"]);
        assert_eq!(outside, vec!["out-1"]);
        assert_eq!(distances.len(), 3);
        assert!(distances["edge-1"] < 0.01, "boundary distance ~0");
        assert!(distances["out-1"] > 1_000.0, "far point has real distance");
    }

    #[test]
    fn duplicate_point_ids_rejected() {
        let ring = kano_ring();
        let points = vec![pt("a", 12.005, 8.595), pt("a", 12.006, 8.595)];
        let err = geofence_check(&points, &ring, 100_000).expect_err("dup ids rejected");
        assert_eq!(err.code, "DUPLICATE_POINT_ID");
    }

    #[test]
    fn point_cap_enforced() {
        let ring = kano_ring();
        let points: Vec<GeofencePoint> = (0..5)
            .map(|i| pt(&format!("p{i}"), 12.005, 8.595))
            .collect();
        let err = geofence_check(&points, &ring, 3).expect_err("cap enforced");
        assert_eq!(err.code, "TOO_MANY_POINTS");
    }

    #[test]
    fn invalid_point_coordinates_rejected() {
        let ring = kano_ring();
        let points = vec![pt("bad", 91.0, 8.595)];
        let err = geofence_check(&points, &ring, 100_000).expect_err("bad coords rejected");
        assert_eq!(err.code, "INVALID_COORDINATES");
    }

    /// Soft time budget: 10k points against a 64-vertex ring must complete
    /// well within a generous wall-clock budget even in a debug build
    /// (documented in README; this is a smoke budget, not a benchmark).
    #[test]
    fn batch_10k_points_within_soft_budget() {
        // 64-vertex convex-ish ring (32-point star-free polygon: a circle
        // approximation around Kano).
        let n = 64;
        let ring: Vec<GeoPoint> = (0..n)
            .map(|i| {
                let t = i as f64 / n as f64 * 2.0 * std::f64::consts::PI;
                GeoPoint {
                    lat: 12.0 + 0.05 * t.sin(),
                    lng: 8.6 + 0.05 * t.cos(),
                }
            })
            .collect();
        // Grid spans the ring on both axes so inside/outside are both hit.
        let points: Vec<GeofencePoint> = (0..10_000)
            .map(|i| {
                let lat = 11.9 + (i % 200) as f64 * 0.001; // 11.900..12.099
                let lng = 8.5 + (i / 200) as f64 * 0.004; // 8.500..8.696
                pt(&format!("p{i}"), lat, lng)
            })
            .collect();
        let start = Instant::now();
        let (inside, outside, distances) =
            geofence_check(&points, &ring, 100_000).expect("batch succeeds");
        let elapsed = start.elapsed();
        assert_eq!(inside.len() + outside.len(), 10_000);
        assert_eq!(distances.len(), 10_000);
        assert!(!inside.is_empty() && !outside.is_empty());
        eprintln!(
            "[perf] 10k-point geofence batch against {n}-vertex ring: {elapsed:?} (debug build)"
        );
        // Very generous soft budget; debug CI was ~2 s. Release is >10x faster.
        assert!(
            elapsed.as_secs() < 30,
            "10k batch took {elapsed:?}, far above the soft 30 s budget"
        );
    }
}
