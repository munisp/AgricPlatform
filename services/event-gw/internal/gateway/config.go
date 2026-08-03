package gateway

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Operating modes. Fail-closed rule: "stub" (the default) skips signature
// verification and must say so loudly; "live" verifies every webhook and any
// provider missing its secret answers 503 rather than accepting unverified
// traffic.
const (
	ModeStub = "stub"
	ModeLive = "live"
)

// ProviderConfig describes one external webhook provider.
type ProviderConfig struct {
	Name        string // canonical lowercase name used in the route
	Secret      string // HMAC-SHA256 shared secret (may be empty in stub mode)
	SigHeader   string // header carrying the signature (default X-Signature)
	TsHeader    string // header carrying the timestamp (default X-Timestamp)
	SigEncoding string // "hex" or "base64"
	Configured  bool   // true when a secret is present
}

// Config is the runtime configuration of the gateway.
type Config struct {
	Mode          string
	Addr          string
	Providers     map[string]*ProviderConfig
	ProviderOrder []string // deterministic order for logging/metrics
	IngressURL    string
	InternalToken string
	SpoolPath     string

	MaxSkew      time.Duration
	ReplayTTL    time.Duration
	MaxBodyBytes int64

	// Fanout retry policy. Defaults: 3 attempts, backoff 200ms -> 800ms,
	// capped at 2s (the cap applies if attempts are raised above 3).
	MaxAttempts int
	BackoffBase time.Duration
	BackoffMax  time.Duration

	// Circuit breaker: opens after BreakerThreshold consecutive failed
	// delivery cycles, half-opens after BreakerCooldown.
	BreakerThreshold int
	BreakerCooldown  time.Duration

	// Spool re-drain poll interval.
	DrainInterval time.Duration
}

func envOr(get func(string) string, key, def string) string {
	if v := strings.TrimSpace(get(key)); v != "" {
		return v
	}
	return def
}

