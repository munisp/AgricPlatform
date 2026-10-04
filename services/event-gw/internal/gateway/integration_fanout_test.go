package gateway

// Sidecar -> API integration contract test (GAP-C03 / GAP-H01).
//
// This file exercises the event-gw sidecar and the API's internal event
// ingress TOGETHER, in-process: a real edge Server (live-mode signature
// verification included) fans verified envelopes out to a mock NestJS
// ingress backed by httptest. No external services are required, so the
// test runs under plain `go test ./...` in CI — it is deliberately NOT
// hidden behind a build tag or env flag, because a contract test that has
// to be opted into silently stops protecting the contract.
//
// The mock is a faithful re-implementation of the API-side contract and
// MUST be kept in sync with (drift here is a bug in one side or the other):
//
//   - apps/api/src/modules/integrations/internal-events.controller.ts
//     (route POST /api/v1/internal/events, EventGwEnvelopeDto with
//     whitelist + forbidNonWhitelisted: exactly provider/eventId/receivedAt/
//     payload, extra top-level fields -> 400; success -> 201 {data:...})
//   - apps/api/src/modules/integrations/internal-token.guard.ts
//     (X-Internal-Token auth: 503 fail-closed when EVENTGW_INTERNAL_TOKEN
//     is unset, 401 missing/mismatch, constant-time compare over SHA-256
//     hashes of both sides so token length never leaks)
//   - apps/api/test/internal-events.e2e.spec.ts
//     (the API-side contract e2e this file mirrors from the Go side)
//
// It also pins GAP-H01: provider-native signature headers (X-Signature,
// X-Timestamp) verified at the edge MUST NOT leak onto the internal path —
// the internal ingress neither requires nor trusts them.

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// contractToken is the shared EVENTGW_INTERNAL_TOKEN value both sides are
// configured with in the happy-path tests.
const contractToken = "integration-contract-token"

// capturedDelivery records what the mock ingress observed on the wire.
type capturedDelivery struct {
	path        string
	contentType string
	envelope    Envelope
	rawBody     []byte
	// Provider-native headers that leaked onto the internal path (must be
	// empty — GAP-H01).
	leakedHeaders []string
}

// mockInternalIngress implements the API side of the GAP-C03/GAP-H01
// contract: POST /api/v1/internal/events guarded by the X-Internal-Token
// shared credential. See the file header for the API sources this mirrors.
type mockInternalIngress struct {
	server *httptest.Server

	// token is the configured EVENTGW_INTERNAL_TOKEN; "" means the API has
	// no token configured and must answer 503 (fail-closed, never an open
	// door) — mirrors InternalTokenGuard.canActivate.
	token string

	// failNext, when > 0, makes the next N authenticated-and-valid requests
	// answer 500 (simulating a crash during processing) so retry/spool
	// behaviour can be exercised.
	failNext atomic.Int64

	requests atomic.Int64 // all requests that reached the handler

	mu       sync.Mutex
	captured []capturedDelivery
}

