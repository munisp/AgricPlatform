package gateway

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
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

// Metrics holds hand-rolled Prometheus counters keyed by metric + provider.
// Counters for all configured providers are pre-initialised to 0 so the
// /metrics output is stable and greppable from the first scrape.
type Metrics struct {
	mu        sync.Mutex
	counters  map[string]map[string]int64
	providers []string
}

func NewMetrics(providers []string) *Metrics {
	m := &Metrics{counters: map[string]map[string]int64{}, providers: append([]string(nil), providers...)}
	for name := range counterHelp {
		m.counters[name] = map[string]int64{}
		for _, p := range providers {
			m.counters[name][p] = 0
		}
	}
	return m
}

// Inc increments a counter for a provider.
func (m *Metrics) Inc(name, provider string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	fam, ok := m.counters[name]
	if !ok {
		fam = map[string]int64{}
		m.counters[name] = fam
	}
	fam[provider]++
}

// Value reads a counter (tests and /readyz).
func (m *Metrics) Value(name, provider string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.counters[name][provider]
}

// Render writes Prometheus text exposition format for the counters, followed
// by any extra gauge lines supplied by the caller (breaker state, spool
// backlog, mode info).
func (m *Metrics) Render(w io.Writer, extra ...string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.counters))
	for name := range m.counters {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "# HELP %s %s\n", name, counterHelp[name])
		fmt.Fprintf(w, "# TYPE %s counter\n", name)
		fam := m.counters[name]
		providers := make([]string, 0, len(fam))
		for p := range fam {
			providers = append(providers, p)
		}
		sort.Strings(providers)
		for _, p := range providers {
			fmt.Fprintf(w, "%s{provider=%q} %d\n", name, escapeLabel(p), fam[p])
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
