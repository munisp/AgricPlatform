package gateway

import (
	"context"
	"testing"
	"time"
)

func TestReplayCacheAcceptsThenRejects(t *testing.T) {
	c := NewReplayCache(10 * time.Minute)
	now := time.Unix(1_700_000_000, 0)
	if !c.CheckAndMark("weather|1700000000|abc", now) {
		t.Fatal("first delivery should be accepted")
	}
	if c.CheckAndMark("weather|1700000000|abc", now.Add(time.Second)) {
		t.Fatal("replayed delivery inside TTL should be rejected")
	}
	if !c.CheckAndMark("weather|1700000000|different-sig", now.Add(time.Second)) {
		t.Fatal("different signature should be accepted")
	}
}

func TestReplayCacheExpiresAfterTTL(t *testing.T) {
	c := NewReplayCache(time.Minute)
	now := time.Unix(1_700_000_000, 0)
	if !c.CheckAndMark("k", now) {
		t.Fatal("first delivery should be accepted")
	}
	// At exactly TTL the entry has expired (CheckAndMark uses strict Before).
	if !c.CheckAndMark("k", now.Add(time.Minute)) {
		t.Fatal("delivery at/after TTL should be accepted again")
	}
}

func TestReplayCacheEviction(t *testing.T) {
	c := NewReplayCache(time.Minute)
	now := time.Unix(1_700_000_000, 0)
	c.CheckAndMark("old", now)
	c.CheckAndMark("fresh", now.Add(90*time.Second))
	if c.Len() != 2 {
		t.Fatalf("Len = %d, want 2", c.Len())
	}
	removed := c.evict(now.Add(91 * time.Second))
	if removed != 1 {
		t.Fatalf("evict removed %d, want 1", removed)
	}
	if c.Len() != 1 {
		t.Fatalf("Len = %d, want 1", c.Len())
	}
}

func TestReplayCacheEvictionGoroutineStops(t *testing.T) {
	c := NewReplayCache(time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	c.StartEviction(ctx, time.Millisecond)
	c.CheckAndMark("k", time.Now())
	time.Sleep(10 * time.Millisecond)
	cancel() // must not deadlock or panic
}
