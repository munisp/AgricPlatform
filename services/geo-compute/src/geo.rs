//! Hand-rolled geodesy: validation, ring normalization, spherical area,
//! perimeter, centroid, bbox, self-intersection, ray casting, and
//! point-to-boundary distance.
//!
//! ## Formulas (documented, deterministic)
//!
//! - **Distance**: haversine on a sphere of radius [`EARTH_RADIUS_M`].
//! - **Area**: Chamberlain–Duquette spherical approximation,
//!   `A = R²/2 · |Σ (λᵢ₊₁−λᵢ)(sin φᵢ + sin φᵢ₊₁)|` (the same formula family
//!   used by the H3 library for cell area). Accurate to well under 1% for
//!   plot-scale polygons; error grows for polygons spanning many degrees.
//! - **Perimeter**: sum of haversine distances along the closed ring.
//! - **Centroid**: area-weighted planar centroid computed in a local
//!   equirectangular projection (`x = R·λ·cos φ₀`, `y = R·φ`, `φ₀` = mean
//!   ring latitude), mapped back to degrees. Not meaningful for polygons
//!   spanning the antimeridian or a pole (documented limitation).
//! - **Self-intersection**: O(n²) segment-pair test on the (lng, lat) plane.
//!   Any proper crossing OR touching (collinear overlap / non-adjacent
//!   vertex contact) marks the ring invalid.
//! - **Point-in-polygon**: ray casting with the half-open vertex rule;
//!   points exactly on the boundary are **inside** (documented behaviour).
//! - **Distance to boundary**: spherical cross-track distance, clamped to
//!   segment endpoints via the along-track check.
//!
//! Planar tests (ray casting, self-intersection) operate on raw degrees.
//! This is a documented plot-scale approximation: edges are treated as
//! straight in (lng, lat), not as great circles. Lat/lng are range-validated
//! but antimeridian-crossing polygons are NOT specially handled.

use crate::error::ApiError;

/// IUGG mean Earth radius, metres.
pub const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// Hard cap on polygon vertices (keeps the O(n²) self-intersection scan
/// bounded; 422 above).
pub const MAX_POLYGON_VERTICES: usize = 10_000;

/// Tolerance (degrees) for treating a cross product as zero / a point as
/// exactly on a segment. ~1e-12° is sub-atomic in metres; it only absorbs
/// floating-point representation noise, never real geometry.
const EPS_DEG: f64 = 1e-12;

/// A validated WGS84 position (degrees).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoPoint {
    pub lat: f64,
    pub lng: f64,
}

/// Validate a single coordinate pair (fail-closed).
pub fn validate_lat_lng(lat: f64, lng: f64) -> Result<(), ApiError> {
    if !lat.is_finite() || !(-90.0..=90.0).contains(&lat) {
        return Err(ApiError::unprocessable(
            "INVALID_COORDINATES",
            format!("lat must be a finite number in [-90, 90], got {lat}"),
        ));
    }
    if !lng.is_finite() || !(-180.0..=180.0).contains(&lng) {
        return Err(ApiError::unprocessable(
            "INVALID_COORDINATES",
            format!("lng must be a finite number in [-180, 180], got {lng}"),
        ));
    }
    Ok(())
}

