package gateway

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Server is the event-gw HTTP edge: provider webhook verification, replay
// rejection, durable spooling and fan-out to the API internal ingress.
type Server struct {
	cfg    *Config
	replay *ReplayCache
	spool  *Spool
	logger *slog.Logger
	mux    *http.ServeMux
	http   *http.Server
}

// Envelope is the canonical internal event shape the API ingress consumes.
type Envelope struct {
	ID         string          `json:"id"`
	Provider   string          `json:"provider"`
	EventType  string          `json:"eventType"`
	Payload    json.RawMessage `json:"payload"`
	ReceivedAt time.Time       `json:"receivedAt"`
	DedupeKey  string          `json:"dedupeKey"`
}

// NewServer builds the edge. replay and spool are created by main from the
// config (in-memory vs durable variants); the server only orchestrates.
func NewServer(cfg *Config, replay *ReplayCache, spool *Spool, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{cfg: cfg, replay: replay, spool: spool, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/webhooks/", s.handleWebhook)
	s.mux = mux
	s.http = &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s
}

// ListenAndServe starts the HTTP listener and the spool drain loop.
func (s *Server) ListenAndServe() error {
	go s.drainLoop()
	s.logger.Info("event-gw listening",
		"addr", s.cfg.ListenAddr,
		"api", s.cfg.APIBaseURL,
		"providers", len(s.cfg.WebhookSecrets),
	)
	return s.http.ListenAndServe()
}

// Shutdown stops the listener gracefully (SIGTERM handling lives in main).
func (s *Server) Shutdown(ctx context.Context) error {
	return s.http.Shutdown(ctx)
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleReadyz fails closed when the spool is saturated — an orchestrator
// must stop routing new webhooks to a sidecar that cannot persist them.
func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	status := "ok"
	code := http.StatusOK
	checks := map[string]string{"spool": "ok"}
	if s.spool.Saturated() {
		status = "degraded"
		code = http.StatusServiceUnavailable
		checks["spool"] = "saturated"
	}
	writeJSON(w, code, map[string]any{"status": status, "checks": checks})
}

// handleWebhook is the provider ingress: /webhooks/{provider}. Verification
// is fail-closed at every step — any doubt answers 4xx and NOTHING spools.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	provider := strings.Trim(strings.TrimPrefix(r.URL.Path, "/webhooks/"), "/")
	if provider == "" || strings.Contains(provider, "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown provider"})
		return
	}
	secret, ok := s.cfg.WebhookSecrets[provider]
	if !ok {
		// Fail closed: an unconfigured provider is rejected, never spooled.
		s.logger.Warn("webhook for unconfigured provider rejected", "provider", provider)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown provider"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body too large"})
		return
	}
	signature := r.Header.Get("X-Webhook-Signature")
	if !VerifySignature(secret, body, signature) {
		s.logger.Warn("webhook signature verification failed", "provider", provider)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
		return
	}
	eventType := r.Header.Get("X-Webhook-Event")
	if eventType == "" {
		eventType = "unknown"
	}
	dedupeKey := r.Header.Get("X-Webhook-Id")
	if dedupeKey == "" {
		dedupeKey = fmt.Sprintf("%x", sha256.Sum256(body))
	}
	if s.replay.Seen(provider, dedupeKey) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
		return
	}
	envelope := Envelope{
		ID:         fmt.Sprintf("evt_%x", sha256.Sum256(append([]byte(provider+dedupeKey), body...)))[:32],
		Provider:   provider,
		EventType:  eventType,
		Payload:    json.RawMessage(body),
		ReceivedAt: time.Now().UTC(),
		DedupeKey:  dedupeKey,
	}
	s.replay.Mark(provider, dedupeKey)
	if err := s.spool.Append(envelope); err != nil {
		s.logger.Error("spool append failed — event NOT acknowledged", "error", err, "id", envelope.ID)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "spool unavailable — retry"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued", "id": envelope.ID})
}

// drainLoop forwards spooled envelopes to the API internal ingress, oldest
// first. The API fails closed on the shared internal token; the spool
// retains anything not yet accepted.
func (s *Server) drainLoop() {
	ticker := time.NewTicker(s.cfg.DrainInterval)
	defer ticker.Stop()
	for range ticker.C {
		s.drainOnce()
	}
}

var drainMu sync.Mutex

func (s *Server) drainOnce() {
	drainMu.Lock()
	defer drainMu.Unlock()
	envelopes, err := s.spool.Peek(100)
	if err != nil {
		s.logger.Error("spool peek failed", "error", err)
		return
	}
	for _, envelope := range envelopes {
		if err := s.forward(envelope); err != nil {
			s.logger.Warn("fan-out failed — envelope stays spooled",
				"error", err, "id", envelope.ID)
			return // stop at the first failure to preserve ordering
		}
		if err := s.spool.Ack(envelope.ID); err != nil {
			s.logger.Error("spool ack failed", "error", err, "id", envelope.ID)
			return
		}
	}
}

func (s *Server) forward(envelope Envelope) error {
	body, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(
		http.MethodPost,
		strings.TrimSuffix(s.cfg.APIBaseURL, "/")+"/internal/events",
		strings.NewReader(string(body)),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.cfg.InternalToken != "" {
		req.Header.Set("X-Internal-Token", s.cfg.InternalToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return errors.New(fmt.Sprintf("api answered %d", resp.StatusCode))
	}
	return nil
}

// VerifySignature compares the hex-encoded HMAC-SHA256 of body in constant
// time. A missing or malformed signature never passes.
func VerifySignature(secret string, body []byte, signature string) bool {
	if signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := mac.Sum(nil)
	provided, err := hex.DecodeString(strings.TrimPrefix(signature, "sha256="))
	if err != nil {
		return false
	}
	return hmac.Equal(expected, provided)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
