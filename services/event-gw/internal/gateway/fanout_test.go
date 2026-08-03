package gateway

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func testConfig(url string) *Config {
	return &Config{
		Mode:             ModeLive,
		IngressURL:       url,
		InternalToken:    "internal-test-token",
		SpoolPath:        "",
		MaxAttempts:      3,
		BackoffBase:      200 * time.Millisecond,
		BackoffMax:       2 * time.Second,
		BreakerThreshold: 5,
		BreakerCooldown:  30 * time.Second,
	}
}

func newTestFanout(t *testing.T, cfg *Config) (*Fanout, *Breaker, *Spool, *Metrics) {
	t.Helper()
	if cfg.SpoolPath == "" {
		cfg.SpoolPath = filepath.Join(t.TempDir(), "deadletter.jsonl")
	}
	breaker := NewBreaker(cfg.BreakerThreshold, cfg.BreakerCooldown)
	spool := NewSpool(cfg.SpoolPath)
	metrics := NewMetrics([]string{"weather"})
	logger := log.New(io.Discard, "", 0)
	f := NewFanout(cfg, breaker, spool, metrics, logger)
	f.Sleep = func(time.Duration) {} // never really sleep in tests
	return f, breaker, spool, metrics
}

func testEnvelope() Envelope {
	return Envelope{
		Provider:   "weather",
		EventID:    "evt_test123",
		ReceivedAt: time.Unix(1_700_000_000, 0).UTC().Format(time.RFC3339),
		Payload:    json.RawMessage(`{"alert":"heavy-rain"}`),
	}
}

// failThenOKServer answers 500 while `remaining` (atomic) is positive, then 200.
// Tests can flip the server between unhealthy and healthy by setting remaining.
var serverRemaining atomic.Int64

func failThenOKServer(failures int, calls *atomic.Int64) *httptest.Server {
	serverRemaining.Store(int64(failures))
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls != nil {
			calls.Add(1)
		}
		if serverRemaining.Load() > 0 {
			serverRemaining.Add(-1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
}

func TestFanoutRetriesThenSucceeds(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(2, &calls) // fail, fail, then succeed
	defer srv.Close()

	f, _, _, metrics := newTestFanout(t, testConfig(srv.URL))
	outcome, err := f.Deliver(testEnvelope())
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if outcome != DeliveryDelivered {
		t.Fatalf("outcome = %q, want delivered", outcome)
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3 (2 failures + success)", got)
	}
	if got := metrics.Value(MetricFanned, "weather"); got != 1 {
		t.Fatalf("fanned = %d, want 1", got)
	}
}

func TestFanoutBackoffSchedule(t *testing.T) {
	f, _, _, _ := newTestFanout(t, testConfig("http://example.invalid"))
	cases := []struct {
		i    int
		want time.Duration
	}{
		{0, 200 * time.Millisecond},
		{1, 800 * time.Millisecond},
		{2, 2 * time.Second}, // 3.2s capped at 2s
		{5, 2 * time.Second},
	}
	for _, tc := range cases {
		if got := f.backoff(tc.i); got != tc.want {
			t.Fatalf("backoff(%d) = %v, want %v", tc.i, got, tc.want)
		}
	}
}

func TestFanoutSpoolsAfterExhaustingRetries(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls) // always fails
	defer srv.Close()

	f, _, spool, metrics := newTestFanout(t, testConfig(srv.URL))
	outcome, err := f.Deliver(testEnvelope())
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if outcome != DeliverySpooled {
		t.Fatalf("outcome = %q, want spooled", outcome)
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3 (maxAttempts)", got)
	}
	if got := spool.Backlog(); got != 1 {
		t.Fatalf("spool backlog = %d, want 1", got)
	}
	if got := metrics.Value(MetricDeadlettered, "weather"); got != 1 {
		t.Fatalf("deadlettered = %d, want 1", got)
	}
	// Spool line must be the envelope, parseable.
	data, err := os.ReadFile(spool.Path())
	if err != nil {
		t.Fatalf("read spool: %v", err)
	}
	var env Envelope
	if err := json.Unmarshal([]byte(string(data[:len(data)-1])), &env); err != nil {
		t.Fatalf("spool line not parseable: %v", err)
	}
	if env.EventID != "evt_test123" || env.Provider != "weather" {
		t.Fatalf("spooled envelope wrong: %+v", env)
	}
}

func TestCircuitBreakerOpensAndFailsFast(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls)
	defer srv.Close()

	cfg := testConfig(srv.URL)
	cfg.BreakerThreshold = 2
	f, breaker, _, _ := newTestFanout(t, cfg)

	if _, err := f.Deliver(testEnvelope()); err != nil {
		t.Fatalf("Deliver 1: %v", err)
	}
	if _, err := f.Deliver(testEnvelope()); err != nil {
		t.Fatalf("Deliver 2: %v", err)
	}
	if breaker.State() != BreakerOpen {
		t.Fatalf("breaker state = %q, want open after 2 consecutive failures", breaker.State())
	}
	callsAtOpen := calls.Load()
	outcome, err := f.Deliver(testEnvelope())
	if err != nil {
		t.Fatalf("Deliver while open: %v", err)
	}
	if outcome != DeliverySpooled {
		t.Fatalf("outcome while open = %q, want spooled (fail fast)", outcome)
	}
	if calls.Load() != callsAtOpen {
		t.Fatal("breaker open: no HTTP attempt should be made (fail fast)")
	}
}

