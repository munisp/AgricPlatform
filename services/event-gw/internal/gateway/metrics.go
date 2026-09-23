package gateway

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Counter names, rendered as Prometheus text.
const (
	MetricReceived     = "eventgw_webhooks_received_total"
	MetricVerified     = "eventgw_webhooks_verified_total"
	MetricRejected     = "eventgw_webhooks_rejected_total"
	MetricFanned       = "eventgw_events_fanned_total"
	MetricDeadlettered = "eventgw_events_deadlettered_total"
)

var counterHelp = map[string]string{
	MetricReceived:     "Webhook requests received for a known provider.",
	MetricVerified:     "Webhooks whose HMAC signature verified (live mode only).",
	MetricRejected:     "Webhooks rejected (bad signature, stale timestamp, replay, bad shape, misconfigured provider).",
	MetricFanned:       "Events successfully delivered to the API ingress.",
	MetricDeadlettered: "Events written to the on-disk dead-letter spool after fanout failure.",
}

// metricFamily holds the per-provider cells for one counter name. The cells
// map is immutable after construction (all configured providers are
// pre-registered), so the hot Inc path is lock-free; extra (guarded by mu)
// preserves the historical behaviour of lazily accepting unknown providers.
type metricFamily struct {
	mu    sync.Mutex
	cells map[string]*atomic.Int64
	extra map[string]*atomic.Int64
}

func (fam *metricFamily) inc(provider string) {
	if cell, ok := fam.cells[provider]; ok {
		cell.Add(1)
		return
	}
	fam.mu.Lock()
	defer fam.mu.Unlock()
	if fam.extra == nil {
		fam.extra = map[string]*atomic.Int64{}
	}
	cell, ok := fam.extra[provider]
	if !ok {
		cell = &atomic.Int64{}
		fam.extra[provider] = cell
	}
	cell.Add(1)
}

func (fam *metricFamily) value(provider string) int64 {
	if cell, ok := fam.cells[provider]; ok {
		return cell.Load()
	}
	fam.mu.Lock()
	defer fam.mu.Unlock()
	if cell, ok := fam.extra[provider]; ok {
		return cell.Load()
	}
	return 0
}

// snapshot returns the provider -> value pairs for rendering.
func (fam *metricFamily) snapshot() map[string]int64 {
	fam.mu.Lock()
	defer fam.mu.Unlock()
	out := make(map[string]int64, len(fam.cells)+len(fam.extra))
	for p, cell := range fam.cells {
		out[p] = cell.Load()
	}
	for p, cell := range fam.extra {
		out[p] = cell.Load()
	}
	return out
}

// Metrics holds hand-rolled Prometheus counters keyed by metric + provider.
// Counters for all configured providers are pre-initialised to 0 so the
// /metrics output is stable and greppable from the first scrape. The hot
// Inc path is a single atomic add — no global mutex.
type Metrics struct {
	mu        sync.Mutex // guards families and extraFams only
	families  map[string]*metricFamily
	extraFams map[string]*metricFamily
	providers []string
}

func NewMetrics(providers []string) *Metrics {
	m := &Metrics{families: map[string]*metricFamily{}, providers: append([]string(nil), providers...)}
	for name := range counterHelp {
		fam := &metricFamily{cells: map[string]*atomic.Int64{}}
		for _, p := range providers {
			fam.cells[p] = &atomic.Int64{}
		}
		m.families[name] = fam
	}
	return m
}

// Inc increments a counter for a provider.
func (m *Metrics) Inc(name, provider string) {
	if fam, ok := m.families[name]; ok {
		fam.inc(provider)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.extraFams == nil {
		m.extraFams = map[string]*metricFamily{}
	}
	fam, ok := m.extraFams[name]
	if !ok {
		fam = &metricFamily{cells: map[string]*atomic.Int64{}}
		m.extraFams[name] = fam
	}
	fam.inc(provider)
}

// Value reads a counter (tests and /readyz).
func (m *Metrics) Value(name, provider string) int64 {
	if fam, ok := m.families[name]; ok {
		return fam.value(provider)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if fam, ok := m.extraFams[name]; ok {
		return fam.value(provider)
	}
	return 0
}

// Render writes Prometheus text exposition format for the counters, followed
// by any extra gauge lines supplied by the caller (breaker state, spool
// backlog, mode info).
func (m *Metrics) Render(w io.Writer, extra ...string) {
	m.mu.Lock()
	fams := make(map[string]*metricFamily, len(m.families)+len(m.extraFams))
	for name, fam := range m.families {
		fams[name] = fam
	}
	for name, fam := range m.extraFams {
		fams[name] = fam
	}
	m.mu.Unlock()
	names := make([]string, 0, len(fams))
	for name := range fams {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "# HELP %s %s\n", name, counterHelp[name])
		fmt.Fprintf(w, "# TYPE %s counter\n", name)
		values := fams[name].snapshot()
		providers := make([]string, 0, len(values))
		for p := range values {
			providers = append(providers, p)
		}
		sort.Strings(providers)
		for _, p := range providers {
			fmt.Fprintf(w, "%s{provider=%q} %d\n", name, escapeLabel(p), values[p])
		}
	}
	for _, line := range extra {
		io.WriteString(w, line+"\n")
	}
}

// escapeLabel escapes a Prometheus label value.
func escapeLabel(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}
