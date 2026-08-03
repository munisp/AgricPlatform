//! STUB mode: deterministic hand-rolled approximations.
//!
//! **These are NOT H3 cells.** Cell ids are `STUB{res}:{lat_bin}:{lng_bin}`
//! on a plain square grid whose bin size approximates the H3 average hexagon
//! edge length at that resolution. Containment uses the same ray casting as
//! the geofence endpoint. Everything is deterministic (same input → same
//! output bytes) and every response carries `"basis":"stub"` so consumers
//! can refuse to treat the output as real H3.
//!
//! Fail-closed doctrine: production claims require `GEOCOMPUTE_MODE=live`.

use crate::error::ApiError;
use crate::geo::{point_in_ring, GeoPoint};
use std::collections::BTreeMap;

/// H3 average hexagon edge length per resolution, km (H3 documentation
/// table). Used ONLY to size the stub grid bins.
const AVG_EDGE_KM: [f64; 16] = [
    1107.712591,
    418.6760055,
    158.2446558,
    59.81085794,
    22.6063794,
    8.544408276,
    3.229482772,
    1.220629759,
    0.461354684,
    0.174375668,
    0.065907807,
    0.024910561,
    0.009415526,
    0.003559893,
    0.001348575,
    0.000509713,
];

/// Approximate km per degree of latitude (spherical, mean radius).
const KM_PER_DEG: f64 = 111.195;

fn bin_size_deg(res: u8) -> f64 {
    AVG_EDGE_KM[res as usize] / KM_PER_DEG
}

/// Stub polygon coverage: grid-bin centres inside the ring.
pub fn stub_polygon_to_cells(
    ring: &[GeoPoint],
    res: u8,
    max_cells: usize,
) -> Result<Vec<String>, ApiError> {
    let d = bin_size_deg(res);
    let (mut min_lat, mut min_lng) = (f64::INFINITY, f64::INFINITY);
    let (mut max_lat, mut max_lng) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in ring {
        min_lat = min_lat.min(p.lat);
        max_lat = max_lat.max(p.lat);
        min_lng = min_lng.min(p.lng);
        max_lng = max_lng.max(p.lng);
    }
    let i0 = (min_lat / d).floor() as i64;
    let i1 = (max_lat / d).floor() as i64;
    let j0 = (min_lng / d).floor() as i64;
    let j1 = (max_lng / d).floor() as i64;

    // Fail-fast guard: the bbox bin count is an upper bound on the coverage;
    // if it dwarfs the cap, reject without scanning (e.g. a country-sized
    // polygon at resolution 15 has ~10¹² bins).
    let total_bins = (i1 - i0 + 1) as u128 * (j1 - j0 + 1) as u128;
    if total_bins > max_cells as u128 * 4 {
        return Err(ApiError::unprocessable(
            "H3_CELL_LIMIT",
            format!(
                "stub grid coverage exceeds {max_cells} cells at resolution {res} \
                 (bbox upper bound {total_bins}); lower the resolution or split the polygon"
            ),
        ));
    }

    let mut cells = Vec::new();
    'outer: for i in i0..=i1 {
        for j in j0..=j1 {
            let centre = GeoPoint {
                lat: (i as f64 + 0.5) * d,
                lng: (j as f64 + 0.5) * d,
            };
            if point_in_ring(centre, ring) {
                cells.push(format!("STUB{res}:{i}:{j}"));
                if cells.len() > max_cells {
                    break 'outer;
                }
            }
        }
    }
    if cells.len() > max_cells {
        return Err(ApiError::unprocessable(
            "H3_CELL_LIMIT",
            format!(
                "stub grid coverage exceeds {max_cells} cells at resolution {res}; \
                 lower the resolution or split the polygon"
            ),
        ));
    }
    Ok(cells)
}

/// Parse a `STUB{res}:{i}:{j}` id.
fn parse_stub_cell(raw: &str) -> Option<(u8, i64, i64)> {
    let rest = raw.strip_prefix("STUB")?;
    let mut parts = rest.splitn(3, ':');
    let res: u8 = parts.next()?.parse().ok()?;
    let i: i64 = parts.next()?.parse().ok()?;
    let j: i64 = parts.next()?.parse().ok()?;
    if res > 15 || parts.next().is_some() {
        return None;
    }
    Some((res, i, j))
}

