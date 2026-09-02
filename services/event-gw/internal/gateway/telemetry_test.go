package gateway

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	tracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestLoadTelemetryConfigDefaults(t *testing.T) {
	cfg := LoadTelemetryConfig(envMap(map[string]string{}))
	if !cfg.Enabled {
		t.Fatal("OTEL_ENABLED unset: telemetry must default to enabled")
	}
	if cfg.Endpoint != DefaultOTLPEndpoint {
		t.Fatalf("Endpoint = %q, want %q", cfg.Endpoint, DefaultOTLPEndpoint)
	}
	if cfg.ServiceName != "event-gw" {
		t.Fatalf("ServiceName = %q, want event-gw", cfg.ServiceName)
	}
}

func TestLoadTelemetryConfigDisableValues(t *testing.T) {
	for _, v := range []string{"false", "FALSE", "0", "no", "off", " off "} {
		if LoadTelemetryConfig(envMap(map[string]string{"OTEL_ENABLED": v})).Enabled {
			t.Fatalf("OTEL_ENABLED=%q must disable telemetry", v)
		}
	}
	cfg := LoadTelemetryConfig(envMap(map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318/",
		"OTEL_SERVICE_NAME":           "edge",
	}))
	if !cfg.Enabled || cfg.Endpoint != "http://collector:4318" || cfg.ServiceName != "edge" {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
}

func TestTelemetryDisabledIsPassThrough(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	tel := InitTelemetry(context.Background(), TelemetryConfig{Enabled: false}, logger)
	if tel.Enabled() {
		t.Fatal("disabled config must yield disabled telemetry")
	}
	called := false
	h := tel.WrapRoute("GET /healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusTeapot)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if !called || rec.Code != http.StatusTeapot {
		t.Fatalf("pass-through broken: called=%v code=%d", called, rec.Code)
	}
	if err := tel.Shutdown(context.Background()); err != nil {
		t.Fatalf("disabled shutdown: %v", err)
	}
}

// otlpSink is an httptest server pretending to be an OTLP/HTTP collector.
type otlpSink struct {
	srv *httptest.Server

	mu        sync.Mutex
	traceHits int
	lastSpans []*decodedSpan
}

type decodedSpan struct {
	name  string
	attrs map[string]string
}

func newOTLPSink(t *testing.T) *otlpSink {
	t.Helper()
	sink := &otlpSink{}
	sink.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path == "/v1/traces" {
			var req tracepb.ExportTraceServiceRequest
			if err := proto.Unmarshal(body, &req); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			sink.mu.Lock()
			sink.traceHits++
			sink.lastSpans = sink.lastSpans[:0]
			for _, rs := range req.ResourceSpans {
				for _, ss := range rs.ScopeSpans {
					for _, sp := range ss.Spans {
						d := &decodedSpan{name: sp.Name, attrs: map[string]string{}}
						for _, kv := range sp.Attributes {
							d.attrs[kv.Key] = kv.Value.GetStringValue()
							if kv.Value.GetIntValue() != 0 {
								d.attrs[kv.Key] = strconv.Itoa(int(kv.Value.GetIntValue()))
							}
						}
						sink.lastSpans = append(sink.lastSpans, d)
					}
				}
			}
			sink.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(sink.srv.Close)
	return sink
}

func TestTelemetryExportsServerSpansToOTLPSink(t *testing.T) {
	sink := newOTLPSink(t)
	logger := log.New(io.Discard, "", 0)
	tel := InitTelemetry(context.Background(), TelemetryConfig{
		Enabled:     true,
		Endpoint:    sink.srv.URL,
		ServiceName: "event-gw-test",
	}, logger)
	if !tel.Enabled() {
		t.Fatal("telemetry must be enabled against a reachable endpoint")
	}

	mux := http.NewServeMux()
	mux.Handle("POST /webhooks/{provider}", tel.WrapRoute("POST /webhooks/{provider}",
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusAccepted)
		})))
	handler := mux

	req := httptest.NewRequest(http.MethodPost, "/webhooks/weather", nil)
	req.Header.Set("x-tenant-id", "tenant-42")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}

	// Flush and stop: Shutdown forces the batcher to export synchronously.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := tel.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown flush: %v", err)
	}

	sink.mu.Lock()
	defer sink.mu.Unlock()
	if sink.traceHits == 0 {
		t.Fatal("OTLP sink received no /v1/traces export")
	}
	if len(sink.lastSpans) != 1 {
		t.Fatalf("exported spans = %d, want 1", len(sink.lastSpans))
	}
	span := sink.lastSpans[0]
	if span.name != "POST /webhooks/{provider}" {
		t.Fatalf("span name = %q, want route template %q", span.name, "POST /webhooks/{provider}")
	}
	if span.attrs["tenant.id"] != "tenant-42" {
		t.Fatalf("tenant.id attr = %q, want tenant-42 (attrs=%v)", span.attrs["tenant.id"], span.attrs)
	}
	if span.attrs["http.route"] != "/webhooks/{provider}" {
		t.Fatalf("http.route attr = %q, want /webhooks/{provider}", span.attrs["http.route"])
	}
}

func TestTelemetryDeadCollectorNeverBlocks(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	start := time.Now()
	tel := InitTelemetry(context.Background(), TelemetryConfig{
		Enabled:     true,
		Endpoint:    "http://127.0.0.1:1", // guaranteed dead
		ServiceName: "event-gw-test",
	}, logger)
	h := tel.WrapRoute("GET /healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with a dead collector", rec.Code)
	}
	// Shutdown against a dead endpoint must respect the context deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = tel.Shutdown(ctx)
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("dead collector blocked the app for %v", elapsed)
	}
}