func envSeconds(get func(string) string, key string, def time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(get(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s: invalid seconds value %q", key, raw)
	}
	return time.Duration(n) * time.Second, nil
}

func envMillis(get func(string) string, key string, def time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(get(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s: invalid milliseconds value %q", key, raw)
	}
	return time.Duration(n) * time.Millisecond, nil
}

func envInt(get func(string) string, key string, def int) (int, error) {
	raw := strings.TrimSpace(get(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s: invalid integer value %q", key, raw)
	}
	return n, nil
}

// providerEnvKey uppercases a provider name for env lookups
// ("weather-api" -> "WEATHER_API").
func providerEnvKey(name string) string {
	repl := strings.NewReplacer("-", "_", ".", "_", "/", "_")
	return repl.Replace(strings.ToUpper(name))
}

// LoadConfig builds a Config from the environment. It returns the config,
// a list of startup messages to log verbatim (warnings and FATAL
// misconfiguration notices), and an error only for unusable configuration.
// get is injectable for tests (os.Getenv in production).
func LoadConfig(get func(string) string) (*Config, []string, error) {
	var msgs []string

	mode := strings.ToLower(envOr(get, "EVENTGW_MODE", ModeStub))
	if mode != ModeStub && mode != ModeLive {
		return nil, nil, fmt.Errorf("EVENTGW_MODE must be %q or %q, got %q", ModeStub, ModeLive, mode)
	}

	cfg := &Config{
		Mode:          mode,
		Addr:          envOr(get, "EVENTGW_ADDR", ":8090"),
		Providers:     map[string]*ProviderConfig{},
		IngressURL:    envOr(get, "EVENTGW_API_INGRESS_URL", "http://localhost:3001/api/v1/internal/events"),
		InternalToken: strings.TrimSpace(get("EVENTGW_INTERNAL_TOKEN")),
		SpoolPath:     envOr(get, "EVENTGW_SPOOL_PATH", "/var/spool/event-gw/deadletter.jsonl"),
	}
	var err error
	if cfg.MaxSkew, err = envSeconds(get, "EVENTGW_MAX_SKEW_SECONDS", 300*time.Second); err != nil {
		return nil, nil, err
	}
	if cfg.ReplayTTL, err = envSeconds(get, "EVENTGW_REPLAY_TTL_SECONDS", 600*time.Second); err != nil {
		return nil, nil, err
	}
	if cfg.MaxAttempts, err = envInt(get, "EVENTGW_MAX_ATTEMPTS", 3); err != nil {
		return nil, nil, err
	}
	if cfg.BackoffBase, err = envMillis(get, "EVENTGW_BACKOFF_BASE_MS", 200*time.Millisecond); err != nil {
		return nil, nil, err
	}
	if cfg.BackoffMax, err = envMillis(get, "EVENTGW_BACKOFF_MAX_MS", 2*time.Second); err != nil {
		return nil, nil, err
	}
	if cfg.BreakerThreshold, err = envInt(get, "EVENTGW_BREAKER_THRESHOLD", 5); err != nil {
		return nil, nil, err
	}
	if cfg.BreakerCooldown, err = envSeconds(get, "EVENTGW_BREAKER_COOLDOWN_SECONDS", 30*time.Second); err != nil {
		return nil, nil, err
	}
	if cfg.DrainInterval, err = envSeconds(get, "EVENTGW_DRAIN_INTERVAL_SECONDS", 10*time.Second); err != nil {
		return nil, nil, err
	}
	cfg.MaxBodyBytes = 1 << 20 // 1 MiB, fixed

	if strings.TrimSpace(get("EVENTGW_API_INGRESS_URL")) == "" {
		msgs = append(msgs, "WARNING: EVENTGW_API_INGRESS_URL not set; defaulting to "+cfg.IngressURL)
	}

	if mode == ModeStub {
		msgs = append(msgs,
			"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
			"WARNING: EVENTGW_MODE=stub — HMAC signature verification is DISABLED.",
			"Webhooks are validated for shape only. This mode is for development and CI.",
			"Set EVENTGW_MODE=live and EVENTGW_SECRET_<NAME> per provider in production.",
			"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
	}
	if mode == ModeLive && cfg.InternalToken == "" {
		msgs = append(msgs, "WARNING: EVENTGW_INTERNAL_TOKEN is empty; the API ingress is likely to reject fanned-out events.")
	}

	rawProviders := envOr(get, "EVENTGW_PROVIDERS", "weather,payments,imagery")
	for _, name := range strings.Split(rawProviders, ",") {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		key := providerEnvKey(name)
		enc := strings.ToLower(envOr(get, "EVENTGW_SIG_ENCODING_"+key, "hex"))
		if enc != "hex" && enc != "base64" {
			return nil, nil, fmt.Errorf("EVENTGW_SIG_ENCODING_%s must be \"hex\" or \"base64\", got %q", key, enc)
		}
		p := &ProviderConfig{
			Name:        name,
			Secret:      strings.TrimSpace(get("EVENTGW_SECRET_" + key)),
			SigHeader:   envOr(get, "EVENTGW_SIG_HEADER_"+key, "X-Signature"),
			TsHeader:    envOr(get, "EVENTGW_TS_HEADER_"+key, "X-Timestamp"),
			SigEncoding: enc,
		}
		p.Configured = p.Secret != ""
		if mode == ModeLive && !p.Configured {
			msgs = append(msgs, fmt.Sprintf(
				"FATAL: provider %q has no EVENTGW_SECRET_%s in live mode — its route will answer 503 (process stays up for other providers). NEVER accepting unverified webhooks.",
				name, key))
		}
		if _, dup := cfg.Providers[name]; !dup {
			cfg.ProviderOrder = append(cfg.ProviderOrder, name)
		}
		cfg.Providers[name] = p
	}
	sort.Strings(cfg.ProviderOrder)
	if len(cfg.Providers) == 0 {
		msgs = append(msgs, "WARNING: EVENTGW_PROVIDERS is empty — every /webhooks/{provider} route will answer 404.")
	}
	return cfg, msgs, nil
}