// internalTokenMatches mirrors internalTokenMatches in
// apps/api/src/modules/integrations/internal-token.guard.ts: both sides are
// SHA-256 hashed before the constant-time compare so the comparison never
// leaks token length.
func internalTokenMatches(presented, configured string) bool {
	a := sha256.Sum256([]byte(presented))
	b := sha256.Sum256([]byte(configured))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// strictEnvelope decodes the request body the way NestJS's global
// ValidationPipe (whitelist + forbidNonWhitelisted) treats
// EventGwEnvelopeDto: unknown top-level fields are a 400, required fields
// must be present and well-typed, receivedAt must be an ISO 8601 timestamp
// (the sidecar always emits RFC3339 UTC, which is a subset), and payload
// must be present (any JSON value, including null per @IsDefined).
type strictEnvelope struct {
	Provider   string           `json:"provider"`
	EventID    string           `json:"eventId"`
	ReceivedAt string           `json:"receivedAt"`
	Payload    *json.RawMessage `json:"payload"` // pointer: distinguishes absent from null
}

func newMockInternalIngress(t *testing.T, token string) *mockInternalIngress {
	t.Helper()
	m := &mockInternalIngress{token: token}
	m.server = httptest.NewServer(http.HandlerFunc(m.handle))
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockInternalIngress) url() string {
	// The API mounts the controller under the global prefix: the full route
	// is POST /api/v1/internal/events (apps/api/src/bootstrap.ts).
	return m.server.URL + "/api/v1/internal/events"
}

func (m *mockInternalIngress) handle(w http.ResponseWriter, r *http.Request) {
	m.requests.Add(1)

	// Route guard: only POST /api/v1/internal/events exists here.
	if r.Method != http.MethodPost || r.URL.Path != "/api/v1/internal/events" {
		http.Error(w, `{"statusCode":404,"message":"Cannot POST"}`, http.StatusNotFound)
		return
	}

	// InternalTokenGuard: fail-closed 503 when the API has no token
	// configured, evaluated per request so rotation needs no restart.
	if strings.TrimSpace(m.token) == "" {
		http.Error(w, `{"statusCode":503,"message":"EVENTGW_INTERNAL_TOKEN is unset"}`, http.StatusServiceUnavailable)
		return
	}
	presented := strings.TrimSpace(r.Header.Get("X-Internal-Token"))
	if presented == "" || !internalTokenMatches(presented, strings.TrimSpace(m.token)) {
		http.Error(w, `{"statusCode":401,"message":"Missing or invalid x-internal-token"}`, http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, `{"statusCode":400,"message":"unreadable body"}`, http.StatusBadRequest)
		return
	}

	// Envelope validation mirroring EventGwEnvelopeDto + whitelist /
	// forbidNonWhitelisted: DisallowUnknownFields makes any extra top-level
	// field (e.g. a smuggled provider-native `signature`) a 400.
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	var env strictEnvelope
	if err := dec.Decode(&env); err != nil {
		http.Error(w, fmt.Sprintf(`{"statusCode":400,"message":%q}`, "invalid envelope: "+err.Error()), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(env.Provider) == "" || strings.TrimSpace(env.EventID) == "" {
		http.Error(w, `{"statusCode":400,"message":"provider/eventId must be non-empty strings"}`, http.StatusBadRequest)
		return
	}
	// @IsISO8601 on the API side; the sidecar contract is RFC3339 UTC.
	if _, err := time.Parse(time.RFC3339, env.ReceivedAt); err != nil {
		http.Error(w, `{"statusCode":400,"message":"receivedAt must be ISO 8601"}`, http.StatusBadRequest)
		return
	}
	if env.Payload == nil {
		http.Error(w, `{"statusCode":400,"message":"payload must be defined"}`, http.StatusBadRequest)
		return
	}

	// GAP-H01: no provider-native signature material may arrive on this
	// path. Record any leakage for the test to assert on.
	var leaked []string
	for _, h := range []string{"X-Signature", "X-Timestamp", "X-Hub-Signature-256", "Verif-Hash", "X-Paystack-Signature"} {
		if r.Header.Get(h) != "" {
			leaked = append(leaked, h)
		}
	}

	m.mu.Lock()
	m.captured = append(m.captured, capturedDelivery{
		path:          r.URL.Path,
		contentType:   r.Header.Get("Content-Type"),
		envelope:      Envelope{Provider: env.Provider, EventID: env.EventID, ReceivedAt: env.ReceivedAt, Payload: json.RawMessage(*env.Payload)},
		rawBody:       body,
		leakedHeaders: leaked,
	})
	m.mu.Unlock()

	// Simulated 5xx AFTER the envelope is accepted as well-formed: drives
	// the sidecar's spool + redrive path (the API answers 5xx when
	// processing fails so the sidecar keeps retrying — audit C2).
	if m.failNext.Load() > 0 {
		m.failNext.Add(-1)
		http.Error(w, `{"statusCode":500,"message":"processing failed"}`, http.StatusInternalServerError)
		return
	}

	// NestJS answers 201 for POST by default, body {data: {received: true}}.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(`{"data":{"received":true}}`))
}

// deliveries returns a copy of the captured deliveries.
func (m *mockInternalIngress) deliveries() []capturedDelivery {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]capturedDelivery, len(m.captured))
	copy(out, m.captured)
	return out
}

// integrationEdge builds a full live-mode edge server whose fanout targets
// the mock API ingress, mirroring testEdge but against the contract mock.
func integrationEdge(t *testing.T, ingressURL, token string) *Server {
	t.Helper()
	providers := liveProvider("edge-secret")
	order := []string{"weather"}
	cfg := &Config{
		Mode:             ModeLive,
		Providers:        providers,
		ProviderOrder:    order,
		IngressURL:       ingressURL,
		InternalToken:    token,
		SpoolPath:        filepath.Join(t.TempDir(), "deadletter.jsonl"),
		MaxSkew:          300 * time.Second,
		ReplayTTL:        10 * time.Minute,
		MaxBodyBytes:     1 << 20,
		MaxAttempts:      3,
		BackoffBase:      200 * time.Millisecond,
		BackoffMax:       2 * time.Second,
		BreakerThreshold: 5,
		BreakerCooldown:  30 * time.Second,
		DrainInterval:    time.Minute,
	}
	metrics := NewMetrics(order)
	breaker := NewBreaker(cfg.BreakerThreshold, cfg.BreakerCooldown)
	spool := NewSpool(cfg.SpoolPath)
	logger := log.New(io.Discard, "", 0)
	fanout := NewFanout(cfg, breaker, spool, metrics, logger)
	fanout.Sleep = func(time.Duration) {}
	return NewServer(cfg, fanout, metrics, logger)
}

// TestIntegrationSidecarToAPIContract is the happy-path GAP-C03 contract: a
// live-mode, HMAC-signed provider webhook is verified at the edge and fanned
// out to the API internal ingress, which accepts exactly the documented
// envelope authenticated by X-Internal-Token — with no provider-native
// signature material on the wire (GAP-H01).
func TestIntegrationSidecarToAPIContract(t *testing.T) {
	api := newMockInternalIngress(t, contractToken)
	srv := integrationEdge(t, api.url(), contractToken)

	body := `{"eventId":"w-1","alert":"heavy-rain"}`
	rec := doWebhook(t, srv, "weather", body, signedHeaders("edge-secret", body, time.Now()))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, want 202: %s", rec.Code, rec.Body)
	}
	var ack acceptedResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	if ack.Delivery != DeliveryDelivered {
		t.Fatalf("delivery = %q, want delivered (mock API healthy)", ack.Delivery)
	}
	if ack.EventID != "w-1" {
		t.Fatalf("ack eventId = %q, want w-1", ack.EventID)
	}

	got := api.deliveries()
	if len(got) != 1 {
		t.Fatalf("API received %d requests, want exactly 1", len(got))
	}
	d := got[0]
	if d.path != "/api/v1/internal/events" {
		t.Fatalf("fanout path = %q, want /api/v1/internal/events", d.path)
	}
	if ct := d.contentType; !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if len(d.leakedHeaders) != 0 {
		t.Fatalf("GAP-H01 violation: provider-native headers leaked to internal path: %v", d.leakedHeaders)
	}

	// Envelope identity: provider/eventId from the edge, payload forwarded
	// byte-for-byte unmodified, receivedAt RFC3339.
	env := d.envelope
	if env.Provider != "weather" {
		t.Fatalf("envelope provider = %q, want weather", env.Provider)
	}
	if env.EventID != "w-1" {
		t.Fatalf("envelope eventId = %q, want w-1 (extracted from payload)", env.EventID)
	}
	if string(env.Payload) != body {
		t.Fatalf("envelope payload = %s, want unmodified %s", env.Payload, body)
	}
	ts, err := time.Parse(time.RFC3339, env.ReceivedAt)
	if err != nil {
		t.Fatalf("receivedAt %q not RFC3339: %v", env.ReceivedAt, err)
	}
	if ts.Location() != time.UTC && ts.Format("Z07:00") != "Z" {
		t.Fatalf("receivedAt %q not UTC", env.ReceivedAt)
	}

	// The envelope must contain EXACTLY the four contract fields — no more,
	// no less (the API 400s on any extra top-level field, so an extra field
	// here would be a live contract break, and a missing one a 400 too).
	var top map[string]json.RawMessage
	if err := json.Unmarshal(d.rawBody, &top); err != nil {
		t.Fatalf("re-decode raw envelope: %v", err)
	}
	if len(top) != 4 {
		t.Fatalf("envelope has %d top-level fields, want exactly 4 (provider, eventId, receivedAt, payload): %v", len(top), d.rawBody)
	}
	for _, k := range []string{"provider", "eventId", "receivedAt", "payload"} {
		if _, ok := top[k]; !ok {
			t.Fatalf("envelope missing field %q: %s", k, d.rawBody)
		}
	}
}

