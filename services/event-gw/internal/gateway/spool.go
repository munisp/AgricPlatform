package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Spool is an on-disk JSONL dead-letter store for events that could not be
// fanned out to the API ingress. A background drain loop re-delivers entries
// once the circuit breaker closes. All methods are safe for concurrent use;
// a single process is assumed to own the file.
type Spool struct {
	mu   sync.Mutex
	path string
}

func NewSpool(path string) *Spool {
	return &Spool{path: path}
}

// Path is visible for diagnostics.
func (s *Spool) Path() string { return s.path }

// Append writes one envelope as a JSON line, creating parent directories.
func (s *Spool) Append(env Envelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if dir := filepath.Dir(s.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("spool mkdir: %w", err)
		}
	}
	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("spool open: %w", err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(env); err != nil {
		return fmt.Errorf("spool encode: %w", err)
	}
	return nil
}

// Backlog counts undelivered entries. A missing spool file means 0.
func (s *Spool) Backlog() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if err != nil {
		return 0
	}
	return countLines(data)
}

func countLines(data []byte) int {
	n := 0
	for _, line := range bytes.Split(data, []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 {
			n++
		}
	}
	return n
}

// DrainStats reports the outcome of a drain pass.
type DrainStats struct {
	Sent       int  // entries successfully re-delivered
	SendFailed bool // stopped early because the receiver failed a send
	Poison     int  // malformed lines found (rotated to the end, never silently dropped)
}

// Drain attempts to re-deliver every spooled entry via send, in file order.
// It stops at the first send failure and keeps that entry plus the rest for
// the next pass. Malformed ("poison") lines are rotated to the end of the
// file so valid entries behind them can still drain; they are never deleted.
// A fully drained spool file is removed. The returned error is for I/O
// failures only.
func (s *Spool) Drain(send func(Envelope) error) (DrainStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var stats DrainStats
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return stats, nil
	}
	if err != nil {
		return stats, fmt.Errorf("spool read: %w", err)
	}
	var lines [][]byte
	for _, line := range bytes.Split(data, []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 {
			lines = append(lines, line)
		}
	}
	var remaining [][]byte
	for i, line := range lines {
		var env Envelope
		if err := json.Unmarshal(line, &env); err != nil {
			stats.Poison++
			remaining = append(remaining, line)
			continue
		}
		if err := send(env); err != nil {
			stats.SendFailed = true
			remaining = append(remaining, lines[i:]...)
			break
		}
		stats.Sent++
	}
	if len(remaining) == 0 {
		if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
			return stats, fmt.Errorf("spool remove: %w", err)
		}
		return stats, nil
	}
	var buf bytes.Buffer
	for _, line := range remaining {
		buf.Write(line)
		buf.WriteByte('\n')
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o640); err != nil {
		return stats, fmt.Errorf("spool rewrite: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return stats, fmt.Errorf("spool rename: %w", err)
	}
	return stats, nil
}
