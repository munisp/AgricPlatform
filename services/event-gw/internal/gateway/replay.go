package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ReplayCache remembers recently seen delivery keys (provider + signature or
// body hash) so a re-POSTed webhook within the TTL is rejected instead of
// being fanned out twice.
//
// GAP-L02: markers optionally persist to a JSONL file
// (EVENTGW_REPLAY_PERSIST_PATH) so a restart does not forget recent
// deliveries inside the skew window. The file follows the Spool doctrine:
// append on mark, compact (rewrite live entries, tmp+rename) on eviction,
// one owning process. Load is FAIL-CLOSED: a corrupt marker file is a
// startup error, never a silently dropped protection.
type ReplayCache struct {
	mu          sync.Mutex
	ttl         time.Duration
	seen        map[string]time.Time // key -> expiry
	persistPath string               // empty = in-memory only
	logger      *log.Logger          // may be nil (tests)
}

// replayMarker is one persisted replay-cache entry (JSONL line).
type replayMarker struct {
	Key    string    `json:"key"`
	Expiry time.Time `json:"expiry"`
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{ttl: ttl, seen: map[string]time.Time{}}
}

// LoadReplayCache builds the replay cache for the configured persistence
// path (empty path = in-memory only, the development default). With a path,
// markers recorded before a restart are re-loaded — expired ones are
// dropped on load. A missing file is fine (first boot); a CORRUPT file
// (unreadable, or any malformed line) is an error: the operator asked for
// durable replay protection and starting without it would silently open
// the replay window the setting exists to close.
func LoadReplayCache(ttl time.Duration, persistPath string, logger *log.Logger) (*ReplayCache, error) {
	c := NewReplayCache(ttl)
	c.persistPath = persistPath
	c.logger = logger
	if persistPath == "" {
		return c, nil
	}
	data, err := os.ReadFile(persistPath)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return nil, fmt.Errorf("replay persist read %s: %w", persistPath, err)
	}
	now := time.Now()
	lineNo := 0
	for _, line := range splitNonEmptyLines(data) {
		lineNo++
		var marker replayMarker
		if err := json.Unmarshal(line, &marker); err != nil || marker.Key == "" || marker.Expiry.IsZero() {
			return nil, fmt.Errorf("replay persist %s: corrupt marker at line %d (fail-closed: refusing to drop replay protection)", persistPath, lineNo)
		}
		if now.Before(marker.Expiry) {
			c.seen[marker.Key] = marker.Expiry
		}
	}
	return c, nil
}

// CheckAndMark reports whether key is fresh (true) and marks it seen. A key
// still within its TTL reports false (replay). When persistence is
// configured, the marker is appended to the JSONL file BEFORE the call
// reports fresh; a persistence failure is an error and the caller must
// treat the delivery as NOT safely marked (the edge answers 503 —
// fail-closed — rather than accepting a webhook it can no longer
// replay-guard).
func (c *ReplayCache) CheckAndMark(key string, now time.Time) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if exp, ok := c.seen[key]; ok && now.Before(exp) {
		return false, nil
	}
	expiry := now.Add(c.ttl)
	if err := c.persistAppend(replayMarker{Key: key, Expiry: expiry}); err != nil {
		return false, err
	}
	c.seen[key] = expiry
	return true, nil
}

// Len is visible for tests and metrics.
func (c *ReplayCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}

// evict removes expired entries (compacting the persist file when
// configured). Called on an interval by StartEviction.
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
	if removed > 0 {
		if err := c.persistCompactLocked(); err != nil && c.logger != nil {
			// Non-fatal: markers stay on disk (at worst a stale marker
			// rejects a fresh delivery inside the skew window after
			// restart); the next eviction retries the compaction.
			c.logger.Printf("WARNING: replay persist compaction failed: %v", err)
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

// persistAppend appends one marker line to the persist file (no-op when
// persistence is not configured). Caller holds c.mu.
func (c *ReplayCache) persistAppend(marker replayMarker) error {
	if c.persistPath == "" {
		return nil
	}
	if dir := filepath.Dir(c.persistPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("replay persist mkdir: %w", err)
		}
	}
	f, err := os.OpenFile(c.persistPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("replay persist open: %w", err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(marker); err != nil {
		return fmt.Errorf("replay persist encode: %w", err)
	}
	return nil
}

// persistCompactLocked rewrites the persist file with the live markers
// only (tmp + rename, same doctrine as the spool drain). Caller holds c.mu.
func (c *ReplayCache) persistCompactLocked() error {
	if c.persistPath == "" {
		return nil
	}
	tmp := c.persistPath + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("replay persist compact open: %w", err)
	}
	enc := json.NewEncoder(f)
	for key, expiry := range c.seen {
		if err := enc.Encode(replayMarker{Key: key, Expiry: expiry}); err != nil {
			f.Close()
			return fmt.Errorf("replay persist compact encode: %w", err)
		}
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("replay persist compact close: %w", err)
	}
	if err := os.Rename(tmp, c.persistPath); err != nil {
		return fmt.Errorf("replay persist compact rename: %w", err)
	}
	return nil
}

func splitNonEmptyLines(data []byte) [][]byte {
	var lines [][]byte
	start := 0
	for i := 0; i <= len(data); i++ {
		if i == len(data) || data[i] == '\n' {
			line := data[start:i]
			if len(trimSpace(line)) > 0 {
				lines = append(lines, line)
			}
			start = i + 1
		}
	}
	return lines
}

func trimSpace(b []byte) []byte {
	for len(b) > 0 && (b[0] == ' ' || b[0] == '\t' || b[0] == '\r') {
		b = b[1:]
	}
	for len(b) > 0 {
		last := b[len(b)-1]
		if last != ' ' && last != '\t' && last != '\r' {
			break
		}
		b = b[:len(b)-1]
	}
	return b
}
