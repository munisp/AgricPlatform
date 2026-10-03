package gateway

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReplayCacheAcceptsThenRejects(t *testing.T) {
	c := NewReplayCache(10 * time.Minute)
	now := time.Unix(1_700_000_000, 0)
	if fresh, err := c.CheckAndMark("weather|1700000000|abc", now); err != nil || !fresh {
		t.Fatalf("first delivery should be accepted (fresh=%v, err=%v)", fresh, err)
	}
	if fresh, err := c.CheckAndMark("weather|1700000000|abc", now.Add(time.Second)); err != nil || fresh {
		t.Fatal("replayed delivery inside TTL should be rejected")
	}
	if fresh, err := c.CheckAndMark("weather|1700000000|different-sig", now.Add(time.Second)); err != nil || !fresh {
		t.Fatal("different signature should be accepted")
	}
}

func TestReplayCacheExpiresAfterTTL(t *testing.T) {
	c := NewReplayCache(time.Minute)
	now := time.Unix(1_700_000_000, 0)
	if fresh, _ := c.CheckAndMark("k", now); !fresh {
		t.Fatal("first delivery should be accepted")
	}
	// At exactly TTL the entry has expired (CheckAndMark uses strict Before).
	if fresh, _ := c.CheckAndMark("k", now.Add(time.Minute)); !fresh {
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

// GAP-L02: persisted replay markers survive a "restart" (a fresh cache
// loaded from the same file), so the replay window stays closed.
func TestReplayCachePersistenceSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replay", "markers.jsonl")
	now := time.Now()

	first, err := LoadReplayCache(10*time.Minute, path, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if fresh, err := first.CheckAndMark("payments|1700000000|sig-a", now); err != nil || !fresh {
		t.Fatalf("first delivery should be accepted (fresh=%v, err=%v)", fresh, err)
	}

	// Simulated restart: a brand-new cache over the same file.
	second, err := LoadReplayCache(10*time.Minute, path, nil)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if fresh, _ := second.CheckAndMark("payments|1700000000|sig-a", now.Add(time.Second)); fresh {
		t.Fatal("replay after restart should still be rejected")
	}
	if fresh, _ := second.CheckAndMark("payments|1700000000|sig-b", now.Add(time.Second)); !fresh {
		t.Fatal("a different delivery after restart should be accepted")
	}
}

func TestReplayCachePersistenceDropsExpiredOnLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "markers.jsonl")

	first, err := LoadReplayCache(20*time.Millisecond, path, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if _, err := first.CheckAndMark("k", time.Now()); err != nil {
		t.Fatalf("mark: %v", err)
	}
	// Let the marker lapse, then "restart": the expired marker must not
	// block a fresh delivery.
	time.Sleep(40 * time.Millisecond)
	second, err := LoadReplayCache(time.Second, path, nil)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if second.Len() != 0 {
		t.Fatalf("expired markers should be dropped on load, Len = %d", second.Len())
	}
	if fresh, _ := second.CheckAndMark("k", time.Now()); !fresh {
		t.Fatal("delivery whose marker expired before restart should be accepted")
	}
}

func TestReplayCachePersistenceMissingFileIsFine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "never", "written.jsonl")
	c, err := LoadReplayCache(time.Minute, path, nil)
	if err != nil {
		t.Fatalf("missing persist file must not fail load: %v", err)
	}
	if c.Len() != 0 {
		t.Fatalf("Len = %d, want 0", c.Len())
	}
}

func TestReplayCachePersistenceCorruptFileFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "markers.jsonl")
	if err := os.WriteFile(path, []byte("{\"key\":\"ok\",\"expiry\":\""+time.Now().Add(time.Hour).Format(time.RFC3339Nano)+"\"}\nNOT-JSON\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadReplayCache(time.Minute, path, nil); err == nil {
		t.Fatal("corrupt persist file must fail load (fail-closed)")
	} else if !strings.Contains(err.Error(), "corrupt marker") {
		t.Fatalf("error should identify the corrupt marker, got: %v", err)
	}
}

func TestReplayCacheEvictionCompactsPersistFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "markers.jsonl")
	now := time.Now()
	c, err := LoadReplayCache(50*time.Millisecond, path, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	c.CheckAndMark("old", now)
	time.Sleep(60 * time.Millisecond)
	c.CheckAndMark("fresh", time.Now())
	if removed := c.evict(time.Now()); removed != 1 {
		t.Fatalf("evict removed %d, want 1", removed)
	}

	// After compaction the file contains only the live marker.
	reloaded, err := LoadReplayCache(time.Minute, path, nil)
	if err != nil {
		t.Fatalf("reload after compaction: %v", err)
	}
	if reloaded.Len() != 1 {
		t.Fatalf("compacted file should hold 1 marker, got %d", reloaded.Len())
	}
	if fresh, _ := reloaded.CheckAndMark("fresh", time.Now()); fresh {
		t.Fatal("live marker must survive compaction")
	}
}
