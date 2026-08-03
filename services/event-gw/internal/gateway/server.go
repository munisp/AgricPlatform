package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// Server is the event-gw HTTP edge: webhook ingestion, health/readiness, and
// metrics.
type Server struct {
	cfg     *Config
	replay  *ReplayCache
	fanout  *Fanout
	metrics *Metrics
	logger  *log.Logger

	// Now is injectable for tests.
	Now func() time.Time

	started time.Time
}

func NewServer(cfg *Config, fanout *Fanout, metrics *Metrics, logger *log.Logger) *Server {
	return &Server{
		cfg:     cfg,
		replay:  NewReplayCache(cfg.ReplayTTL),
		fanout:  fanout,
		metrics: metrics,
		logger:  logger,
		Now:     time.Now,
		started: time.Now(),
	}
}

// Routes builds the HTTP mux (Go 1.22 method+pattern routing).
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /webhooks/{provider}", s.handleWebhook)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	return mux
}

// StartBackground launches the replay-cache eviction and spool re-drain
// goroutines; both stop when ctx is cancelled.
func (s *Server) StartBackground(ctx context.Context) {
	s.replay.StartEviction(ctx, s.cfg.ReplayTTL/2)
	s.fanout.StartDrainLoop(ctx, s.cfg.DrainInterval)
}

func writeJSON(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc, _ := json.Marshal(body)
	_, _ = w.Write(enc)
}

func (s *Server) reject(w http.ResponseWriter, provider string, status int, reason string) {
	s.metrics.Inc(MetricRejected, provider)
	writeJSON(w, status, map[string]any{"status": "rejected", "provider": provider, "reason": reason})
}

// handleWebhook ingests one external provider webhook.
//
// Flow: provider lookup -> live-mode misconfiguration gate -> body shape
// validation -> (live only) timestamp + HMAC verification -> replay check ->
// envelope -> fanout (deliver or spool). Response is 202 once the event is
// durably accepted (delivered or spooled), never silently dropped.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(r.PathValue("provider"))
	p, ok := s.cfg.Providers[provider]
	if !ok {
		// Unknown provider: no per-provider metrics (cardinality guard).
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "rejected", "reason": "unknown provider"})
		return
	}
	s.metrics.Inc(MetricReceived, provider)

	// Fail-closed: a live-mode provider without a secret never accepts.
	if s.cfg.Mode == ModeLive && !p.Configured {
		s.reject(w, provider, http.StatusServiceUnavailable,
			fmt.Sprintf("provider misconfigured: EVENTGW_SECRET_%s not set (live mode)", strings.ToUpper(strings.ReplaceAll(provider, "-", "_"))))
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, s.cfg.MaxBodyBytes+1))
	if err != nil {
		s.reject(w, provider, http.StatusBadRequest, "unreadable body")
		return
	}
	if int64(len(body)) > s.cfg.MaxBodyBytes {
		s.reject(w, provider, http.StatusRequestEntityTooLarge, "body too large")
		return
	}
	obj, err := validateShape(body)
	if err != nil {
		s.reject(w, provider, http.StatusBadRequest, err.Error())
		return
	}

	sig := strings.TrimSpace(r.Header.Get(p.SigHeader))
	ts := strings.TrimSpace(r.Header.Get(p.TsHeader))

	if s.cfg.Mode == ModeLive {
		if sig == "" {
			s.reject(w, provider, http.StatusUnauthorized, "missing signature header "+p.SigHeader)
			return
		}
		if ts == "" {
			s.reject(w, provider, http.StatusUnauthorized, "missing timestamp header "+p.TsHeader)
			return
		}
		if err := CheckTimestamp(ts, s.Now(), s.cfg.MaxSkew); err != nil {
			s.reject(w, provider, http.StatusUnauthorized, "timestamp rejected: "+err.Error())
			return
		}
		if !VerifySignature(p.Secret, body, sig, p.SigEncoding) {
			s.reject(w, provider, http.StatusUnauthorized, "invalid signature")
			return
		}
		s.metrics.Inc(MetricVerified, provider)
	}

	if !s.replay.CheckAndMark(replayKey(provider, body, sig, ts), s.Now()) {
		s.reject(w, provider, http.StatusConflict, "replay: duplicate delivery within replay window")
		return
	}

	env := Envelope{
		Provider:   provider,
		EventID:    extractEventID(obj),
		ReceivedAt: s.Now().UTC().Format(time.RFC3339),
		Payload:    json.RawMessage(body),
	}
	outcome, err := s.fanout.Deliver(env)
	if err != nil {
		s.logger.Printf("ERROR: fanout for provider %q event %q: %v", provider, env.EventID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"status": "error", "provider": provider, "eventId": env.EventID,
			"reason": "delivery failed and dead-letter spool write failed",
		})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status": "accepted", "provider": provider, "eventId": env.EventID, "delivery": outcome,
	})
}

