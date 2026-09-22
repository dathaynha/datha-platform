package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

const correlationIDHeader = "X-Correlation-ID"

type contextKey string

const correlationIDKey contextKey = "correlationID"

// Correlation attaches a correlation ID to every request.
// It reads X-Correlation-ID from the incoming header; if absent, generates a new UUID.
// The ID is stored in the request context and written to the response header.
func Correlation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(correlationIDHeader)
		if id == "" {
			id = uuid.NewString()
		}

		ctx := context.WithValue(r.Context(), correlationIDKey, id)
		w.Header().Set(correlationIDHeader, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// CorrelationIDFromContext retrieves the correlation ID stored by the Correlation middleware.
func CorrelationIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(correlationIDKey).(string); ok {
		return id
	}
	return ""
}