// TestIntegrationSpoolAndRedriveOn5xx pins the retry/spool half of the
// contract: when the API answers 500 (processing crashed), the sidecar
// spools the envelope and the drain loop re-delivers the SAME envelope once
// the API recovers — at-least-once, no loss, no duplication of the wire
// shape (the API dedupes exact replays via its durable store).
func TestIntegrationSpoolAndRedriveOn5xx(t *testing.T) {
	api := newMockInternalIngress(t, contractToken)
	api.failNext.Store(1) // first delivery crashes with a 500
	srv := integrationEdge(t, api.url(), contractToken)

	body := `{"eventId":"w-2","alert":"frost"}`
	rec := doWebhook(t, srv, "weather", body, signedHeaders("edge-secret", body, time.Now()))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, want 202: %s", rec.Code, rec.Body)
	}
	var ack acceptedResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	if ack.Delivery != DeliverySpooled {
		t.Fatalf("delivery = %q, want spooled after API 500", ack.Delivery)
	}

	// The background drain loop is what retries in production; drive it
	// synchronously here (same code path, no real sleeping).
	stats, err := srv.fanout.DrainSpool()
	if err != nil {
		t.Fatalf("DrainSpool: %v", err)
	}
	if stats.Sent != 1 || stats.SendFailed {
		t.Fatalf("drain stats = %+v, want Sent=1", stats)
	}

	got := api.deliveries()
	if len(got) != 2 {
		t.Fatalf("API received %d requests, want 2 (original + redrive)", len(got))
	}
	first, second := got[0], got[1]
	if string(first.rawBody) != string(second.rawBody) {
		t.Fatalf("redriven envelope differs from original:\nfirst:  %s\nsecond: %s", first.rawBody, second.rawBody)
	}
	if second.envelope.EventID != "w-2" {
		t.Fatalf("redriven eventId = %q, want w-2", second.envelope.EventID)
	}
}

