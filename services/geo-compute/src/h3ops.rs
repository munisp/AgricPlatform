//! LIVE-mode H3 operations backed by the `h3o` crate (pure-Rust H3, same
//! index space as the `h3-js` 4.5.0 dependency used by `apps/api`).
//!
//! Known-answer vectors are shared with `apps/api/src/modules/geo/h3.service.spec.ts`
//! (ground truth computed with h3-js 4.5.0).

use crate::error::ApiError;
use crate::geo::GeoPoint;
use geo::{LineString, Polygon};
use h3o::geom::TilerBuilder;
use h3o::{CellIndex, LatLng, Resolution};

/// When the tiler's size upper-bound exceeds `max_cells` by more than this
/// factor the request is rejected without computing (fail-fast guard against
/// pathological inputs such as a whole-world polygon at resolution 15).
const HINT_GUARD_FACTOR: usize = 10;

/// Endpoint contract: resolutions 1..=15 (0 is rejected to keep parity with
/// the platform's practical floor; h3o supports 0 but the API does not).
pub fn parse_resolution(res: u8) -> Result<Resolution, ApiError> {
    if res == 0 {
        return Err(ApiError::unprocessable(
            "INVALID_RESOLUTION",
            "resolution must be an integer in 1..=15, got 0",
        ));
    }
    Resolution::try_from(res).map_err(|_| {
        ApiError::unprocessable(
            "INVALID_RESOLUTION",
            format!("resolution must be an integer in 1..=15, got {res}"),
        )
    })
}

/// H3 cell containing a point, as the canonical hex string.
pub fn point_to_cell(lat: f64, lng: f64, res: Resolution) -> Result<String, ApiError> {
    let ll = LatLng::new(lat, lng).map_err(|e| {
        ApiError::unprocessable("INVALID_COORDINATES", format!("invalid lat/lng: {e}"))
    })?;
    Ok(ll.to_cell(res).to_string())
}

/// Polygon → H3 cell coverage (centroid containment), hex strings.
///
/// Fail-closed cap: more than `max_cells` cells → 422 `H3_CELL_LIMIT`.
pub fn polygon_to_cells(
    ring: &[GeoPoint],
    res: Resolution,
    max_cells: usize,
) -> Result<Vec<String>, ApiError> {
    // geo::Polygon wants (x, y) = (lng, lat); h3o's tiler converts degrees to
    // radians itself. Close the ring explicitly for clarity.
    let mut coords: Vec<(f64, f64)> = ring.iter().map(|p| (p.lng, p.lat)).collect();
    if coords.first() != coords.last() {
        coords.push(coords[0]);
    }
    let polygon = Polygon::new(LineString::from(coords), vec![]);

    let mut tiler = TilerBuilder::new(res).build();
    tiler.add(polygon).map_err(|e| {
        ApiError::unprocessable("INVALID_POLYGON", format!("h3o rejected the polygon: {e}"))
    })?;

    let hint = tiler.coverage_size_hint();
    if hint > max_cells.saturating_mul(HINT_GUARD_FACTOR) {
        return Err(ApiError::unprocessable(
            "H3_CELL_LIMIT",
            format!(
                "polygon is far too large for resolution {}: upper-bound estimate {hint} cells \
                 (max {max_cells}); lower the resolution or split the polygon",
                u8::from(res)
            ),
        ));
    }

    let cells: Vec<CellIndex> = tiler.into_coverage().take(max_cells + 1).collect();
    if cells.len() > max_cells {
        return Err(ApiError::unprocessable(
            "H3_CELL_LIMIT",
            format!(
                "polygon produces more than {max_cells} cells at resolution {}; \
                 lower the resolution or split the polygon",
                u8::from(res)
            ),
        ));
    }
    Ok(cells.iter().map(|c| c.to_string()).collect())
}