/// Normalize a raw `[[lat, lng], ...]` ring:
///
/// - every coordinate is range-validated (422 `INVALID_COORDINATES`),
/// - **ring closure is auto-fixed**: a duplicated closing vertex is dropped,
///   an open ring is treated as implicitly closed (documented choice — the
///   alternative, 422 on unclosed rings, was rejected for interop with
///   callers that submit open rings),
/// - consecutive exact duplicates are dropped,
/// - the result must contain ≥ 3 distinct vertices (422 `INVALID_POLYGON`),
/// - at most [`MAX_POLYGON_VERTICES`] vertices (422 `POLYGON_TOO_COMPLEX`).
///
/// Returns an OPEN ring (no duplicated closing vertex).
pub fn normalize_ring(raw: &[[f64; 2]]) -> Result<Vec<GeoPoint>, ApiError> {
    if raw.len() < 3 {
        return Err(ApiError::unprocessable(
            "INVALID_POLYGON",
            format!("polygon must have at least 3 vertices, got {}", raw.len()),
        ));
    }
    if raw.len() > MAX_POLYGON_VERTICES + 1 {
        return Err(ApiError::unprocessable(
            "POLYGON_TOO_COMPLEX",
            format!(
                "polygon has {} vertices, max is {MAX_POLYGON_VERTICES}",
                raw.len()
            ),
        ));
    }
    let mut ring: Vec<GeoPoint> = Vec::with_capacity(raw.len());
    for (i, [lat, lng]) in raw.iter().enumerate() {
        validate_lat_lng(*lat, *lng).map_err(|mut e| {
            e.message = format!("vertex {i}: {}", e.message);
            e
        })?;
        let p = GeoPoint {
            lat: *lat,
            lng: *lng,
        };
        if ring.last() != Some(&p) {
            ring.push(p);
        }
    }
    // Auto-fix closure: drop the duplicated closing vertex if present.
    if ring.len() > 1 && ring.first() == ring.last() {
        ring.pop();
    }
    if ring.len() < 3 {
        return Err(ApiError::unprocessable(
            "INVALID_POLYGON",
            "polygon must have at least 3 distinct vertices",
        ));
    }
    Ok(ring)
}

/// Signed planar area on the (x=lng, y=lat) plane; positive = CCW.
pub fn signed_planar_area(ring: &[GeoPoint]) -> f64 {
    let n = ring.len();
    let mut sum = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        sum += a.lng * b.lat - b.lng * a.lat;
    }
    sum / 2.0
}

/// Winding normalization: return a CCW copy of the ring (reversed if needed).
pub fn to_ccw(ring: &[GeoPoint]) -> Vec<GeoPoint> {
    if signed_planar_area(ring) < 0.0 {
        ring.iter().rev().copied().collect()
    } else {
        ring.to_vec()
    }
}

