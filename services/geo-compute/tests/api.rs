//! HTTP contract tests: boots the real axum router on an ephemeral port and
//! talks raw HTTP/1.1 over a Tokio TcpStream (no extra dev-dependencies —
//! the dependency set is deliberately minimal).

use geo_compute::config::{Config, Mode};
use geo_compute::handlers::{router, AppState};
use std::io::{Read, Write};
use std::net::TcpListener as StdListener;
use std::sync::Arc;

/// Boot the router on an ephemeral port in a dedicated runtime thread.
fn spawn_server(mode: Mode) -> std::net::SocketAddr {
    let std_listener = StdListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    std_listener.set_nonblocking(true).unwrap();
    let addr = std_listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async move {
            let config = Config {
                mode,
                ..Config::default()
            };
            let app = router(Arc::new(AppState::new(config)));
            let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
            axum::serve(listener, app).await.expect("server runs");
        });
    });
    addr
}

/// Minimal blocking HTTP/1.1 client → (status, body).
fn request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (u16, String) {
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).expect("write request");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read response");
    let status: u16 = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status line");
    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

fn post(addr: std::net::SocketAddr, path: &str, body: &str) -> (u16, serde_json::Value) {
    let (status, raw) = request(addr, "POST", path, Some(body));
    let json: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("body is JSON ({e}): {raw}"));
    (status, json)
}

const SQUARE: &str = "[[12.0,8.59],[12.0,8.6],[12.01,8.6],[12.01,8.59]]";

#[test]
fn healthz_and_readyz_report_mode_and_engine() {
    let addr = spawn_server(Mode::Live);
    let (status, raw) = request(addr, "GET", "/healthz", None);
    assert_eq!(status, 200);
    let health: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(health["status"], "ok");
    assert_eq!(health["mode"], "live");

    let (status, raw) = request(addr, "GET", "/readyz", None);
    assert_eq!(status, 200);
    let ready: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["mode"], "live");
    assert!(ready["h3o_version"].is_string());
    assert!(ready["uptime_seconds"].is_number());
}