func TestCircuitBreakerHalfOpenCloses(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls)
	defer srv.Close()

	cfg := testConfig(srv.URL)
	cfg.BreakerThreshold = 1
	f, breaker, _, _ := newTestFanout(t, cfg)

	fakeNow := time.Unix(1_700_000_000, 0)
	breaker.Now = func() time.Time { return fakeNow }

	if _, err := f.Deliver(testEnvelope()); err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if breaker.State() != BreakerOpen {
		t.Fatalf("state = %q, want open", breaker.State())
	}
	fakeNow = fakeNow.Add(29 * time.Second)
	if breaker.State() != BreakerOpen {
		t.Fatal("breaker must stay open inside cooldown")
	}
	fakeNow = fakeNow.Add(2 * time.Second) // past 30s cooldown: half-open
	if breaker.State() != BreakerHalfOpen {
		t.Fatalf("state = %q, want half-open after cooldown", breaker.State())
	}
	// Server healthy now: the half-open probe must close the breaker.
	serverRemaining.Store(0)
	calls.Store(0)
	outcome, err := f.Deliver(testEnvelope())
	if err != nil {
		t.Fatalf("half-open Deliver: %v", err)
	}
	if outcome != DeliveryDelivered {
		t.Fatalf("outcome = %q, want delivered", outcome)
	}
	if breaker.State() != BreakerClosed {
		t.Fatalf("state = %q, want closed after successful probe", breaker.State())
	}
}

func TestCircuitBreakerHalfOpenProbeFailureReopens(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls) // always failing
	defer srv.Close()

	cfg := testConfig(srv.URL)
	cfg.BreakerThreshold = 1
	f, breaker, _, _ := newTestFanout(t, cfg)

	fakeNow := time.Unix(1_700_000_000, 0)
	breaker.Now = func() time.Time { return fakeNow }

	f.Deliver(testEnvelope())
	fakeNow = fakeNow.Add(31 * time.Second)
	if breaker.State() != BreakerHalfOpen {
		t.Fatalf("state = %q, want half-open", breaker.State())
	}
	if _, err := f.Deliver(testEnvelope()); err != nil {
		t.Fatalf("probe Deliver: %v", err)
	}
	if breaker.State() != BreakerOpen {
		t.Fatalf("state = %q, want re-opened after failed probe", breaker.State())
	}
}

func TestEnvelopeShapeAndAuthHeader(t *testing.T) {
	var gotBody []byte
	var gotToken, gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotToken = r.Header.Get("X-Internal-Token")
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f, _, _, _ := newTestFanout(t, testConfig(srv.URL))
	if _, err := f.Deliver(testEnvelope()); err != nil {
		t.Fatalf("Deliver: %v", err)
	}

	var doc map[string]json.RawMessage
	if err := json.Unmarshal(gotBody, &doc); err != nil {
		t.Fatalf("envelope is not JSON: %v", err)
	}
	for _, field := range []string{"provider", "eventId", "receivedAt", "payload"} {
		if _, ok := doc[field]; !ok {
			t.Fatalf("envelope missing field %q: %s", field, gotBody)
		}
	}
	var provider, eventID, receivedAt string
	json.Unmarshal(doc["provider"], &provider)
	json.Unmarshal(doc["eventId"], &eventID)
	json.Unmarshal(doc["receivedAt"], &receivedAt)
	if provider != "weather" || eventID != "evt_test123" {
		t.Fatalf("envelope identity wrong: provider=%q eventId=%q", provider, eventID)
	}
	if _, err := time.Parse(time.RFC3339, receivedAt); err != nil {
		t.Fatalf("receivedAt not RFC3339: %q", receivedAt)
	}
	var payload map[string]any
	if err := json.Unmarshal(doc["payload"], &payload); err != nil || payload["alert"] != "heavy-rain" {
		t.Fatalf("payload not preserved: %s", doc["payload"])
	}
	if gotToken != "internal-test-token" {
		t.Fatalf("X-Internal-Token = %q, want internal-test-token", gotToken)
	}
	if gotContentType != "application/json" {
		t.Fatalf("Content-Type = %q", gotContentType)
	}
}

