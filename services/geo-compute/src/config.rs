//! Fail-closed configuration.
//!
//! Doctrine (mirrors `services/event-gw` / `services/crop-ml`): the service
//! defaults to `stub` mode, which returns clearly-labelled deterministic
//! hand-rolled approximations for the H3 endpoints. Production claims require
//! `GEOCOMPUTE_MODE=live` (real h3o-backed H3). An unknown mode is a FATAL
//! startup misconfiguration — the process refuses to boot rather than
//! silently guessing.

use std::fmt;

/// Operating mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Deterministic hand-rolled approximations, labelled `"basis":"stub"`.
    Stub,
    /// h3o-backed H3 indexing/compaction, labelled `"basis":"live"`.
    Live,
}

impl Mode {
    /// Label embedded in every response body.
    pub fn basis(self) -> &'static str {
        match self {
            Mode::Stub => "stub",
            Mode::Live => "live",
        }
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.basis())
    }
}

/// Fatal startup misconfiguration. The process must refuse to boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "geo-compute misconfigured: {}", self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Default OTLP/HTTP collector endpoint (no-op-safe when absent).
pub const DEFAULT_OTLP_ENDPOINT: &str = "http://localhost:4318";

/// Service configuration.
#[derive(Debug, Clone)]
pub struct Config {
    pub mode: Mode,
    pub port: u16,
    /// Hard cap on H3 cells returned by `/v1/geo/h3/index` (422 above).
    pub max_cells: usize,
    /// Hard cap on points accepted by `/v1/geo/geofence/batch` (422 above).
    pub max_points: usize,
    /// Hard cap on cells accepted by `/v1/geo/h3/compact` (422 above).
    pub max_compact_input: usize,

    /// OpenTelemetry: enabled unless OTEL_ENABLED is an explicit negative
    /// ("false|0|no|off"). A dead collector only logs warnings.
    pub otel_enabled: bool,
    /// OTEL_EXPORTER_OTLP_ENDPOINT (OTLP/HTTP base URL).
    pub otel_endpoint: String,
    /// OTEL_SERVICE_NAME (service.name resource attribute).
    pub otel_service_name: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Stub,
            port: 8200,
            max_cells: 100_000,
            max_points: 100_000,
            max_compact_input: 1_000_000,
            otel_enabled: true,
            otel_endpoint: DEFAULT_OTLP_ENDPOINT.to_string(),
            otel_service_name: "geo-compute".to_string(),
        }
    }
}

impl Config {
    /// Build from process environment (fail-closed).
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Build from an arbitrary lookup (kept injectable so tests never mutate
    /// process env — `std::env::set_var` is racy under parallel tests).
    pub fn from_lookup<F>(get: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut cfg = Config::default();

        match get("GEOCOMPUTE_MODE").as_deref() {
            None | Some("") | Some("stub") => cfg.mode = Mode::Stub,
            Some("live") => cfg.mode = Mode::Live,
            Some(other) => {
                return Err(ConfigError(format!(
                    "GEOCOMPUTE_MODE must be 'stub' or 'live', got '{other}'"
                )));
            }
        }

        cfg.port = parse_u16(&get, "GEOCOMPUTE_PORT", cfg.port)?;
        cfg.max_cells = parse_usize(&get, "GEOCOMPUTE_MAX_CELLS", cfg.max_cells)?;
        cfg.max_points = parse_usize(&get, "GEOCOMPUTE_MAX_POINTS", cfg.max_points)?;
        cfg.max_compact_input =
            parse_usize(&get, "GEOCOMPUTE_MAX_COMPACT_INPUT", cfg.max_compact_input)?;

        if let Some(raw) = get("OTEL_ENABLED") {
            let normalized = raw.trim().to_ascii_lowercase();
            if matches!(normalized.as_str(), "false" | "0" | "no" | "off") {
                cfg.otel_enabled = false;
            }
        }
        if let Some(endpoint) = non_empty(get("OTEL_EXPORTER_OTLP_ENDPOINT")) {
            cfg.otel_endpoint = endpoint.trim_end_matches('/').to_string();
        }
        if let Some(name) = non_empty(get("OTEL_SERVICE_NAME")) {
            cfg.otel_service_name = name;
        }
        Ok(cfg)
    }
}

fn non_empty(raw: Option<String>) -> Option<String> {
    raw.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_u16<F>(get: &F, key: &str, default: u16) -> Result<u16, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    match get(key) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<u16>()
            .map_err(|_| ConfigError(format!("{key} must be a u16, got '{raw}'"))),
    }
}

