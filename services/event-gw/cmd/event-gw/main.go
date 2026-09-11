// Command event-gw is the AgricPlatform webhook/event ingestion edge.
// It receives EXTERNAL provider webhooks (weather alerts, payment callbacks,
// satellite-imagery notifications, partner API events), verifies their
// authenticity (fail-closed: EVENTGW_MODE=live verifies, the default stub
// mode says loudly that it does not), and fans them out to the API's
// internal event ingress with retries, a circuit breaker, and a disk spool.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/munisp/AgricPlatform/services/event-gw/internal/gateway"
)

func main() {
	logger := log.New(os.Stdout, "event-gw ", log.LstdFlags|log.LUTC|log.Lmsgprefix)

	cfg, msgs, err := gateway.LoadConfig(os.Getenv)
	if err != nil {
		logger.Printf("CONFIGURATION ERROR: %v", err)
		os.Exit(1)
	}

	// Self-probe mode for container HEALTHCHECK in distroless images (no
	// shell, no wget): `event-gw -healthcheck` GETs /healthz on the
	// configured address and exits 0 only on HTTP 200.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck(cfg.Addr))
	}
	for _, m := range msgs {
		logger.Println(m)
	}

	metrics := gateway.NewMetrics(cfg.ProviderOrder)
	breaker := gateway.NewBreaker(cfg.BreakerThreshold, cfg.BreakerCooldown)
	spool := gateway.NewSpool(cfg.SpoolPath)
	fanout := gateway.NewFanout(cfg, breaker, spool, metrics, logger)
	srv := gateway.NewServer(cfg, fanout, metrics, logger)

	// OpenTelemetry: no-op-safe (never fatal, collector may be absent).
	telemetry := gateway.InitTelemetry(context.Background(), gateway.LoadTelemetryConfig(os.Getenv), logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv.StartBackground(ctx)

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.RoutesWithTelemetry(telemetry),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpSrv.ListenAndServe()
	}()

	logger.Printf("listening on %s mode=%s providers=[%s] ingress=%s spool=%s",
		cfg.Addr, cfg.Mode, strings.Join(cfg.ProviderOrder, ","), cfg.IngressURL, cfg.SpoolPath)

	select {
	case <-ctx.Done():
		logger.Println("shutdown signal received; draining HTTP")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			logger.Printf("ERROR: graceful shutdown failed: %v", err)
			os.Exit(1)
		}
		if err := telemetry.Shutdown(shutdownCtx); err != nil {
			logger.Printf("WARNING: OpenTelemetry flush on shutdown failed: %v", err)
		}
		logger.Println("stopped")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Printf("ERROR: HTTP server failed: %v", err)
			os.Exit(1)
		}
	}
}

// healthcheck probes our own /healthz endpoint. addr may be ":8090" or
// "0.0.0.0:8090"; the probe always targets loopback.
func healthcheck(addr string) int {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: bad EVENTGW_ADDR %q: %v\n", addr, err)
		return 1
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck: status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}
