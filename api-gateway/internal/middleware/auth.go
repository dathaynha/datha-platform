package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"chatbot-playground/api-gateway/internal/auth"
)

type claimsKey string
type ownerKey string

const (
	userClaimsKey    claimsKey = "userClaims"
	ownerOverrideKey ownerKey  = "ownerOverride"
)

// Authenticate validates the internal JWT from the Authorization: Bearer header.
// Rejects with 401 if the token is missing or invalid.
func Authenticate(jwtSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				writeUnauthorized(w, "missing or malformed Authorization header")
				return
			}

			tokenString := strings.TrimPrefix(header, "Bearer ")
			claims, err := auth.VerifyToken(tokenString, jwtSecret)
			if err != nil {
				writeUnauthorized(w, "invalid or expired token")
				return
			}

			ctx := context.WithValue(r.Context(), userClaimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromContext retrieves the validated JWT claims stored by Authenticate.
func ClaimsFromContext(ctx context.Context) *auth.Claims {
	if c, ok := ctx.Value(userClaimsKey).(*auth.Claims); ok {
		return c
	}
	return nil
}

// WithOwnerID stores a pre-verified owner_id in the context.
// Used by the stream handler, which validates a stream_token instead of a Bearer JWT.
func WithOwnerID(ctx context.Context, ownerID string) context.Context {
	return context.WithValue(ctx, ownerOverrideKey, ownerID)
}

// OwnerIDFromContext returns the owner_id injected by WithOwnerID (stream routes).
func OwnerIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ownerOverrideKey).(string); ok {
		return v
	}
	return ""
}

func writeUnauthorized(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