#[test]
fn live_h3_index_and_compact_roundtrip() {
    let addr = spawn_server(Mode::Live);
    let body = format!(r#"{{"polygon": {SQUARE}, "resolution": 9}}"#);
    let (status, json) = post(addr, "/v1/geo/h3/index", &body);
    assert_eq!(status, 200, "{json}");
    assert_eq!(json["basis"], "live");
    assert!(json["count"].as_u64().unwrap() > 0);
    let cells = json["cells"].as_array().unwrap();
    for c in cells {
        let s = c.as_str().unwrap();
        assert!(!s.starts_with("STUB"), "live mode returns real H3 cells");
    }

    // Compact the coverage; must not grow.
    let compact_body = serde_json::json!({"cells": cells}).to_string();
    let (status, json) = post(addr, "/v1/geo/h3/compact", &compact_body);
    assert_eq!(status, 200, "{json}");
    assert_eq!(json["basis"], "live");
    let before = json["before"].as_u64().unwrap();
    let after = json["after"].as_u64().unwrap();
    assert_eq!(before, cells.len() as u64);
    assert!(after <= before);
}

#[test]
fn stub_mode_labels_everything_stub() {
    let addr = spawn_server(Mode::Stub);
    let body = format!(r#"{{"polygon": {SQUARE}, "resolution": 9}}"#);
    let (status, json) = post(addr, "/v1/geo/h3/index", &body);
    assert_eq!(status, 200, "{json}");
    assert_eq!(json["basis"], "stub");
    let first = json["cells"][0].as_str().unwrap();
    assert!(first.starts_with("STUB9:"), "stub ids are self-labelling");

    // Stub determinism over the wire: same request → identical body bytes.
    let (_, raw1) = request(addr, "POST", "/v1/geo/h3/index", Some(&body));
    let (_, raw2) = request(addr, "POST", "/v1/geo/h3/index", Some(&body));
    assert_eq!(raw1, raw2, "stub responses must be byte-identical");
}

#[test]
fn polygon_metrics_known_square() {
    let addr = spawn_server(Mode::Live);
    let body = format!(r#"{{"polygon": {SQUARE}}}"#);
    let (status, json) = post(addr, "/v1/geo/polygon/metrics", &body);
    assert_eq!(status, 200, "{json}");
    assert_eq!(json["valid"], true);
    assert_eq!(json["errors"], serde_json::json!([]));
    assert_eq!(json["winding"], "ccw");
    // ~0.01° × 0.01° square near Kano: 1111.95 m × (1111.95·cos 12°) m
    // ≈ 1.2094 km² ≈ 120.94 ha.
    let area = json["area_hectares"].as_f64().unwrap();
    assert!(area > 118.0 && area < 124.0, "area {area} ha");
    let per = json["perimeter_km"].as_f64().unwrap();
    assert!(per > 4.3 && per < 4.5, "perimeter {per} km");
    let c = &json["centroid"];
    assert!((c["lat"].as_f64().unwrap() - 12.005).abs() < 1e-6);
    assert!((c["lng"].as_f64().unwrap() - 8.595).abs() < 1e-6);
    assert_eq!(json["bbox"], serde_json::json!([12.0, 8.59, 12.01, 8.6]));
}

#[test]
fn bowtie_polygon_is_invalid_with_named_error() {
    let addr = spawn_server(Mode::Live);
    let body = r#"{"polygon": [[0.0,0.0],[1.0,1.0],[1.0,0.0],[0.0,1.0]]}"#;
    let (status, json) = post(addr, "/v1/geo/polygon/metrics", body);
    assert_eq!(status, 200, "{json}");
    assert_eq!(json["valid"], false);
    let errors = json["errors"].as_array().unwrap();
    assert!(!errors.is_empty());
    assert!(errors[0].as_str().unwrap().contains("self-intersection"));
}

#[test]
fn validation_errors_are_422_with_machine_codes() {
    let addr = spawn_server(Mode::Live);
    // resolution 0
    let body = format!(r#"{{"polygon": {SQUARE}, "resolution": 0}}"#);
    let (status, json) = post(addr, "/v1/geo/h3/index", &body);
    assert_eq!(status, 422, "{json}");
    assert_eq!(json["error"]["code"], "INVALID_RESOLUTION");
    // lat out of range
    let body = r#"{"polygon": [[95.0,8.59],[12.0,8.6],[12.01,8.6]], "resolution": 9}"#;
    let (status, json) = post(addr, "/v1/geo/h3/index", body);
    assert_eq!(status, 422, "{json}");
    assert_eq!(json["error"]["code"], "INVALID_COORDINATES");
    // fewer than 3 vertices
    let body = r#"{"polygon": [[12.0,8.59],[12.0,8.6]], "resolution": 9}"#;
    let (status, json) = post(addr, "/v1/geo/h3/index", body);
    assert_eq!(status, 422, "{json}");
    assert_eq!(json["error"]["code"], "INVALID_POLYGON");
    // malformed JSON → 400 BAD_JSON
    let (status, raw) = request(addr, "POST", "/v1/geo/h3/index", Some("{not json"));
    assert_eq!(status, 400, "{raw}");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["error"]["code"], "BAD_JSON");
}

#[test]
fn geofence_batch_over_http() {
    let addr = spawn_server(Mode::Live);
    let body = format!(
        r#"{{"polygon": {SQUARE}, "points": [
            {{"id":"a","lat":12.005,"lng":8.595}},
            {{"id":"b","lat":12.5,"lng":8.595}},
            {{"id":"c","lat":12.0,"lng":8.595}}
        ]}}"#
    );
    let (status, json) = post(addr, "/v1/geo/geofence/batch", &body);
    assert_eq!(status, 200, "{json}");
    assert_eq!(json["basis"], "live");
    assert_eq!(json["count"], 3);
    let inside: Vec<&str> = json["inside"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(inside, vec!["a", "c"], "c is on the boundary → inside");
    assert_eq!(json["outside"][0], "b");
    assert!(json["distances_m"]["b"].as_f64().unwrap() > 10_000.0);
    assert!(json["distances_m"]["c"].as_f64().unwrap() < 0.01);
}

#[test]
fn geofence_rejects_self_intersecting_polygon() {
    let addr = spawn_server(Mode::Live);
    let body = r#"{"polygon": [[0.0,0.0],[1.0,1.0],[1.0,0.0],[0.0,1.0]],
        "points": [{"id":"a","lat":0.5,"lng":0.5}]}"#;
    let (status, json) = post(addr, "/v1/geo/geofence/batch", body);
    assert_eq!(status, 422, "{json}");
    assert_eq!(json["error"]["code"], "INVALID_POLYGON");
}
