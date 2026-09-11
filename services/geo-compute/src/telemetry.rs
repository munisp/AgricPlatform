//! OpenTelemetry wiring for geo-compute.
//!
//! No-op-safe contract (mirrors services/event-gw and the Python sidecars):
//!
//! - `OTEL_ENABLED` (default true): any of `false|0|no|off` disables
//!   telemetry entirely — no SDK is constructed, only the fmt log layer is
//!   installed.
//! - `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`):
//!   OTLP/HTTP collector base URL. When the collector is absent the batch
//!   span processor only logs export warnings; the app never blocks or
//!   crashes.
//! - `OTEL_SERVICE_NAME` (default `geo-compute`): `service.name` resource
//!   attribute.
//!
//! Request spans are created by the tower-http `TraceLayer` in
//! `handlers::router` (route template + `tenant.id` from the inbound
//! `x-tenant-id` header); this module wires the `tracing` → OTel bridge.
//! `TelemetryGuard::shutdown` flushes the batch processor on graceful stop.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{SpanExporter, WithExportConfig as _};
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

use crate::config::Config;

/// Holds the tracer provider so it can be flushed on shutdown. The disabled
/// (and every failure) path is a valid guard whose shutdown is a no-op.
pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl TelemetryGuard {
    /// Flush pending spans and stop the provider. Never fails fatally.
    pub fn shutdown(self) {
        if let Some(provider) = self.provider {
            if let Err(e) = provider.shutdown() {
                eprintln!("[geo-compute] WARNING: OpenTelemetry shutdown failed: {e}");
            }
        }
    }
}

/// Initialize tracing (always) and the OTel bridge (when enabled). Never
/// fails fatally: any exporter/setup problem is logged as a warning and the
/// service continues with local logging only.
pub fn init(config: &Config) -> TelemetryGuard {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = fmt::layer().with_writer(std::io::stderr);

    if !config.otel_enabled {
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .try_init();
        eprintln!("[geo-compute] OTEL_ENABLED is disabled; OpenTelemetry instrumentation skipped");
        return TelemetryGuard { provider: None };
    }

    match build_provider(config) {
        Ok(provider) => {
            let tracer = provider.tracer("geo-compute");
            let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer)
                .with(otel_layer)
                .try_init();
            eprintln!(
                "[geo-compute] OpenTelemetry enabled: service={} endpoint={}",
                config.otel_service_name, config.otel_endpoint
            );
            TelemetryGuard {
                provider: Some(provider),
            }
        }
        Err(e) => {
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer)
                .try_init();
            eprintln!(
                "[geo-compute] WARNING: OpenTelemetry setup failed ({e}); continuing without telemetry"
            );
            TelemetryGuard { provider: None }
        }
    }
}

fn build_provider(
    config: &Config,
) -> Result<SdkTracerProvider, opentelemetry_otlp::ExporterBuildError> {
    let exporter = SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/traces", config.otel_endpoint))
        .build()?;
    let resource = Resource::builder()
        .with_service_name(config.otel_service_name.clone())
        .build();
    Ok(SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn disabled_otel_yields_a_noop_guard() {
        let config = Config {
            otel_enabled: false,
            ..Config::default()
        };
        let guard = init(&config);
        guard.shutdown(); // must not panic or block
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dead_collector_never_blocks() {
        let config = Config {
            otel_enabled: true,
            otel_endpoint: "http://127.0.0.1:1".to_string(), // guaranteed dead
            ..Config::default()
        };
        let start = Instant::now();
        let guard = init(&config);
        guard.shutdown(); // flush attempt against the dead endpoint
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "telemetry against a dead collector blocked for {:?}",
            start.elapsed()
        );
    }
}