// TestIntegrationFailClosedWhenAPITokenUnset mirrors the guard's 503
// fail-closed branch: an API without EVENTGW_INTERNAL_TOKEN never accepts,
// and the sidecar must treat that as a delivery failure (spool), never as
// success — the provider still gets 202 with delivery=spooled (durably
// accepted, honestly reported).
func TestIntegrationFailClosedWhenAPITokenUnset(t *testing.T) {
	api := newMockInternalIngress(t, "") // API misconfigured: no token
	srv := integrationEdge(t, api.url(), contractToken)

	body := `{"eventId":"w-3","alert":"hail"}`
	rec := doWebhook(t, srv, "weather", body, signedHeaders("edge-secret", body, time.Now()))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, want 202: %s", rec.Code, rec.Body)
	}
	var ack acceptedResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	if ack.Delivery != DeliverySpooled {
		t.Fatalf("delivery = %q, want spooled when API answers fail-closed 503", ack.Delivery)
	}
	if got := srv.fanout.Spool().Backlog(); got != 1 {
		t.Fatalf("spool backlog = %d, want 1 (event retained for redrive)", got)
	}
	// And a drain while the API is still misconfigured must NOT deliver or
	// drop the event.
	stats, err := srv.fanout.DrainSpool()
	if err != nil {
		t.Fatalf("DrainSpool: %v", err)
	}
	if stats.Sent != 0 || !stats.SendFailed {
		t.Fatalf("drain stats = %+v, want Sent=0 SendFailed=true while API is 503", stats)
	}
	if got := srv.fanout.Spool().Backlog(); got != 1 {
		t.Fatalf("spool backlog after failed drain = %d, want 1 (not dropped)", got)
	}
}