/// Stub compaction: children sharing a parent bin at res−1 are merged when
/// at least 7 of them map to the same parent (loosely mirroring H3's
/// full-set-of-7 rule — documented approximation). Deterministic output.
pub fn stub_compact_cells(input: &[String]) -> Result<Vec<String>, ApiError> {
    let mut parsed: Vec<(u8, i64, i64)> = Vec::with_capacity(input.len());
    for (idx, raw) in input.iter().enumerate() {
        let cell = parse_stub_cell(raw).ok_or_else(|| {
            ApiError::unprocessable(
                "INVALID_H3_CELL",
                format!(
                    "cells[{idx}] is not a stub cell id ('{raw}'); stub mode only compacts \
                     its own STUB{{res}}:{{i}}:{{j}} ids — use GEOCOMPUTE_MODE=live for real H3"
                ),
            )
        })?;
        parsed.push(cell);
    }
    parsed.sort_unstable();
    parsed.dedup();
    if parsed.is_empty() {
        return Ok(vec![]);
    }
    let res = parsed[0].0;
    if parsed.iter().any(|c| c.0 != res) {
        return Err(ApiError::unprocessable(
            "H3_MIXED_RESOLUTIONS",
            "all cells must share one resolution to compact",
        ));
    }
    if res == 0 {
        // Resolution 0 has no parent; return the deduplicated input.
        return Ok(parsed
            .iter()
            .map(|(r, i, j)| format!("STUB{r}:{i}:{j}"))
            .collect());
    }
    let d = bin_size_deg(res);
    let dp = bin_size_deg(res - 1);
    let mut groups: BTreeMap<(i64, i64), Vec<(i64, i64)>> = BTreeMap::new();
    for &(_, i, j) in &parsed {
        let pi = (i as f64 * d / dp).floor() as i64;
        let pj = (j as f64 * d / dp).floor() as i64;
        groups.entry((pi, pj)).or_default().push((i, j));
    }
    let mut out = Vec::new();
    for ((pi, pj), children) in groups {
        if children.len() >= 7 {
            out.push(format!("STUB{}:{}:{}", res - 1, pi, pj));
        } else {
            for (i, j) in children {
                out.push(format!("STUB{res}:{i}:{j}"));
            }
        }
    }
    out.sort();
    Ok(out)
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

    #[test]
    fn stub_index_is_deterministic_and_clearly_labelled() {
        let ring = kano_ring();
        let a = stub_polygon_to_cells(&ring, 9, 100_000).unwrap();
        let b = stub_polygon_to_cells(&ring, 9, 100_000).unwrap();
        assert_eq!(a, b, "stub output must be byte-identical across runs");
        assert!(!a.is_empty());
        for id in &a {
            assert!(
                id.starts_with("STUB9:"),
                "stub ids are self-labelling: {id}"
            );
            // And are NOT parseable as real H3 cells (no confusion possible).
            assert!(id.parse::<h3o::CellIndex>().is_err());
        }
    }

    #[test]
    fn stub_index_enforces_cell_cap() {
        // Whole of Nigeria at res 15 → astronomically many bins → 422.
        let ring = normalize_ring(&[[4.0, 3.0], [4.0, 14.0], [14.0, 14.0], [14.0, 3.0]]).unwrap();
        let err =
            stub_polygon_to_cells(&ring, 15, 100).expect_err("huge coverage must hit the cap");
        assert_eq!(err.code, "H3_CELL_LIMIT");
    }

    #[test]
    fn stub_compact_merges_seven_children() {
        // 8 adjacent res-9 bins in a 2x4 block share ≤2 parents; with ≥7 per
        // parent they collapse.
        let d = bin_size_deg(9);
        let dp = bin_size_deg(8);
        // Build 8 bins that all map to one parent bin.
        let mut cells = Vec::new();
        let mut seen_parent = None;
        'fill: for i in 0..50i64 {
            for j in 0..50i64 {
                let pi = (i as f64 * d / dp).floor() as i64;
                let pj = (j as f64 * d / dp).floor() as i64;
                match seen_parent {
                    None => seen_parent = Some((pi, pj)),
                    Some(pp) if pp != (pi, pj) => continue,
                    _ => {}
                }
                cells.push(format!("STUB9:{i}:{j}"));
                if cells.len() == 8 {
                    break 'fill;
                }
            }
        }
        assert_eq!(cells.len(), 8);
        let out = stub_compact_cells(&cells).unwrap();
        assert_eq!(out.len(), 1, "8 children of one parent must merge: {out:?}");
        assert!(out[0].starts_with("STUB8:"));
    }

    #[test]
    fn stub_compact_keeps_sparse_cells() {
        let cells = vec!["STUB9:0:0".to_string(), "STUB9:100:100".to_string()];
        let out = stub_compact_cells(&cells).unwrap();
        assert_eq!(out.len(), 2, "sparse cells must not merge");
    }

    #[test]
    fn stub_compact_rejects_foreign_ids_and_mixed_res() {
        let err = stub_compact_cells(&["89580a4ed37ffff".to_string()])
            .expect_err("real H3 ids are foreign to stub mode");
        assert_eq!(err.code, "INVALID_H3_CELL");
        let err = stub_compact_cells(&["STUB9:0:0".to_string(), "STUB8:0:0".to_string()])
            .expect_err("mixed resolutions rejected");
        assert_eq!(err.code, "H3_MIXED_RESOLUTIONS");
    }
}