/// Great-circle (haversine) distance in metres.
pub fn haversine_m(a: GeoPoint, b: GeoPoint) -> f64 {
    let phi1 = a.lat.to_radians();
    let phi2 = b.lat.to_radians();
    let dphi = (b.lat - a.lat).to_radians();
    let dlam = (b.lng - a.lng).to_radians();
    let h = (dphi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (dlam / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().clamp(-1.0, 1.0).asin()
}

/// Initial bearing from `a` to `b`, radians.
pub fn bearing_rad(a: GeoPoint, b: GeoPoint) -> f64 {
    let phi1 = a.lat.to_radians();
    let phi2 = b.lat.to_radians();
    let dlam = (b.lng - a.lng).to_radians();
    let y = dlam.sin() * phi2.cos();
    let x = phi1.cos() * phi2.sin() - phi1.sin() * phi2.cos() * dlam.cos();
    y.atan2(x)
}

/// Geodesic area of a closed ring, m² (Chamberlain–Duquette).
pub fn area_m2(ring: &[GeoPoint]) -> f64 {
    let n = ring.len();
    let mut sum = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let dlam = (b.lng - a.lng).to_radians();
        sum += dlam * (a.lat.to_radians().sin() + b.lat.to_radians().sin());
    }
    sum.abs() * EARTH_RADIUS_M * EARTH_RADIUS_M / 2.0
}

/// Geodesic perimeter of a closed ring, metres.
pub fn perimeter_m(ring: &[GeoPoint]) -> f64 {
    let n = ring.len();
    (0..n)
        .map(|i| haversine_m(ring[i], ring[(i + 1) % n]))
        .sum()
}

/// Area-weighted centroid in a local equirectangular projection anchored at
/// the first vertex (the local origin avoids catastrophic cancellation that
/// absolute projected coordinates would suffer at metre scale).
pub fn centroid(ring: &[GeoPoint]) -> GeoPoint {
    let n = ring.len();
    let phi0 = ring.iter().map(|p| p.lat).sum::<f64>() / n as f64;
    let cos_phi0 = phi0.to_radians().cos();
    let lat_ref = ring[0].lat.to_radians();
    let lng_ref = ring[0].lng.to_radians();
    let proj = |p: GeoPoint| {
        (
            EARTH_RADIUS_M * (p.lng.to_radians() - lng_ref) * cos_phi0,
            EARTH_RADIUS_M * (p.lat.to_radians() - lat_ref),
        )
    };
    let mut a = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..n {
        let (x1, y1) = proj(ring[i]);
        let (x2, y2) = proj(ring[(i + 1) % n]);
        let cross = x1 * y2 - x2 * y1;
        a += cross;
        cx += (x1 + x2) * cross;
        cy += (y1 + y2) * cross;
    }
    if a.abs() < f64::EPSILON {
        // Degenerate (zero-area) ring: fall back to the vertex mean.
        let lat = ring.iter().map(|p| p.lat).sum::<f64>() / n as f64;
        let lng = ring.iter().map(|p| p.lng).sum::<f64>() / n as f64;
        return GeoPoint { lat, lng };
    }
    cx /= 3.0 * a;
    cy /= 3.0 * a;
    GeoPoint {
        lat: (lat_ref + cy / EARTH_RADIUS_M).to_degrees(),
        lng: (lng_ref + cx / (EARTH_RADIUS_M * cos_phi0)).to_degrees(),
    }
}

/// `[min_lat, min_lng, max_lat, max_lng]`.
pub fn bbox(ring: &[GeoPoint]) -> [f64; 4] {
    let mut min_lat = f64::INFINITY;
    let mut min_lng = f64::INFINITY;
    let mut max_lat = f64::NEG_INFINITY;
    let mut max_lng = f64::NEG_INFINITY;
    for p in ring {
        min_lat = min_lat.min(p.lat);
        min_lng = min_lng.min(p.lng);
        max_lat = max_lat.max(p.lat);
        max_lng = max_lng.max(p.lng);
    }
    [min_lat, min_lng, max_lat, max_lng]
}

/// 2D cross product (b−a)×(c−a) on the (lng, lat) plane.
fn orient(a: GeoPoint, b: GeoPoint, c: GeoPoint) -> f64 {
    (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng)
}

/// Is `p` on segment a–b (within [`EPS_DEG`]), assuming collinearity?
fn on_segment(a: GeoPoint, b: GeoPoint, p: GeoPoint) -> bool {
    p.lng >= a.lng.min(b.lng) - EPS_DEG
        && p.lng <= a.lng.max(b.lng) + EPS_DEG
        && p.lat >= a.lat.min(b.lat) - EPS_DEG
        && p.lat <= a.lat.max(b.lat) + EPS_DEG
}

/// Do segments p1–p2 and p3–p4 intersect (crossing OR touching)?
pub fn segments_intersect(p1: GeoPoint, p2: GeoPoint, p3: GeoPoint, p4: GeoPoint) -> bool {
    let d1 = orient(p3, p4, p1);
    let d2 = orient(p3, p4, p2);
    let d3 = orient(p1, p2, p3);
    let d4 = orient(p1, p2, p4);
    if ((d1 > EPS_DEG && d2 < -EPS_DEG) || (d1 < -EPS_DEG && d2 > EPS_DEG))
        && ((d3 > EPS_DEG && d4 < -EPS_DEG) || (d3 < -EPS_DEG && d4 > EPS_DEG))
    {
        return true; // proper crossing
    }
    // Touching / collinear-overlap cases.
    (d1.abs() <= EPS_DEG && on_segment(p3, p4, p1))
        || (d2.abs() <= EPS_DEG && on_segment(p3, p4, p2))
        || (d3.abs() <= EPS_DEG && on_segment(p1, p2, p3))
        || (d4.abs() <= EPS_DEG && on_segment(p1, p2, p4))
}

/// Indices of self-intersecting non-adjacent segment pairs of a closed ring.
pub fn self_intersections(ring: &[GeoPoint]) -> Vec<(usize, usize)> {
    let n = ring.len();
    let mut hits = Vec::new();
    for i in 0..n {
        let a1 = ring[i];
        let a2 = ring[(i + 1) % n];
        for j in (i + 1)..n {
            // Skip the pair of segments that share a vertex (adjacent),
            // including the wrap-around pair (0, n-1).
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            let b1 = ring[j];
            let b2 = ring[(j + 1) % n];
            if segments_intersect(a1, a2, b1, b2) {
                hits.push((i, j));
            }
        }
    }
    hits
}

/// Is `p` exactly on a ring edge (within [`EPS_DEG`])?
fn point_on_ring(p: GeoPoint, ring: &[GeoPoint]) -> bool {
    let n = ring.len();
    (0..n).any(|i| {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        orient(a, b, p).abs() <= EPS_DEG && on_segment(a, b, p)
    })
}

/// Ray-casting point-in-polygon; boundary points count as INSIDE.
pub fn point_in_ring(p: GeoPoint, ring: &[GeoPoint]) -> bool {
    if point_on_ring(p, ring) {
        return true;
    }
    let n = ring.len();
    let mut inside = false;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        // Half-open rule makes vertex-height rays unambiguous.
        if (a.lat > p.lat) != (b.lat > p.lat) {
            let x_cross = (b.lng - a.lng) * (p.lat - a.lat) / (b.lat - a.lat) + a.lng;
            if p.lng < x_cross {
                inside = !inside;
            }
        }
    }
    inside
}

