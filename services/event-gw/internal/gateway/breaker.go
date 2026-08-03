package gateway

import (
	"sync"
	"time"
)

// BreakerState is the circuit breaker state reported via /readyz and /metrics.
type BreakerState string

const (
	BreakerClosed   BreakerState = "closed"
	BreakerOpen     BreakerState = "open"
	BreakerHalfOpen BreakerState = "half-open"
)

// Breaker is a circuit breaker checked at call time — no in-process timers
// (mirrors the geo-intel flood-risk driver pattern). It opens after
// `threshold` consecutive failures and stays open for `cooldown`; the first
// call after the cooldown is a half-open probe whose result decides whether
// the breaker closes or re-opens.
type Breaker struct {
	mu        sync.Mutex
	threshold int
	cooldown  time.Duration

	// Now is injectable for tests.
	Now func() time.Time

	failures      int
	openUntil     time.Time
	probeInFlight bool
}

func NewBreaker(threshold int, cooldown time.Duration) *Breaker {
	if threshold <= 0 {
		threshold = 1
	}
	return &Breaker{threshold: threshold, cooldown: cooldown, Now: time.Now}
}

// Allow reports whether a delivery attempt may proceed.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failures < b.threshold {
		return true
	}
	if b.Now().Before(b.openUntil) {
		return false
	}
	// Cooldown elapsed: half-open. Only one probe at a time.
	if b.probeInFlight {
		return false
	}
	b.probeInFlight = true
	return true
}

// OnSuccess records a successful delivery cycle and closes the breaker.
func (b *Breaker) OnSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures = 0
	b.openUntil = time.Time{}
	b.probeInFlight = false
}

// OnFailure records a failed delivery cycle. A failed half-open probe
// re-opens the breaker for another cooldown.
func (b *Breaker) OnFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.probeInFlight {
		b.probeInFlight = false
		b.openUntil = b.Now().Add(b.cooldown)
		return
	}
	b.failures++
	if b.failures >= b.threshold {
		b.openUntil = b.Now().Add(b.cooldown)
	}
}

// State reports the current breaker state for /readyz and /metrics.
func (b *Breaker) State() BreakerState {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failures < b.threshold {
		return BreakerClosed
	}
	if b.Now().Before(b.openUntil) {
		return BreakerOpen
	}
	return BreakerHalfOpen
}