func TestSpoolDrainRedeliversWhenHealthy(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls) // start unhealthy
	defer srv.Close()

	f, breaker, spool, metrics := newTestFanout(t, testConfig(srv.URL))
	if _, err := f.Deliver(testEnvelope()); err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if spool.Backlog() != 1 {
		t.Fatalf("backlog = %d, want 1", spool.Backlog())
	}

	// Ingress recovers; drain must re-deliver and empty the spool.
	calls.Store(0)
	serverRemaining.Store(0)
	stats, err := f.DrainSpool()
	if err != nil {
		t.Fatalf("DrainSpool: %v", err)
	}
	if stats.Sent != 1 || stats.SendFailed {
		t.Fatalf("stats = %+v, want Sent=1", stats)
	}
	if got := spool.Backlog(); got != 0 {
		t.Fatalf("backlog after drain = %d, want 0", got)
	}
	if _, err := os.Stat(spool.Path()); !os.IsNotExist(err) {
		t.Fatal("fully drained spool file should be removed")
	}
	if got := metrics.Value(MetricFanned, "weather"); got != 1 {
		t.Fatalf("fanned = %d, want 1 (drain delivery counted)", got)
	}
	if breaker.State() != BreakerClosed {
		t.Fatalf("breaker = %q, want closed after successful drain", breaker.State())
	}
}

func TestSpoolDrainKeepsEntriesWhenFailing(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls)
	defer srv.Close()

	cfg := testConfig(srv.URL)
	cfg.BreakerThreshold = 5 // stays closed so the drain attempts sends
	f, _, spool, _ := newTestFanout(t, cfg)

	f.Deliver(testEnvelope())
	stats, err := f.DrainSpool()
	if err != nil {
		t.Fatalf("DrainSpool: %v", err)
	}
	if !stats.SendFailed || stats.Sent != 0 {
		t.Fatalf("stats = %+v, want SendFailed with Sent=0", stats)
	}
	if got := spool.Backlog(); got != 1 {
		t.Fatalf("backlog = %d, want 1 (entry kept for next pass)", got)
	}
}

func TestDrainSkippedWhileBreakerOpen(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(1<<30, &calls)
	defer srv.Close()

	cfg := testConfig(srv.URL)
	cfg.BreakerThreshold = 1
	f, _, spool, _ := newTestFanout(t, cfg)

	f.Deliver(testEnvelope()) // opens the breaker, spools the event
	calls.Store(0)
	stats, err := f.DrainSpool()
	if err != nil {
		t.Fatalf("DrainSpool: %v", err)
	}
	if stats.Sent != 0 {
		t.Fatalf("Sent = %d, want 0 while breaker open", stats.Sent)
	}
	if calls.Load() != 0 {
		t.Fatal("no HTTP attempt should be made while the breaker is open")
	}
	if spool.Backlog() != 1 {
		t.Fatalf("backlog = %d, want 1", spool.Backlog())
	}
}

func TestSpoolPoisonLinesAreKeptNotDropped(t *testing.T) {
	var calls atomic.Int64
	srv := failThenOKServer(0, &calls) // healthy
	defer srv.Close()

	f, _, spool, _ := newTestFanout(t, testConfig(srv.URL))
	if err := spool.Append(testEnvelope()); err != nil {
		t.Fatalf("Append: %v", err)
	}
	// Inject a malformed line at the FRONT of the spool.
	data, _ := os.ReadFile(spool.Path())
	os.WriteFile(spool.Path(), append([]byte("this is not json\n"), data...), 0o640)

	stats, err := f.DrainSpool()
	if err != nil {
		t.Fatalf("DrainSpool: %v", err)
	}
	if stats.Poison != 1 {
		t.Fatalf("Poison = %d, want 1", stats.Poison)
	}
	if stats.Sent != 1 {
		t.Fatalf("Sent = %d, want 1 (valid entry behind poison must still drain)", stats.Sent)
	}
	if got := spool.Backlog(); got != 1 {
		t.Fatalf("backlog = %d, want 1 (poison line kept, not silently dropped)", got)
	}
}
