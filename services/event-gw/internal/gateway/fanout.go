package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Envelope is the JSON document POSTed to the API's internal event ingress.
type Envelope struct {
	Provider   string          `json:"provider"`
	EventID    string          `json:"eventId"`
	ReceivedAt string          `json:"receivedAt"` // RFC3339 UTC
	Payload    json.RawMessage `json:"payload"`
}

// Delivery outcomes returned by Fanout.Deliver.
const (
	DeliveryDelivered = "delivered"
	DeliverySpooled   = "spooled"
)

// Fanout delivers verified envelopes to the API ingress with bounded retries,
// a circuit breaker, and a disk-spool fallback.
type Fanout struct {
	url     string
	token   string
	client  *http.Client
	breaker *Breaker
	spool   *Spool
	metrics *Metrics
	logger  *log.Logger

	maxAttempts int
	backoffBase time.Duration
	backoffMax  time.Duration

	// Sleep is injectable for tests (defaults to time.Sleep).
	Sleep func(time.Duration)
}

func NewFanout(cfg *Config, breaker *Breaker, spool *Spool, metrics *Metrics, logger *log.Logger) *Fanout {
	return &Fanout{
		url:         cfg.IngressURL,
		token:       cfg.InternalToken,
		client:      &http.Client{Timeout: 10 * time.Second},
		breaker:     breaker,
		spool:       spool,
		metrics:     metrics,
		logger:      logger,
		maxAttempts: cfg.MaxAttempts,
		backoffBase: cfg.BackoffBase,
		backoffMax:  cfg.BackoffMax,
		Sleep:       time.Sleep,
	}
}

// Breaker exposes the breaker for readiness reporting.
func (f *Fanout) Breaker() *Breaker { return f.breaker }

// Spool exposes the spool for readiness reporting.
func (f *Fanout) Spool() *Spool { return f.spool }

// backoff returns the wait before attempt i+1 (i is 0 for the first retry):
// 200ms -> 800ms -> 2s (cap) with the default policy.
func (f *Fanout) backoff(i int) time.Duration {
	d := f.backoffBase
	for ; i > 0; i-- {
		d *= 4
		if d >= f.backoffMax {
			return f.backoffMax
		}
	}
	if d > f.backoffMax {
		return f.backoffMax
	}
	return d
}

// postOnce performs a single delivery attempt.
func (f *Fanout) postOnce(env Envelope) error {
	body, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, f.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if f.token != "" {
		req.Header.Set("X-Internal-Token", f.token)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("ingress POST: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ingress answered status %d", resp.StatusCode)
	}
	return nil
}

// Deliver tries to deliver env to the API ingress. With the circuit breaker
// open it fails fast straight to the spool. Otherwise it retries up to
// maxAttempts with exponential backoff; a cycle that exhausts its attempts
// counts as one consecutive failure towards the breaker and the envelope is
// appended to the on-disk spool. The returned error is non-nil only when the
// event could be neither delivered nor spooled.
func (f *Fanout) Deliver(env Envelope) (string, error) {
	if !f.breaker.Allow() {
		if err := f.spool.Append(env); err != nil {
			return "", fmt.Errorf("breaker open and spool append failed: %w", err)
		}
		f.metrics.Inc(MetricDeadlettered, env.Provider)
		return DeliverySpooled, nil
	}
	var lastErr error
	for attempt := 0; attempt < f.maxAttempts; attempt++ {
		if attempt > 0 {
			f.Sleep(f.backoff(attempt - 1))
		}
		if lastErr = f.postOnce(env); lastErr == nil {
			f.breaker.OnSuccess()
			f.metrics.Inc(MetricFanned, env.Provider)
			return DeliveryDelivered, nil
		}
	}
	f.breaker.OnFailure()
	if err := f.spool.Append(env); err != nil {
		return "", fmt.Errorf("fanout failed (%v) and spool append failed: %w", lastErr, err)
	}
	f.metrics.Inc(MetricDeadlettered, env.Provider)
	return DeliverySpooled, nil
}

// DrainSpool re-delivers spooled entries when the breaker is not open.
// Sends are raw single attempts (no retry loop, no re-spooling); results are
// fed back into the breaker so a successful drain closes a half-open circuit
// and a failed drain re-opens it.
func (f *Fanout) DrainSpool() (DrainStats, error) {
	var stats DrainStats
	if f.breaker.State() == BreakerOpen {
		return stats, nil
	}
	stats, err := f.spool.Drain(func(env Envelope) error {
		if err := f.postOnce(env); err != nil {
			return err
		}
		f.metrics.Inc(MetricFanned, env.Provider)
		return nil
	})
	if err != nil {
		return stats, err
	}
	if stats.SendFailed {
		f.breaker.OnFailure()
	} else if stats.Sent > 0 {
		f.breaker.OnSuccess()
	}
	return stats, nil
}

// StartDrainLoop runs the background spool re-drain until ctx is cancelled.
func (f *Fanout) StartDrainLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				stats, err := f.DrainSpool()
				if err != nil {
					f.logger.Printf("ERROR: spool drain failed: %v", err)
					continue
				}
				if stats.Sent > 0 || stats.Poison > 0 {
					f.logger.Printf("spool drain: re-delivered=%d poison=%d backlog=%d", stats.Sent, stats.Poison, f.spool.Backlog())
				}
			}
		}
	}()
}
