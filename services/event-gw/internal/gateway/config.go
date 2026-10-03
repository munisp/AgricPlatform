package gateway

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the event-gw runtime configuration, loaded from the environment.
type Config struct {
	ListenAddr string
	// APIBaseURL is where verified envelopes are fanned out
	// (POST {APIBaseURL}/internal/events).
	APIBaseURL string
	// InternalToken is the X-Internal-Token shared credential the API
	// requires on the internal ingress. REQUIRED in production — without it
	// the API answers 401 and the sidecar spools forever.
	InternalToken string
	// WebhookSecrets maps provider -> shared HMAC secret for edge
	// signature verification (EVENTGW_SECRET_<PROVIDER>). A provider
	// without a configured secret is REJECTED at the edge (fail-closed).
	WebhookSecrets map[string]string
	// ReplayTTL is the replay-cache window.
	ReplayTTL time.Duration
	// ReplayPersistPath enables durable replay markers (GAP-L02); empty =
	// in-memory only (development default).
	ReplayPersistPath string
	// SpoolPath is the durable outbox directory for envelopes the API has
	// not yet accepted.
	SpoolPath string
	// SpoolMaxBytes caps the spool on disk; oldest-first drop when full,
	// with a loud log line (never silent loss).
	SpoolMaxBytes int64
	// DrainInterval is the spool drain cadence.
	DrainInterval time.Duration
}

// LoadConfig reads EVENTGW_* / provider-secret env vars. It fails closed:
// in production (EVENTGW_ENV=production) a missing internal token or an
// empty spool path is a startup error, not a silent degradation.
func LoadConfig(env func(string) string) (*Config, error) {
	if env == nil {
		env = os.Getenv
	}
	cfg := &Config{
		ListenAddr:         defaultString(env("EVENTGW_LISTEN_ADDR"), ":8090"),
		APIBaseURL:         defaultString(env("EVENTGW_API_BASE_URL"), "http://localhost:3001/api/v1"),
		InternalToken:      strings.TrimSpace(env("EVENTGW_INTERNAL_TOKEN")),
		WebhookSecrets:     map[string]string{},
		ReplayTTL:          defaultDuration(env("EVENTGW_REPLAY_TTL"), 10*time.Minute),
		ReplayPersistPath:  strings.TrimSpace(env("EVENTGW_REPLAY_PERSIST_PATH")),
		SpoolPath:          strings.TrimSpace(env("EVENTGW_SPOOL_PATH")),
		SpoolMaxBytes:      defaultInt64(env("EVENTGW_SPOOL_MAX_BYTES"), 64<<20),
		DrainInterval:      defaultDuration(env("EVENTGW_DRAIN_INTERVAL"), 5*time.Second),
	}
	for _, kv := range os.Environ() {
		name, value, found := strings.Cut(kv, "=")
		if !found || !strings.HasPrefix(name, "EVENTGW_SECRET_") {
			continue
		}
		provider := strings.ToLower(strings.TrimPrefix(name, "EVENTGW_SECRET_"))
		if provider == "" || strings.TrimSpace(value) == "" {
			continue
		}
		cfg.WebhookSecrets[provider] = strings.TrimSpace(value)
	}
	production := strings.EqualFold(env("EVENTGW_ENV"), "production")
	if production && cfg.InternalToken == "" {
		return nil, fmt.Errorf("EVENTGW_INTERNAL_TOKEN is required in production (the API internal ingress fails closed without it)")
	}
	if production && cfg.SpoolPath == "" {
		return nil, fmt.Errorf("EVENTGW_SPOOL_PATH is required in production (verified events must survive a sidecar restart)")
	}
	if len(cfg.WebhookSecrets) == 0 {
		return nil, fmt.Errorf("no provider webhook secrets configured (EVENTGW_SECRET_<PROVIDER>); the edge would reject every webhook")
	}
	return cfg, nil
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func defaultDuration(value string, fallback time.Duration) time.Duration {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	d, err := time.ParseDuration(value)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

func defaultInt64(value string, fallback int64) int64 {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