/// Spherical distance from `p` to segment a–b (cross-track clamped to the
/// endpoints), metres.
pub fn distance_point_to_segment_m(p: GeoPoint, a: GeoPoint, b: GeoPoint) -> f64 {
    let seg_m = haversine_m(a, b);
    if seg_m < 1e-9 {
        return haversine_m(a, p);
    }
    let d13 = haversine_m(a, p) / EARTH_RADIUS_M;
    if d13 < 1e-15 {
        return 0.0;
    }
    let t13 = bearing_rad(a, p);
    let t12 = bearing_rad(a, b);
    let xt = (d13.sin() * (t13 - t12).sin()).asin();
    if (t13 - t12).cos() < 0.0 {
        return haversine_m(a, p); // p is "behind" a: nearest endpoint is a
    }
    let cos_xt = xt.cos();
    if cos_xt.abs() < 1e-15 {
        return haversine_m(a, p); // degenerate (near-antipodal), fail safe
    }
    let at_m = (d13.cos() / cos_xt).clamp(-1.0, 1.0).acos() * EARTH_RADIUS_M;
    if at_m > seg_m {
        haversine_m(b, p)
    } else {
        xt.abs() * EARTH_RADIUS_M
    }
}

/// Minimum distance from `p` to the ring boundary, metres.
pub fn distance_to_boundary_m(p: GeoPoint, ring: &[GeoPoint]) -> f64 {
    let n = ring.len();
    (0..n)
        .map(|i| distance_point_to_segment_m(p, ring[i], ring[(i + 1) % n]))
        .fold(f64::INFINITY, f64::min)
}