// TestIntegrationBadTokenNeverAccepted pins the 401 branch from both sides:
// a sidecar holding the WRONG token is rejected by the API (constant-time
// compare), and the sidecar spools rather than counting the event as
// delivered. Also covers the mock's own fail-closed 503 / 401 semantics so
// the mock cannot silently drift from internal-token.guard.ts.
func TestIntegrationBadTokenNeverAccepted(t *testing.T) {
	api := newMockInternalIngress(t, contractToken)
	srv := integrationEdge(t, api.url(), "wrong-token")

	body := `{"eventId":"w-4","alert":"drought"}`
	rec := doWebhook(t, srv, "weather", body, signedHeaders("edge-secret", body, time.Now()))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, want 202: %s", rec.Code, rec.Body)
	}
	var ack acceptedResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	if ack.Delivery != DeliverySpooled {
		t.Fatalf("delivery = %q, want spooled when API answers 401", ack.Delivery)
	}
	if n := len(api.deliveries()); n != 0 {
		t.Fatalf("API accepted %d deliveries with a bad token, want 0", n)
	}
}

// TestMockIngressMatchesAPIGuardSemantics is the mock's self-check against
// internal-token.guard.ts and the API e2e spec: 503 when unconfigured, 401
// missing, 401 mismatch (any length), 400 on malformed envelope, 400 on
// smuggled extra top-level field, 201 on the valid contract. If the API
// side changes these semantics, THIS test and apps/api/test/
// internal-events.e2e.spec.ts must change together — that is the drift
// tripwire.
func TestMockIngressMatchesAPIGuardSemantics(t *testing.T) {
	validBody := `{"provider":"weather","eventId":"w-5","receivedAt":"2025-01-15T10:30:00Z","payload":{"a":1}}`
	post := func(url, token, body string) int {
		req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("X-Internal-Token", token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", url, err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}

	// Unconfigured API -> 503 even with a token presented (fail-closed).
	unconfigured := newMockInternalIngress(t, "")
	if got := post(unconfigured.url(), "anything", validBody); got != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured API status = %d, want 503", got)
	}

	api := newMockInternalIngress(t, contractToken)
	cases := []struct {
		name  string
		token string
		body  string
		want  int
	}{
		{"missing token", "", validBody, http.StatusUnauthorized},
		{"wrong token", "wrong", validBody, http.StatusUnauthorized},
		// Different-length wrong token: exercises the length-hiding hash
		// before constant-time compare.
		{"wrong token same prefix", contractToken + "-x", validBody, http.StatusUnauthorized},
		{"missing eventId", contractToken, `{"provider":"weather","receivedAt":"2025-01-15T10:30:00Z","payload":{}}`, http.StatusBadRequest},
		{"empty provider", contractToken, `{"provider":"","eventId":"w-5","receivedAt":"2025-01-15T10:30:00Z","payload":{}}`, http.StatusBadRequest},
		{"bad receivedAt", contractToken, `{"provider":"weather","eventId":"w-5","receivedAt":"not-a-date","payload":{}}`, http.StatusBadRequest},
		{"missing payload", contractToken, `{"provider":"weather","eventId":"w-5","receivedAt":"2025-01-15T10:30:00Z"}`, http.StatusBadRequest},
		// Smuggled provider-native signature field -> forbidNonWhitelisted 400.
		{"smuggled signature field", contractToken, `{"provider":"weather","eventId":"w-5","receivedAt":"2025-01-15T10:30:00Z","payload":{},"signature":"spoofed"}`, http.StatusBadRequest},
		{"valid envelope", contractToken, validBody, http.StatusCreated},
	}
	for _, tc := range cases {
		if got := post(api.url(), tc.token, tc.body); got != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, got, tc.want)
		}
	}
}
