// Command realtime is the platform WebSocket service: presence, typing, live
// message fanout and (phase 2) WebRTC signaling. It wires dependencies and
// starts the server; all logic lives in internal packages.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"
	"github.com/nats-io/nats.go"

	"datha-platform/realtime-service/internal/calls"
	"datha-platform/realtime-service/internal/chatauth"
	"datha-platform/realtime-service/internal/config"
	"datha-platform/realtime-service/internal/events"
	"datha-platform/realtime-service/internal/hub"
	"datha-platform/realtime-service/internal/kv"
	"datha-platform/realtime-service/internal/logging"
	"datha-platform/realtime-service/internal/metrics"
	"datha-platform/realtime-service/internal/presence"
	"datha-platform/realtime-service/internal/turn"
	"datha-platform/realtime-service/internal/wsapi"
)

func main() {
	if err := run(); err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
}

// run owns every deferred cleanup, so a startup failure returns an error rather
// than calling os.Exit past a pending defer — which would skip the log flush,
// the Redis close and the NATS drain.
func run() error {
	_ = godotenv.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownLogs := logging.Setup(ctx)
	defer func() {
		if err := shutdownLogs(context.Background()); err != nil {
			slog.Warn("log shutdown failed", "error", err)
		}
	}()

	cfg := config.Load()

	store, err := kv.NewRedis(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("redis config invalid: %w", err)
	}
	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	if err := store.Ping(pingCtx); err != nil {
		return fmt.Errorf("redis unreachable: %w", err)
	}
	defer func() { _ = store.Close() }()

	// Reconnect forever: the default gives up after ~2 minutes, which would
	// leave a live socket service holding sockets it can no longer feed.
	nc, err := nats.Connect(cfg.NATSURL, nats.MaxReconnects(-1), nats.ReconnectWait(2*time.Second))
	if err != nil {
		return fmt.Errorf("nats unreachable: %w", err)
	}
	defer func() { _ = nc.Drain() }()

	// JetStream carries the durable record of a call. Its absence is tolerated
	// the same way api-gateway tolerates it: the live path keeps working and
	// only history is lost, so a broker hiccup never drops a call in progress.
	var publisher *events.Publisher
	if js, err := nc.JetStream(); err != nil {
		slog.Warn("JetStream unavailable; call history events will not be published", "error", err)
	} else {
		publisher = events.NewPublisher(js)
	}

	m := metrics.New()
	h := hub.New(hub.NewNATSBus(nc), cfg.MaxConnectionsPerOwner)
	tracker := presence.NewTracker(store, cfg.PresenceTTL)
	chat := chatauth.NewCachingChecker(
		chatauth.NewHTTPChecker(cfg.MessengerServiceURL, 3*time.Second),
		30*time.Second,
	)
	registry := calls.NewRegistry(
		store, cfg.CallRingTimeout+15*time.Second, cfg.CallTTL, cfg.MaxCallParticipants,
	).WithInstance(cfg.InstanceID)
	socket := wsapi.NewServer(h, tracker, chat, registry, publisher, m, wsapi.Timings{
		Ping:              cfg.PingInterval,
		PresenceHeartbeat: cfg.PresenceHeartbeat,
		Typing:            cfg.TypingTTL,
		CallRing:          cfg.CallRingTimeout,
	})
	/*
	 * Liveness, and then the sweep that depends on it.
	 *
	 * A call is normally closed by the socket that was in it dropping — which
	 * is no use when the *process* is what died, because that walk lives in
	 * process memory. The heartbeat makes "is the instance behind this member
	 * still alive" answerable from Redis, and the reaper turns a yes/no into a
	 * properly announced `call.ended` instead of a record that expires in
	 * silence and leaves the projection saying a call is still running.
	 */
	if err := calls.Heartbeat(
		ctx, store, cfg.InstanceID, cfg.InstanceHeartbeat, cfg.InstanceTTL,
	); err != nil {
		return fmt.Errorf("instance heartbeat: %w", err)
	}
	socket.StartReaper(ctx, cfg.CallReapInterval)

	issuer := turn.NewIssuer(
		cfg.TURNStaticSecret,
		cfg.TURNUsername,
		cfg.TURNPassword,
		cfg.TURNURLs,
		cfg.STUNURLs,
		cfg.TURNCredentialTTL,
	)

	router := chi.NewRouter()
	router.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	router.Handle("/metrics", m.Handler())
	router.Get("/ws", socket.Handle)
	router.Get("/turn-credentials", turn.Handler(issuer, m))

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: router,
		// No read timeout: a hijacked WebSocket lives for hours between frames,
		// and a ReadTimeout here would kill idle-but-healthy sockets.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("realtime-service listening", "port", cfg.Port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Warn("graceful shutdown failed", "error", err)
	}
	return nil
}