/// Round to `dp` decimal places (deterministic output formatting).
pub fn round_dp(x: f64, dp: u32) -> f64 {
    let k = 10f64.powi(dp as i32);
    (x * k).round() / k
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(pts: &[[f64; 2]]) -> Vec<GeoPoint> {
        normalize_ring(pts).expect("test ring is valid")
    }

    fn p(lat: f64, lng: f64) -> GeoPoint {
        GeoPoint { lat, lng }
    }

    /// One hectare reference square centred on the equator (~100 m sides).
    fn one_hectare_square() -> Vec<[f64; 2]> {
        let half_deg = (50.0 / EARTH_RADIUS_M).to_degrees();
        let lat0 = 5.0;
        let lng0 = 20.0;
        vec![
            [lat0 - half_deg, lng0 - half_deg],
            [lat0 - half_deg, lng0 + half_deg],
            [lat0 + half_deg, lng0 + half_deg],
            [lat0 + half_deg, lng0 - half_deg],
        ]
    }

    #[test]
    fn haversine_matches_known_degree_of_latitude() {
        // 1° of latitude on a sphere of R = 6371008.8 m = R·π/180 m.
        let d = haversine_m(p(0.0, 0.0), p(1.0, 0.0));
        let expected = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;
        assert!((d - expected).abs() < 0.5, "got {d}, want {expected}");
        assert!((d - 111_195.08).abs() < 1.0, "got {d}");
    }

    #[test]
    fn area_of_one_hectare_square_within_one_percent() {
        let sq = ring(&one_hectare_square());
        let a = area_m2(&sq);
        assert!(
            (a - 10_000.0).abs() / 10_000.0 < 0.01,
            "1ha square area {a} m² deviates > 1%"
        );
    }

    #[test]
    fn area_of_one_degree_square_at_equator() {
        // Known value: (R·π/180)² ≈ 12_364 km² for a spherical 1°×1° cell.
        let sq = ring(&[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]]);
        let a_km2 = area_m2(&sq) / 1e6;
        let expected = (EARTH_RADIUS_M * std::f64::consts::PI / 180.0).powi(2) / 1e6;
        assert!(
            (a_km2 - expected).abs() / expected < 0.005,
            "1°² area {a_km2} km² vs {expected} km²"
        );
    }

    #[test]
    fn perimeter_of_one_hectare_square() {
        let sq = ring(&one_hectare_square());
        let per = perimeter_m(&sq);
        assert!(
            (per - 400.0).abs() / 400.0 < 0.005,
            "perimeter {per} m, want ~400 m"
        );
    }

    #[test]
    fn centroid_of_square_is_its_centre() {
        let sq = ring(&[
            [10.0, 20.0],
            [10.0, 20.001],
            [10.001, 20.001],
            [10.001, 20.0],
        ]);
        let c = centroid(&sq);
        assert!((c.lat - 10.0005).abs() < 1e-7, "lat {}", c.lat);
        assert!((c.lng - 20.0005).abs() < 1e-7, "lng {}", c.lng);
    }

    #[test]
    fn bbox_is_min_max() {
        let sq = ring(&[[10.0, 20.0], [10.0, 21.5], [12.25, 21.5], [12.25, 20.0]]);
        assert_eq!(bbox(&sq), [10.0, 20.0, 12.25, 21.5]);
    }

    #[test]
    fn bowtie_is_self_intersecting() {
        let bowtie = ring(&[[0.0, 0.0], [1.0, 1.0], [1.0, 0.0], [0.0, 1.0]]);
        let hits = self_intersections(&bowtie);
        assert!(!hits.is_empty(), "bowtie must be flagged self-intersecting");
    }

    #[test]
    fn simple_square_has_no_self_intersection() {
        let sq = ring(&[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]]);
        assert!(self_intersections(&sq).is_empty());
    }

    #[test]
    fn concave_polygon_has_no_self_intersection() {
        // L-shaped ring: concave but valid.
        let l = ring(&[
            [0.0, 0.0],
            [0.0, 2.0],
            [1.0, 2.0],
            [1.0, 1.0],
            [2.0, 1.0],
            [2.0, 0.0],
        ]);
        assert!(self_intersections(&l).is_empty());
    }

    #[test]
    fn winding_is_normalized_to_ccw() {
        let cw = ring(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]); // CW in (lng,lat)
        assert!(signed_planar_area(&cw) < 0.0);
        let ccw = to_ccw(&cw);
        assert!(signed_planar_area(&ccw) > 0.0);
        // Area is winding-independent.
        assert!((area_m2(&cw) - area_m2(&ccw)).abs() < 1e-6);
    }

    #[test]
    fn ring_closure_is_auto_fixed_both_ways() {
        let closed = ring(&[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]]);
        let open = ring(&[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]]);
        assert_eq!(closed, open, "closed ring must equal its deduped form");
        assert_eq!(closed.len(), 4);
    }

    #[test]
    fn fewer_than_three_distinct_vertices_rejected() {
        let err = normalize_ring(&[[1.0, 1.0], [1.0, 1.0], [1.0, 1.0]])
            .expect_err("degenerate ring must be rejected");
        assert_eq!(err.code, "INVALID_POLYGON");
        let err =
            normalize_ring(&[[1.0, 1.0], [2.0, 2.0]]).expect_err("two points must be rejected");
        assert_eq!(err.code, "INVALID_POLYGON");
    }

    #[test]
    fn coordinate_range_validation_is_strict() {
        assert!(validate_lat_lng(90.0, 180.0).is_ok());
        assert!(validate_lat_lng(-90.0, -180.0).is_ok());
        for (lat, lng) in [(90.0001, 0.0), (-91.0, 0.0), (0.0, 180.5), (0.0, -181.0)] {
            let err = validate_lat_lng(lat, lng).expect_err("out-of-range must fail");
            assert_eq!(err.code, "INVALID_COORDINATES");
        }
        for (lat, lng) in [(f64::NAN, 0.0), (0.0, f64::INFINITY)] {
            assert!(validate_lat_lng(lat, lng).is_err(), "non-finite must fail");
        }
    }

    #[test]
    fn ray_casting_inside_and_outside() {
        let sq = ring(&[[0.0, 0.0], [0.0, 2.0], [2.0, 2.0], [2.0, 0.0]]);
        assert!(point_in_ring(p(1.0, 1.0), &sq));
        assert!(!point_in_ring(p(3.0, 1.0), &sq));
        assert!(!point_in_ring(p(-1.0, 1.0), &sq));
        assert!(!point_in_ring(p(1.0, -1.0), &sq));
    }

    #[test]
    fn ray_casting_vertex_height_is_unambiguous() {
        // Ray at lat 0.0 passes exactly through the (0,0)/(0,2) vertex line.
        let sq = ring(&[[0.0, 0.0], [0.0, 2.0], [2.0, 2.0], [2.0, 0.0]]);
        assert!(
            point_in_ring(p(0.0, 1.0), &sq),
            "on vertex-height ray, inside"
        );
        assert!(
            !point_in_ring(p(0.0, 3.0), &sq),
            "on vertex-height ray, outside"
        );
        // Point exactly on a vertex.
        assert!(point_in_ring(p(0.0, 0.0), &sq), "vertex point is inside");
    }

    #[test]
    fn point_exactly_on_edge_is_inside_with_zero_distance() {
        let sq = ring(&[[0.0, 0.0], [0.0, 2.0], [2.0, 2.0], [2.0, 0.0]]);
        let edge = p(0.0, 1.0);
        assert!(point_in_ring(edge, &sq), "boundary point counts as inside");
        assert!(
            distance_to_boundary_m(edge, &sq) < 0.01,
            "distance to own edge must be ~0"
        );
    }

    #[test]
    fn distance_to_boundary_matches_known_offset() {
        // Point 0.001° of latitude north of the top edge midpoint of the 1 ha
        // reference square: ~111.195 m. (A small square keeps the great-circle
        // sagitta negligible, so the offset maps 1:1 to boundary distance.)
        let sq = ring(&one_hectare_square());
        let top_lat = 5.0 + (50.0 / EARTH_RADIUS_M).to_degrees();
        let d = distance_to_boundary_m(p(top_lat + 0.001, 20.0), &sq);
        let expected = EARTH_RADIUS_M * 0.001_f64.to_radians();
        assert!(
            (d - expected).abs() / expected < 0.01,
            "distance {d} m, want ~{expected} m"
        );
    }

    #[test]
    fn distance_to_segment_clamps_to_endpoints() {
        // Point beyond the segment end: distance goes to the endpoint.
        let a = p(0.0, 0.0);
        let b = p(0.0, 1.0);
        let beyond = p(0.0, 2.0);
        let d = distance_point_to_segment_m(beyond, a, b);
        assert!((d - haversine_m(b, beyond)).abs() < 0.01);
        // Point behind the start: distance goes to a.
        let behind = p(0.0, -1.0);
        let d = distance_point_to_segment_m(behind, a, b);
        assert!((d - haversine_m(a, behind)).abs() < 0.01);
    }
}
