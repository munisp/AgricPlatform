//! geo-compute binary: config → router → serve. All logic lives in the lib.

#![forbid(unsafe_code)]

use geo_compute::config::{Config, Mode};
use geo_compute::handlers::{self, AppState};
use geo_compute::telemetry;
use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("[geo-compute] FATAL: {e}");
        std::process::exit(1);
    });

    // OpenTelemetry: no-op-safe (never fatal, collector may be absent).
    let telemetry_guard = telemetry::init(&config);

    match config.mode {
        Mode::Stub => eprintln!(
            "[geo-compute] WARNING: GEOCOMPUTE_MODE=stub — /v1/geo/h3/* returns deterministic \
             hand-rolled grid approximations (basis:\"stub\", NOT real H3). \
             Set GEOCOMPUTE_MODE=live for production h3o-backed H3."
        ),
        Mode::Live => eprintln!(
            "[geo-compute] mode=live — H3 endpoints backed by h3o {} (basis:\"live\")",
            handlers::H3O_VERSION
        ),
    }

    let port = config.port;
    let state = Arc::new(AppState::new(config));
    let app = handlers::router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("[geo-compute] FATAL: cannot bind {addr}: {e}");
            std::process::exit(1);
        });
    eprintln!("[geo-compute] listening on {addr}");
    let server = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());
    if let Err(e) = server.await {
        eprintln!("[geo-compute] FATAL: server error: {e}");
        std::process::exit(1);
    }
    // Flush pending spans before exit (bounded: batch processor shutdown has
    // its own timeout; a dead collector only logs warnings).
    telemetry_guard.shutdown();
    eprintln!("[geo-compute] stopped");
}

/// Graceful shutdown on SIGINT/SIGTERM (falls back to ctrl-c only on
/// platforms without signal support).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                ctrl_c.await;
                return;
            }
        };
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
}
