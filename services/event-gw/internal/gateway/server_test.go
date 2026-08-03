package gateway

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testEdge builds a full edge server against a healthy httptest ingress and
// returns it plus the captured ingress request count.
func testEdge(t *testing.T, mode string, providers map[string]*ProviderConfig) (*Server, *httptest.Server, *Metrics, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	ingress := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ingress.Close)

	order := make([]string, 0, len(providers))
	for name := range providers {
		order = append(order, name)
	}
	cfg := &Config{
		Mode:             mode,
		Providers:        providers,
		ProviderOrder:    order,
		IngressURL:       ingress.URL,
		InternalToken:    "internal-test-token",
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
	srv := NewServer(cfg, fanout, metrics, logger)
	return srv, ingress, metrics, &calls
}

func liveProvider(secret string) map[string]*ProviderConfig {
	return map[string]*ProviderConfig{
		"weather": {
			Name: "weather", Secret: secret, SigHeader: "X-Signature",
			TsHeader: "X-Timestamp", SigEncoding: "hex", Configured: secret != "",
		},
	}
}

func doWebhook(t *testing.T, srv *Server, provider, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/webhooks/"+provider, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)
	return rec
}

func signedHeaders(secret, body string, now time.Time) map[string]string {
	return map[string]string{
		"X-Signature": ComputeSignature(secret, []byte(body), "hex"),
		"X-Timestamp": strconv.FormatInt(now.Unix(), 10),
	}
}

func TestStubModeAcceptsWithoutSignature(t *testing.T) {
	srv, _, metrics, calls := testEdge(t, ModeStub, liveProvider(""))
	rec := doWebhook(t, srv, "weather", testBody, nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body)
	}
	var resp map[string]string
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["status"] != "accepted" || resp["delivery"] != DeliveryDelivered {
		t.Fatalf("response = %v", resp)
	}
	if resp["eventId"] == "" {
		t.Fatal("response must include an eventId")
	}
	if calls.Load() != 1 {
		t.Fatalf("ingress calls = %d, want 1", calls.Load())
	}
	// Honest metrics: stub-mode events are received but NOT verified.
	if got := metrics.Value(MetricReceived, "weather"); got != 1 {
		t.Fatalf("received = %d, want 1", got)
	}
	if got := metrics.Value(MetricVerified, "weather"); got != 0 {
		t.Fatalf("verified = %d, want 0 in stub mode", got)
	}
}

func TestLiveModeAcceptsValidSignature(t *testing.T) {
	srv, _, metrics, calls := testEdge(t, ModeLive, liveProvider(testSecret))
	now := time.Now()
	rec := doWebhook(t, srv, "weather", testBody, signedHeaders(testSecret, testBody, now))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body)
	}
	if calls.Load() != 1 {
		t.Fatalf("ingress calls = %d, want 1", calls.Load())
	}
	if got := metrics.Value(MetricVerified, "weather"); got != 1 {
		t.Fatalf("verified = %d, want 1", got)
	}
}

func TestLiveModeRejections(t *testing.T) {
	now := time.Now()
	good := signedHeaders(testSecret, testBody, now)
	cases := []struct {
		name    string
		headers map[string]string
		body    string
		want    int
	}{
		{"invalid signature", map[string]string{"X-Signature": "deadbeef" + good["X-Signature"][8:], "X-Timestamp": good["X-Timestamp"]}, testBody, http.StatusUnauthorized},
		{"missing signature", map[string]string{"X-Timestamp": good["X-Timestamp"]}, testBody, http.StatusUnauthorized},
		{"missing timestamp", map[string]string{"X-Signature": good["X-Signature"]}, testBody, http.StatusUnauthorized},
		{"stale timestamp (301s)", map[string]string{
			"X-Signature": good["X-Signature"],
			"X-Timestamp": strconv.FormatInt(now.Add(-301*time.Second).Unix(), 10),
		}, testBody, http.StatusUnauthorized},
		{"fresh timestamp at 299s accepted", map[string]string{
			"X-Signature": good["X-Signature"],
			"X-Timestamp": strconv.FormatInt(now.Add(-299*time.Second).Unix(), 10),
		}, testBody, http.StatusAccepted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, _, _ := testEdge(t, ModeLive, liveProvider(testSecret))
			rec := doWebhook(t, srv, "weather", tc.body, tc.headers)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.want, rec.Body)
			}
		})
	}
}

func TestLiveModeMissingSecret503(t *testing.T) {
	srv, _, _, calls := testEdge(t, ModeLive, liveProvider("")) // no secret
	rec := doWebhook(t, srv, "weather", testBody, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (fail-closed)", rec.Code)
	}
	if calls.Load() != 0 {
		t.Fatal("misconfigured provider must never fan out")
	}
	var resp map[string]string
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if !strings.Contains(resp["reason"], "EVENTGW_SECRET_WEATHER") {
		t.Fatalf("reason should name the missing env var: %v", resp)
	}
}

func TestUnknownProvider404(t *testing.T) {
	srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
	rec := doWebhook(t, srv, "not-a-provider", testBody, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestMalformedBodiesRejected(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty body", ""},
		{"not json", "hello provider"},
		{"json array", `[{"event":"x"}]`},
		{"json scalar", `42`},
		{"truncated json", `{"event":`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, metrics, calls := testEdge(t, ModeStub, liveProvider(""))
			rec := doWebhook(t, srv, "weather", tc.body, nil)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
			}
			if calls.Load() != 0 {
				t.Fatal("malformed events must never fan out")
			}
			if got := metrics.Value(MetricRejected, "weather"); got != 1 {
				t.Fatalf("rejected = %d, want 1", got)
			}
		})
	}
}

