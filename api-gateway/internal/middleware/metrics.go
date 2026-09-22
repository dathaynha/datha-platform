package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	requestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "gateway_http_requests_total",
		Help: "Total HTTP requests handled by the gateway.",
	}, []string{"code", "method", "route"})

	requestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "gateway_http_request_duration_seconds",
		Help:    "HTTP request duration in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"code", "method", "route"})
)

// Metrics records RED metrics per request. The route label uses the chi route
// pattern (not the raw path) to keep label cardinality bounded.
func Metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" || r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()
		rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		code := strconv.Itoa(rec.status)
		requestsTotal.WithLabelValues(code, r.Method, route).Inc()
		requestDuration.WithLabelValues(code, r.Method, route).Observe(time.Since(start).Seconds())
	})
}