/// Compact a set of H3 cells (in-place h3o compaction). Input is deduplicated
/// first (documented); mixed resolutions → 422 `H3_MIXED_RESOLUTIONS`;
/// unparseable cell → 422 `INVALID_H3_CELL`.
pub fn compact_cells(input: &[String]) -> Result<Vec<String>, ApiError> {
    let mut cells: Vec<CellIndex> = Vec::with_capacity(input.len());
    for (i, raw) in input.iter().enumerate() {
        let cell = raw.parse::<CellIndex>().map_err(|_| {
            ApiError::unprocessable(
                "INVALID_H3_CELL",
                format!("cells[{i}] is not a valid H3 cell index: '{raw}'"),
            )
        })?;
        cells.push(cell);
    }
    cells.sort_unstable();
    cells.dedup();
    CellIndex::compact(&mut cells).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("esolution") {
            ApiError::unprocessable(
                "H3_MIXED_RESOLUTIONS",
                "all cells must share one resolution to compact",
            )
        } else {
            ApiError::unprocessable("H3_COMPACTION", format!("compaction failed: {e}"))
        }
    })?;
    Ok(cells.iter().map(|c| c.to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::normalize_ring;

    // Ground truth from apps/api h3.service.spec.ts (h3-js 4.5.0):
    //   Zaria  (11.0855,  7.7199) → 85581b97fffffff / 87581b966ffffff / 89581b96683ffff
    //   Kano   (12.0022,  8.5920) → 85580a47fffffff / 87580a4edffffff / 89580a4ed37ffff
    const ZARIA: (f64, f64) = (11.0855, 7.7199);
    const KANO: (f64, f64) = (12.0022, 8.592);

    #[test]
    fn known_answer_zaria_cells_match_h3js() {
        assert_eq!(
            point_to_cell(ZARIA.0, ZARIA.1, Resolution::Five).unwrap(),
            "85581b97fffffff"
        );
        assert_eq!(
            point_to_cell(ZARIA.0, ZARIA.1, Resolution::Seven).unwrap(),
            "87581b966ffffff"
        );
        assert_eq!(
            point_to_cell(ZARIA.0, ZARIA.1, Resolution::Nine).unwrap(),
            "89581b96683ffff"
        );
    }

    #[test]
    fn known_answer_kano_cells_match_h3js() {
        assert_eq!(
            point_to_cell(KANO.0, KANO.1, Resolution::Five).unwrap(),
            "85580a47fffffff"
        );
        assert_eq!(
            point_to_cell(KANO.0, KANO.1, Resolution::Seven).unwrap(),
            "87580a4edffffff"
        );
        assert_eq!(
            point_to_cell(KANO.0, KANO.1, Resolution::Nine).unwrap(),
            "89580a4ed37ffff"
        );
    }

    #[test]
    fn resolution_zero_and_above_fifteen_rejected() {
        let err = parse_resolution(0).expect_err("res 0 rejected by endpoint contract");
        assert_eq!(err.code, "INVALID_RESOLUTION");
        let err = parse_resolution(16).expect_err("res 16 rejected");
        assert_eq!(err.code, "INVALID_RESOLUTION");
        assert!(parse_resolution(9).is_ok());
    }

    #[test]
    fn polygon_coverage_is_nonempty_same_resolution() {
        // ~1 km² square around Kano at res 9.
        let ring = normalize_ring(&[
            [12.000, 8.590],
            [12.000, 8.600],
            [12.010, 8.600],
            [12.010, 8.590],
        ])
        .unwrap();
        let cells = polygon_to_cells(&ring, Resolution::Nine, 100_000).unwrap();
        assert!(!cells.is_empty(), "a 1 km² plot must produce res-9 cells");
        for c in &cells {
            let idx: CellIndex = c.parse().expect("hex string parses back");
            assert_eq!(idx.resolution(), Resolution::Nine);
        }
        // Deterministic: same input, same output.
        let again = polygon_to_cells(&ring, Resolution::Nine, 100_000).unwrap();
        assert_eq!(cells, again);
    }

    #[test]
    fn cell_limit_is_enforced_with_422() {
        // ~11 km² square; res 11 cells are ~25 m edge → thousands of cells.
        let ring =
            normalize_ring(&[[12.00, 8.59], [12.00, 8.60], [12.01, 8.60], [12.01, 8.59]]).unwrap();
        let err =
            polygon_to_cells(&ring, Resolution::Eleven, 10).expect_err("tiny cap must be enforced");
        assert_eq!(err.code, "H3_CELL_LIMIT");
    }

    #[test]
    fn compaction_reduces_full_child_set_to_parent() {
        // The full set of res-9 children of a res-8 cell compacts to exactly
        // the parent (hexagon: 7 children → 1).
        let parent_str = point_to_cell(KANO.0, KANO.1, Resolution::Eight).unwrap();
        let parent: CellIndex = parent_str.parse().unwrap();
        let children: Vec<String> = parent
            .children(Resolution::Nine)
            .map(|c| c.to_string())
            .collect();
        assert_eq!(children.len(), 7, "hexagon res-8 cell has 7 res-9 children");
        let compacted = compact_cells(&children).unwrap();
        assert_eq!(
            compacted,
            vec![parent_str],
            "full child set must compact to the parent"
        );
    }

    #[test]
    fn compact_rejects_invalid_cell_strings() {
        let err =
            compact_cells(&["not-a-cell".to_string()]).expect_err("garbage cell must be rejected");
        assert_eq!(err.code, "INVALID_H3_CELL");
    }

    #[test]
    fn compact_rejects_mixed_resolutions() {
        let c5 = point_to_cell(KANO.0, KANO.1, Resolution::Five).unwrap();
        let c9 = point_to_cell(KANO.0, KANO.1, Resolution::Nine).unwrap();
        let err = compact_cells(&[c5, c9]).expect_err("mixed resolutions must be rejected");
        assert_eq!(err.code, "H3_MIXED_RESOLUTIONS");
    }

    #[test]
    fn compact_dedupes_input() {
        let c = point_to_cell(KANO.0, KANO.1, Resolution::Nine).unwrap();
        let out = compact_cells(&[c.clone(), c.clone(), c.clone()]).unwrap();
        assert_eq!(out, vec![c]);
    }
}
