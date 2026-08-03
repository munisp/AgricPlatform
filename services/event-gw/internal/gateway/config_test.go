package gateway

import (
	"strings"
	"testing"
	"time"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, msgs, err := LoadConfig(envMap(map[string]string{}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Mode != ModeStub {
		t.Fatalf("Mode = %q, want stub (fail-closed default)", cfg.Mode)
	}
	if cfg.MaxSkew != 300*time.Second {
		t.Fatalf("MaxSkew = %v, want 300s", cfg.MaxSkew)
	}
	if cfg.MaxAttempts != 3 || cfg.BackoffBase != 200*time.Millisecond || cfg.BackoffMax != 2*time.Second {
		t.Fatalf("retry policy = %d/%v/%v, want 3/200ms/2s", cfg.MaxAttempts, cfg.BackoffBase, cfg.BackoffMax)
	}
	if cfg.BreakerThreshold != 5 || cfg.BreakerCooldown != 30*time.Second {
		t.Fatalf("breaker = %d/%v, want 5/30s", cfg.BreakerThreshold, cfg.BreakerCooldown)
	}
	if cfg.SpoolPath != "/var/spool/event-gw/deadletter.jsonl" {
		t.Fatalf("SpoolPath = %q", cfg.SpoolPath)
	}
	if len(cfg.Providers) != 3 || cfg.Providers["weather"] == nil {
		t.Fatalf("Providers = %v, want weather,payments,imagery default", cfg.ProviderOrder)
	}
	if cfg.Providers["weather"].SigHeader != "X-Signature" || cfg.Providers["weather"].TsHeader != "X-Timestamp" {
		t.Fatal("default headers not applied")
	}
	joined := strings.Join(msgs, "\n")
	if !strings.Contains(joined, "WARNING: EVENTGW_MODE=stub") {
		t.Fatal("stub mode must produce a loud startup warning")
	}
}

func TestLoadConfigLiveModeMissingSecret(t *testing.T) {
	cfg, msgs, err := LoadConfig(envMap(map[string]string{
		"EVENTGW_MODE":            "live",
		"EVENTGW_PROVIDERS":       "weather,payments",
		"EVENTGW_SECRET_PAYMENTS": "s3cret",
	}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Providers["weather"].Configured {
		t.Fatal("weather should be unconfigured")
	}
	if !cfg.Providers["payments"].Configured {
		t.Fatal("payments should be configured")
	}
	joined := strings.Join(msgs, "\n")
	if !strings.Contains(joined, `FATAL: provider "weather"`) {
		t.Fatalf("live mode with missing secret must log a FATAL misconfiguration notice, got: %s", joined)
	}
}

func TestLoadConfigRejectsBadValues(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"bad mode", map[string]string{"EVENTGW_MODE": "yolo"}},
		{"bad encoding", map[string]string{"EVENTGW_SIG_ENCODING_WEATHER": "rot13"}},
		{"bad skew", map[string]string{"EVENTGW_MAX_SKEW_SECONDS": "soon"}},
		{"bad attempts", map[string]string{"EVENTGW_MAX_ATTEMPTS": "0"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := LoadConfig(envMap(tc.env)); err == nil {
				t.Fatal("LoadConfig should fail")
			}
		})
	}
}

func TestLoadConfigProviderSpecificHeaders(t *testing.T) {
	cfg, _, err := LoadConfig(envMap(map[string]string{
		"EVENTGW_PROVIDERS":                "Weather-API",
		"EVENTGW_SECRET_WEATHER_API":       "topsecret",
		"EVENTGW_SIG_HEADER_WEATHER_API":   "X-Hook-Sig",
		"EVENTGW_TS_HEADER_WEATHER_API":    "X-Hook-Ts",
		"EVENTGW_SIG_ENCODING_WEATHER_API": "base64",
	}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	p := cfg.Providers["weather-api"]
	if p == nil {
		t.Fatalf("provider names must normalize to lowercase, have %v", cfg.ProviderOrder)
	}
	if p.SigHeader != "X-Hook-Sig" || p.TsHeader != "X-Hook-Ts" || p.SigEncoding != "base64" {
		t.Fatalf("per-provider overrides not applied: %+v", p)
	}
	if !p.Configured {
		t.Fatal("secret should mark provider configured")
	}
}
