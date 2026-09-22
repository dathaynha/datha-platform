// Package config loads realtime-service settings from the environment.
package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds realtime-service settings loaded from the environment.
type Config struct {
	Port                string
	RedisURL            string
	NATSURL             string
	MessengerServiceURL string // membership checks when a client opens a conversation
	TURNStaticSecret    string // coturn use-auth-secret shared secret; never leaves this process
	// Fixed credentials for a hosted relay that does not speak the REST/HMAC
	// scheme. Set both and they replace the signed credential entirely.
	TURNUsername           string
	TURNPassword           string
	TURNURLs               []string
	STUNURLs               []string
	TURNCredentialTTL      time.Duration
	CallRingTimeout        time.Duration // unanswered invite → call.missed
	CallTTL                time.Duration // ceiling on live call state in Redis
	MaxCallParticipants    int           // mesh ceiling: N-1 connections and N-1 uplinks per peer
	MaxConnectionsPerOwner int
	PresenceTTL            time.Duration
	PresenceHeartbeat      time.Duration
	TypingTTL              time.Duration
	PingInterval           time.Duration
	// InstanceID identifies this process in Redis, so calls stranded by a crash
	// can be told from calls somebody is still sitting in. Defaults to the
	// hostname, which is the pod name under Kubernetes.
	InstanceID        string
	InstanceHeartbeat time.Duration // how often the liveness key is re-armed
	InstanceTTL       time.Duration // how long it survives without a beat
	CallReapInterval  time.Duration // how often orphaned calls are swept up
}

// Load reads configuration from the environment, applying the defaults the
// architecture doc fixes. Nothing here is secret except TURNStaticSecret, which
// is only ever used to sign credentials — it is never logged or sent to a client.
func Load() *Config {
	cfg := &Config{
		Port:                   envOr("PORT", "3004"),
		RedisURL:               envOr("REDIS_URL", "redis://localhost:6379"),
		NATSURL:                envOr("NATS_URL", "nats://localhost:4222"),
		MessengerServiceURL:    strings.TrimSpace(os.Getenv("MESSENGER_SERVICE_URL")),
		TURNStaticSecret:       strings.TrimSpace(os.Getenv("TURN_STATIC_SECRET")),
		TURNUsername:           strings.TrimSpace(os.Getenv("TURN_USERNAME")),
		TURNPassword:           strings.TrimSpace(os.Getenv("TURN_PASSWORD")),
		TURNURLs:               csv(os.Getenv("TURN_URLS")),
		STUNURLs:               csv(envOr("STUN_URLS", "stun:stun.l.google.com:19302")),
		TURNCredentialTTL:      secondsOr("TURN_CREDENTIAL_TTL_SECONDS", 300),
		CallRingTimeout:        secondsOr("CALL_RING_TIMEOUT_SECONDS", 30),
		CallTTL:                secondsOr("CALL_TTL_SECONDS", 4*60*60),
		MaxCallParticipants:    intOr("MAX_CALL_PARTICIPANTS", 4),
		MaxConnectionsPerOwner: intOr("WS_MAX_CONNECTIONS_PER_OWNER", 5),
		PresenceTTL:            secondsOr("PRESENCE_TTL_SECONDS", 45),
		PresenceHeartbeat:      secondsOr("PRESENCE_HEARTBEAT_SECONDS", 15),
		TypingTTL:              secondsOr("TYPING_TTL_SECONDS", 8),
		PingInterval:           secondsOr("WS_PING_INTERVAL_SECONDS", 25),
		InstanceID:             envOr("INSTANCE_ID", hostnameOr("realtime")),
		InstanceHeartbeat:      secondsOr("INSTANCE_HEARTBEAT_SECONDS", 10),
		// Several beats, deliberately: a missed beat under load must not
		// declare a healthy instance dead and tear down live calls. Being slow
		// to reap is harmless; reaping a live call is not.
		InstanceTTL:      secondsOr("INSTANCE_TTL_SECONDS", 45),
		CallReapInterval: secondsOr("CALL_REAP_INTERVAL_SECONDS", 60),
	}

	if cfg.MessengerServiceURL == "" {
		// Only conversation-scoped features (typing, call invites) need it; the
		// socket, the owner fanout and presence all work without it.
		slog.Warn("MESSENGER_SERVICE_URL is unset; conversation.open and call.invite will be refused")
	}

	// Half-configured TURN is treated as no TURN, and said out loud here rather
	// than discovered when a call fails to relay. STUN-only works on one
	// network and fails behind symmetric NAT.
	staticPair := cfg.TURNUsername != "" && cfg.TURNPassword != ""
	switch {
	case cfg.TURNUsername != "" && cfg.TURNPassword == "":
		slog.Warn("TURN_USERNAME is set but TURN_PASSWORD is empty; ignoring both")
	case cfg.TURNPassword != "" && cfg.TURNUsername == "":
		slog.Warn("TURN_PASSWORD is set but TURN_USERNAME is empty; ignoring both")
	}
	switch {
	case len(cfg.TURNURLs) == 0 && cfg.TURNStaticSecret == "" && !staticPair:
		slog.Warn("TURN is not configured; ICE will be served with STUN only")
	case len(cfg.TURNURLs) == 0:
		slog.Warn("TURN credentials are set but TURN_URLS is empty; serving STUN only")
	case staticPair:
		// Said out loud every boot: a fixed credential reaches the browser and
		// stays valid, which is what the signed scheme exists to avoid. Fine
		// for a public relay that requires it, never for our own coturn.
		slog.Warn("TURN is using fixed credentials; TURN_STATIC_SECRET is ignored")
	case cfg.TURNStaticSecret == "":
		slog.Warn("TURN_URLS is set but no TURN credentials are configured; serving STUN only")
	}
	return cfg
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func intOr(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
		slog.Warn("ignoring invalid value; using default", "key", key, "default", fallback)
	}
	return fallback
}

func secondsOr(key string, fallback int) time.Duration {
	return time.Duration(intOr(key, fallback)) * time.Second
}

func csv(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// hostnameOr names this process, falling back when the hostname is unavailable.
// Under Kubernetes the hostname is the pod name, which is exactly the identity
// wanted: it changes when the process is replaced.
func hostnameOr(fallback string) string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return fallback
	}
	return name
}