fn parse_usize<F>(get: &F, key: &str, default: usize) -> Result<usize, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    match get(key) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| ConfigError(format!("{key} must be a usize, got '{raw}'"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn defaults_to_stub_mode_and_port_8200() {
        let cfg = Config::from_lookup(|_| None).expect("defaults are valid");
        assert_eq!(cfg.mode, Mode::Stub);
        assert_eq!(cfg.port, 8200);
        assert_eq!(cfg.max_cells, 100_000);
        assert_eq!(cfg.max_points, 100_000);
    }

    #[test]
    fn live_mode_is_accepted() {
        let cfg = Config::from_lookup(lookup(&[("GEOCOMPUTE_MODE", "live")]))
            .expect("live is a valid mode");
        assert_eq!(cfg.mode, Mode::Live);
        assert_eq!(cfg.mode.basis(), "live");
    }

    #[test]
    fn unknown_mode_is_a_fatal_startup_error() {
        // Mode gating: anything but stub/live refuses to boot.
        let err = Config::from_lookup(lookup(&[("GEOCOMPUTE_MODE", "production")]))
            .expect_err("unknown mode must be rejected");
        assert!(err.0.contains("GEOCOMPUTE_MODE"));
    }

    #[test]
    fn invalid_port_is_a_fatal_startup_error() {
        let err = Config::from_lookup(lookup(&[("GEOCOMPUTE_PORT", "99999")]))
            .expect_err("out-of-range port must be rejected");
        assert!(err.0.contains("GEOCOMPUTE_PORT"));
    }

    #[test]
    fn otel_defaults_to_enabled_with_localhost_endpoint() {
        let cfg = Config::from_lookup(|_| None).expect("defaults are valid");
        assert!(cfg.otel_enabled);
        assert_eq!(cfg.otel_endpoint, DEFAULT_OTLP_ENDPOINT);
        assert_eq!(cfg.otel_service_name, "geo-compute");
    }

    #[test]
    fn otel_enabled_explicit_negatives_disable() {
        for value in ["false", "FALSE", "0", "no", "off", " off "] {
            let cfg = Config::from_lookup(lookup(&[("OTEL_ENABLED", value)]))
                .expect("valid config");
            assert!(!cfg.otel_enabled, "OTEL_ENABLED={value:?} must disable");
        }
    }

    #[test]
    fn otel_overrides_are_applied_and_endpoint_trailing_slash_trimmed() {
        let cfg = Config::from_lookup(lookup(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/"),
            ("OTEL_SERVICE_NAME", "geo-test"),
        ]))
        .expect("valid config");
        assert!(cfg.otel_enabled);
        assert_eq!(cfg.otel_endpoint, "http://collector:4318");
        assert_eq!(cfg.otel_service_name, "geo-test");
    }

    #[test]
    fn overrides_are_applied() {
        let cfg = Config::from_lookup(lookup(&[
            ("GEOCOMPUTE_MODE", "live"),
            ("GEOCOMPUTE_PORT", "9200"),
            ("GEOCOMPUTE_MAX_CELLS", "5000"),
        ]))
        .expect("valid overrides");
        assert_eq!(cfg.port, 9200);
        assert_eq!(cfg.max_cells, 5000);
    }
}
