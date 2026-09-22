// Package metrics holds the Prometheus collectors for realtime-service.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics is the service's collector set. Names match
// services/realtime-service-architecture.md § Metrics.
type Metrics struct {
	registry *prometheus.Registry

	Connections   prometheus.Gauge
	Frames        *prometheus.CounterVec // type, direction
	PresenceBeats *prometheus.CounterVec // outcome
	TypingRelay   *prometheus.CounterVec // outcome
	OpenRequests  *prometheus.CounterVec // outcome

	SignalingRelay *prometheus.CounterVec // outcome
	CallSetup      *prometheus.CounterVec // outcome
	ICEFailures    prometheus.Counter
	// CallsReaped counts calls ended because no instance was still holding
	// them. Steady zero is healthy; a rising line means instances are dying
	// mid-call, which is the fact worth alerting on — the calls themselves are
	// already being cleaned up.
	CallsReaped     prometheus.Counter
	TURNCredentials *prometheus.CounterVec // outcome
	RateLimited     *prometheus.CounterVec // bucket, type
}

// New builds the collectors on a private registry, so nothing leaks in from
// other packages' default registrations.
func New() *Metrics {
	registry := prometheus.NewRegistry()
	registry.MustRegister(collectors.NewGoCollector())

	m := &Metrics{
		registry: registry,
		Connections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "realtime_service_ws_connections",
			Help: "Open WebSocket connections held by this instance.",
		}),
		Frames: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_ws_frames_total",
			Help: "WebSocket frames, by type and direction.",
		}, []string{"type", "direction"}),
		PresenceBeats: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_presence_beats_total",
			Help: "Presence heartbeats written to Redis, by outcome.",
		}, []string{"outcome"}),
		TypingRelay: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_typing_relay_total",
			Help: "Typing frames relayed, by outcome.",
		}, []string{"outcome"}),
		OpenRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_conversation_open_total",
			Help: "conversation.open authorization results, by outcome.",
		}, []string{"outcome"}),
		SignalingRelay: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_signaling_relay_total",
			Help: "WebRTC signaling frames relayed, by outcome.",
		}, []string{"outcome"}),
		CallSetup: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_call_setup_total",
			Help: "Call outcomes: connected, failed, timeout, declined.",
		}, []string{"outcome"}),
		// Reported by the client via call.hangup{reason:"ice_failed"} — the
		// server relays opaque candidates and cannot observe an ICE failure.
		CallsReaped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "realtime_service_calls_reaped_total",
			Help: "Calls ended because every member's instance had stopped heartbeating.",
		}),
		ICEFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "realtime_service_ice_failures_total",
			Help: "Calls a client reported as failed at ICE.",
		}),
		TURNCredentials: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_turn_credentials_issued_total",
			Help: "TURN credential requests, by outcome (ok, stun_only, error).",
		}, []string{"outcome"}),
		RateLimited: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "realtime_service_frames_rate_limited_total",
			Help: "Inbound frames refused by a per-connection rate limit, by bucket and frame type.",
		}, []string{"bucket", "type"}),
	}

	registry.MustRegister(
		m.Connections, m.Frames, m.PresenceBeats, m.TypingRelay, m.OpenRequests,
		m.SignalingRelay, m.CallSetup, m.ICEFailures, m.CallsReaped,
		m.TURNCredentials, m.RateLimited,
	)
	return m
}

// Handler exposes /metrics for Prometheus (platform-observability, target :3004).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Directions for the frames counter.
const (
	DirectionIn  = "in"
	DirectionOut = "out"
)
