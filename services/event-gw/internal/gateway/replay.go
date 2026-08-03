package gateway

import (
	"context"
	"sync"
	"time"
)

// ReplayCache remembers recently seen delivery keys (provider + signature or
// body hash) so a re-POSTed webhook within the TTL is rejected instead of
// being fanned out twice. In-memory only: a restart resets the cache, which
// is acceptable because the timestamp skew window bounds how long an old
// signed payload stays valid anyway.
type ReplayCache struct {
	mu   sync.Mutex
	ttl  time.Duration
	seen map[string]time.Time // key -> expiry
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, seen: map[string]time.Time{}}
}

// CheckAndMark reports whether key is fresh (true) and marks it seen. A key
// still within its TTL reports false (replay).
func (c *ReplayCache) CheckAndMark(key string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if exp, ok := c.seen[key]; ok && now.Before(exp) {
		return false
	}
	c.seen[key] = now.Add(c.ttl)
	return true
}

// Len is visible for tests and metrics.
func (c *ReplayCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}

// evict removes expired entries. Called on an interval by StartEviction.
func (c *ReplayCache) evict(now time.Time) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := 0
	for k, exp := range c.seen {
		if !now.Before(exp) {
			delete(c.seen, k)
			removed++
		}
	}
	return removed
}

// StartEviction runs the TTL eviction goroutine until ctx is cancelled.
func (c *ReplayCache) StartEviction(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case t := <-ticker.C:
				c.evict(t)
			}
		}
	}()
}