// validateShape enforces the minimal event shape: a non-empty JSON object.
// It returns the decoded object for event-id extraction.
func validateShape(body []byte) (map[string]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("empty body")
	}
	if trimmed[0] != '{' {
		return nil, fmt.Errorf("payload must be a JSON object")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil, fmt.Errorf("invalid JSON: %v", err)
	}
	return obj, nil
}

// extractEventID uses a provider-supplied id field when present
// ("eventId", "event_id" or "id", as a string or number), else generates one.
func extractEventID(obj map[string]json.RawMessage) string {
	for _, field := range []string{"eventId", "event_id", "id"} {
		raw, ok := obj[field]
		if !ok {
			continue
		}
		var str string
		if err := json.Unmarshal(raw, &str); err == nil && str != "" {
			return str
		}
		var num json.Number
		if err := json.Unmarshal(raw, &num); err == nil && num != "" {
			return num.String()
		}
	}
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand failure is effectively unreachable; fall back to time.
		return fmt.Sprintf("evt_%d", time.Now().UnixNano())
	}
	return "evt_" + hex.EncodeToString(buf[:])
}

// replayKey identifies a delivery for replay detection. In live mode the
// (timestamp, signature) pair is unique per signed payload; in stub mode
// (signature may be absent) we fall back to a body hash.
func replayKey(provider string, body []byte, sig, ts string) string {
	if sig != "" {
		return provider + "|" + ts + "|" + sig
	}
	sum := sha256.Sum256(body)
	return provider + "|body|" + hex.EncodeToString(sum[:])
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "ok",
		"mode":           s.cfg.Mode,
		"uptimeSeconds":  int64(time.Since(s.started).Seconds()),
		"providersKnown": len(s.cfg.Providers),
	})
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	breaker := s.fanout.Breaker().State()
	backlog := s.fanout.Spool().Backlog()
	status := http.StatusOK
	readiness := "ready"
	if breaker == BreakerOpen {
		// Cannot fan out right now: report not-ready (spool keeps accepting).
		status = http.StatusServiceUnavailable
		readiness = "degraded"
	}
	writeJSON(w, status, map[string]any{
		"status":       readiness,
		"mode":         s.cfg.Mode,
		"breaker":      string(breaker),
		"spoolBacklog": backlog,
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	breaker := s.fanout.Breaker().State()
	breakerOpen := 0
	if breaker == BreakerOpen {
		breakerOpen = 1
	}
	extra := []string{
		"# HELP eventgw_spool_backlog Events waiting in the dead-letter spool.",
		"# TYPE eventgw_spool_backlog gauge",
		fmt.Sprintf("eventgw_spool_backlog %d", s.fanout.Spool().Backlog()),
		"# HELP eventgw_breaker_open Whether the ingress circuit breaker is open (1) or not (0).",
		"# TYPE eventgw_breaker_open gauge",
		fmt.Sprintf("eventgw_breaker_open %d", breakerOpen),
		"# HELP eventgw_mode Operating mode info (always 1).",
		"# TYPE eventgw_mode gauge",
		fmt.Sprintf("eventgw_mode{mode=%q} 1", s.cfg.Mode),
	}
	s.metrics.Render(w, extra...)
}
