package gateway

import (
	"context"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// OpenTelemetry wiring for event-gw. No-op-safe contract:
//
//   - OTEL_ENABLED (default true): any of "false|0|no|off" disables
//     telemetry entirely — no SDK is constructed and Middleware is a pass-through.
//   - OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318): OTLP/HTTP
//     collector base URL. When the collector is absent the SDK only logs
//     export warnings in the background; the app never blocks or crashes.
//   - OTEL_SERVICE_NAME (default "event-gw"): service.name resource attribute.
//
// Every request span is named by its Go 1.22 route template (e.g.
// "POST /webhooks/{provider}") and carries tenant.id when the inbound
// x-tenant-id header is present. The plaintext GET /metrics endpoint is
// unchanged; OTLP metrics are exported alongside it.

// TelemetryConfig is the OTel runtime configuration (env-driven, injectable
// for tests — same style as LoadConfig).
type TelemetryConfig struct {
	Enabled     bool
	Endpoint    string // OTLP/HTTP base URL, no trailing slash
	ServiceName string
}

// DefaultOTLPEndpoint is used when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
const DefaultOTLPEndpoint = "http://localhost:4318"

// LoadTelemetryConfig reads the OTEL_* environment. OTEL_ENABLED defaults to
// true; only explicit negative values ("false", "0", "no", "off") disable.
func LoadTelemetryConfig(get func(string) string) TelemetryConfig {
	enabled := true
	switch strings.ToLower(strings.TrimSpace(get("OTEL_ENABLED"))) {
	case "false", "0", "no", "off":
		enabled = false
	}
	return TelemetryConfig{
		Enabled:     enabled,
		Endpoint:    strings.TrimRight(envOr(get, "OTEL_EXPORTER_OTLP_ENDPOINT", DefaultOTLPEndpoint), "/"),
		ServiceName: envOr(get, "OTEL_SERVICE_NAME", "event-gw"),
	}
}

// Telemetry holds the initialized SDK pieces. The zero value (and every
// failure path) is a valid disabled telemetry: Middleware passes through and
// Shutdown is a no-op.
type Telemetry struct {
	enabled  bool
	tracer   trace.Tracer
	requests metric.Int64Counter
	shutdown func(context.Context) error
}

// statusRecorder captures the response status for span/metric attributes.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// InitTelemetry constructs the OTel SDK from cfg. It never fails fatally:
// any setup error is logged as a warning and the returned Telemetry is
// disabled (app continues untraced).
func InitTelemetry(ctx context.Context, cfg TelemetryConfig, logger *log.Logger) *Telemetry {
	if !cfg.Enabled {
		logger.Println("OTEL_ENABLED is disabled; OpenTelemetry instrumentation skipped")
		return &Telemetry{}
	}

	res, err := resource.New(ctx, resource.WithAttributes(semconv.ServiceName(cfg.ServiceName)))
	if err != nil {
		logger.Printf("WARNING: OTel resource init failed (%v); telemetry disabled", err)
		return &Telemetry{}
	}

	traceExporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(cfg.Endpoint+"/v1/traces"),
		otlptracehttp.WithTimeout(5*time.Second),
	)
	if err != nil {
		logger.Printf("WARNING: OTel trace exporter init failed (%v); telemetry disabled", err)
		return &Telemetry{}
	}
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(traceExporter), // async: a dead collector never blocks requests
	)
	otel.SetTracerProvider(tracerProvider)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))

	metricExporter, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(cfg.Endpoint+"/v1/metrics"),
		otlpmetrichttp.WithTimeout(5*time.Second),
	)
	if err != nil {
		logger.Printf("WARNING: OTel metric exporter init failed (%v); traces only", err)
	}
	var meterProvider *sdkmetric.MeterProvider
	if err == nil {
		meterProvider = sdkmetric.NewMeterProvider(
			sdkmetric.WithResource(res),
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter)),
		)
		otel.SetMeterProvider(meterProvider)
	}

	requests, err := otel.Meter("event-gw").Int64Counter(
		"eventgw.http.server.requests",
		metric.WithDescription("HTTP requests handled by the event-gw edge"),
	)
	if err != nil {
		logger.Printf("WARNING: OTel counter init failed (%v); request metrics disabled", err)
		requests = nil
	}

	t := &Telemetry{
		enabled:  true,
		tracer:   otel.Tracer("event-gw"),
		requests: requests,
		shutdown: func(ctx context.Context) error {
			if meterProvider != nil {
				_ = meterProvider.Shutdown(ctx)
			}
			return tracerProvider.Shutdown(ctx)
		},
	}
	logger.Printf("OpenTelemetry enabled: service=%s endpoint=%s", cfg.ServiceName, cfg.Endpoint)
	return t
}

// Enabled reports whether telemetry is active.
func (t *Telemetry) Enabled() bool { return t != nil && t.enabled }

// Shutdown flushes and stops the SDK. Safe on nil/disabled telemetry.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if t == nil || t.shutdown == nil {
		return nil
	}
	return t.shutdown(ctx)
}

// WrapRoute wraps next with an OTel server span per request, named by the
// Go 1.22 route template (pattern, e.g. "POST /webhooks/{provider}") so span
// names stay low-cardinality. The inbound x-tenant-id header is propagated
// to the tenant.id span attribute and the request counter. Disabled
// telemetry is a pure pass-through.
func (t *Telemetry) WrapRoute(pattern string, next http.Handler) http.Handler {
	if !t.Enabled() {
		return next
	}
	// Route template without the method prefix: "POST /webhooks/{provider}"
	// -> "/webhooks/{provider}" (semconv http.route is path-only).
	route := pattern
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		route = pattern[i+1:]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := t.tracer.Start(ctx, pattern,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				semconv.HTTPRequestMethodKey.String(r.Method),
				semconv.HTTPRoute(route),
			),
		)
		defer span.End()

		tenant := strings.TrimSpace(r.Header.Get("x-tenant-id"))
		if tenant != "" {
			span.SetAttributes(attribute.String("tenant.id", tenant))
		}

		rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r.WithContext(ctx))

		span.SetAttributes(semconv.HTTPResponseStatusCode(rw.status))
		if rw.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(rw.status))
		}

		if t.requests != nil {
			attrs := []attribute.KeyValue{
				semconv.HTTPRequestMethodKey.String(r.Method),
				semconv.HTTPRoute(route),
				attribute.String("http.response.status_code", strconv.Itoa(rw.status)),
			}
			if tenant != "" {
				attrs = append(attrs, attribute.String("tenant.id", tenant))
			}
			t.requests.Add(ctx, 1, metric.WithAttributes(attrs...))
		}
	})
}
