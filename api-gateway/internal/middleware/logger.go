package middleware

import (
	"log/slog"
	"net/http"
	"time"
)

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (r *responseRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Flush forwards flushing — without it SSE responses stall in the server's
// write buffer (the embedded interface hides the underlying Flusher).
func (r *responseRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Logger logs each request with method, path, status, duration, and correlation ID.
// /metrics is skipped — Prometheus scrapes every 15s and would drown real traffic.
func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()
		rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"correlation_id", CorrelationIDFromContext(r.Context()),
			"remote_addr", r.RemoteAddr,
		)
	})
}