func TestReplayRejected(t *testing.T) {
	srv, _, _, calls := testEdge(t, ModeLive, liveProvider(testSecret))
	now := time.Now()
	headers := signedHeaders(testSecret, testBody, now)

	rec := doWebhook(t, srv, "weather", testBody, headers)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first delivery status = %d, want 202", rec.Code)
	}
	rec = doWebhook(t, srv, "weather", testBody, headers)
	if rec.Code != http.StatusConflict {
		t.Fatalf("replayed delivery status = %d, want 409: %s", rec.Code, rec.Body)
	}
	if calls.Load() != 1 {
		t.Fatalf("ingress calls = %d, want 1 (replay not fanned out)", calls.Load())
	}
}

func TestEventIDExtraction(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"eventId field", `{"eventId":"w-42","data":1}`, "w-42"},
		{"event_id field", `{"event_id":"w-43"}`, "w-43"},
		{"id field", `{"id":"w-44"}`, "w-44"},
		{"numeric id", `{"id":12345}`, "12345"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
			rec := doWebhook(t, srv, "weather", tc.body, nil)
			if rec.Code != http.StatusAccepted {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body)
			}
			var resp map[string]string
			json.Unmarshal(rec.Body.Bytes(), &resp)
			if resp["eventId"] != tc.want {
				t.Fatalf("eventId = %q, want %q", resp["eventId"], tc.want)
			}
		})
	}
	// No id field: a generated evt_ id.
	srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
	rec := doWebhook(t, srv, "weather", `{"no":"id"}`, nil)
	var resp map[string]string
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if !strings.HasPrefix(resp["eventId"], "evt_") {
		t.Fatalf("generated eventId should have evt_ prefix, got %q", resp["eventId"])
	}
}

func TestEndToEndSpooledDeliveryReported(t *testing.T) {
	srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
	// Point fanout at a dead ingress.
	srv.fanout.url = "http://127.0.0.1:1/unreachable"
	rec := doWebhook(t, srv, "weather", testBody, nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 even when spooled", rec.Code)
	}
	var resp map[string]string
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["delivery"] != DeliverySpooled {
		t.Fatalf("delivery = %q, want spooled", resp["delivery"])
	}
	if got := srv.fanout.spool.Backlog(); got != 1 {
		t.Fatalf("backlog = %d, want 1", got)
	}
}

func TestHealthzAndReadyzAndMetrics(t *testing.T) {
	srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
	handler := srv.Routes()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", rec.Code)
	}
	var health map[string]any
	json.Unmarshal(rec.Body.Bytes(), &health)
	if health["mode"] != ModeStub || health["status"] != "ok" {
		t.Fatalf("healthz body = %v", health)
	}

	// readyz: closed breaker, empty spool -> 200 with detail.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz = %d, want 200", rec.Code)
	}
	var ready map[string]any
	json.Unmarshal(rec.Body.Bytes(), &ready)
	if ready["breaker"] != string(BreakerClosed) || ready["spoolBacklog"].(float64) != 0 {
		t.Fatalf("readyz body = %v", ready)
	}

	// metrics: Prometheus text with per-provider counters + gauges.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("metrics = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("metrics content-type = %q", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`eventgw_webhooks_received_total{provider="weather"} 0`,
		`eventgw_webhooks_verified_total{provider="weather"} 0`,
		`eventgw_webhooks_rejected_total{provider="weather"} 0`,
		`eventgw_events_fanned_total{provider="weather"} 0`,
		`eventgw_events_deadlettered_total{provider="weather"} 0`,
		`eventgw_spool_backlog 0`,
		`eventgw_breaker_open 0`,
		`eventgw_mode{mode="stub"} 1`,
		"# TYPE eventgw_webhooks_received_total counter",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics output missing %q:\n%s", want, body)
		}
	}
}

func TestReadyzReportsOpenBreakerAndBacklog(t *testing.T) {
	srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
	srv.fanout.url = "http://127.0.0.1:1/unreachable"
	srv.cfg.BreakerThreshold = 1
	srv.fanout.breaker = NewBreaker(1, time.Minute)

	rec := doWebhook(t, srv, "weather", testBody, nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	ready := httptest.NewRecorder()
	srv.Routes().ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d, want 503 while breaker open", ready.Code)
	}
	var body map[string]any
	json.Unmarshal(ready.Body.Bytes(), &body)
	if body["breaker"] != string(BreakerOpen) {
		t.Fatalf("breaker = %v, want open", body["breaker"])
	}
	if body["spoolBacklog"].(float64) != 1 {
		t.Fatalf("spoolBacklog = %v, want 1", body["spoolBacklog"])
	}
	if body["status"] != "degraded" {
		t.Fatalf("status = %v, want degraded", body["status"])
	}
}

func TestMethodRouting(t *testing.T) {
	srv, _, _, _ := testEdge(t, ModeStub, liveProvider(""))
	handler := srv.Routes()
	// GET on the webhook route must not match (405 with Go 1.22 method patterns).
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/webhooks/weather", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /webhooks/weather = %d, want 405", rec.Code)
	}
}
