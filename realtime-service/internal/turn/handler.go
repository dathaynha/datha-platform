package turn

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"datha-platform/realtime-service/internal/metrics"
)

// Handler serves GET /turn-credentials.
//
// Identity is the gateway-injected X-Owner-ID and nothing else, exactly like
// the socket: this service holds no JWT code. The gateway keeps the route
// behind the platform JWT, so an unauthenticated caller never arrives here.
func Handler(issuer *Issuer, m *metrics.Metrics) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ownerID := r.Header.Get("X-Owner-ID")
		if ownerID == "" {
			m.TURNCredentials.WithLabelValues("unauthorized").Inc()
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Missing X-Owner-ID header"})
			return
		}

		creds, err := issuer.Issue(ownerID)
		if err != nil {
			m.TURNCredentials.WithLabelValues("error").Inc()
			slog.Error("issue turn credentials", "owner", ownerID, "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
			return
		}

		outcome := "stun_only"
		if creds.Relay {
			outcome = "ok"
		}
		m.TURNCredentials.WithLabelValues(outcome).Inc()

		// Credentials are per-owner and expire in minutes; a cache anywhere on
		// the path would hand one owner's grant to another.
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"data": creds})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("turn credentials response encode failed", "error", err)
	}
}
