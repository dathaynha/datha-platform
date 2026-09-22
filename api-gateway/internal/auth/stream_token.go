package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// streamClaims is the payload for short-lived stream tokens.
// sub  = owner_id (e.g. "google_<sub>")
// jti  = job_id   (checked against the URL path parameter to prevent token reuse across jobs)
type streamClaims struct {
	jwt.RegisteredClaims
}

// SignStreamToken creates a short-lived HS256 JWT that authorises GET /stream/{jobID}.
// The token is scoped to a single job — it cannot be reused for any other endpoint or job.
func SignStreamToken(jobID, ownerID, secret string, ttlSeconds int) (string, error) {
	now := time.Now()
	claims := streamClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   ownerID,
			ID:        jobID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(ttlSeconds) * time.Second)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		return "", fmt.Errorf("sign stream token: %w", err)
	}
	return signed, nil
}

// VerifyStreamToken validates a stream token and confirms it was issued for expectedJobID.
// Returns the owner_id (sub claim) on success.
func VerifyStreamToken(tokenString, expectedJobID, secret string) (ownerID string, err error) {
	token, err := jwt.ParseWithClaims(tokenString, &streamClaims{}, hmacKeyFunc(secret))
	if err != nil {
		return "", fmt.Errorf("parse stream token: %w", err)
	}

	claims, ok := token.Claims.(*streamClaims)
	if !ok || !token.Valid {
		return "", fmt.Errorf("invalid stream token claims")
	}
	if claims.ID != expectedJobID {
		return "", fmt.Errorf("stream token job_id mismatch: got %q, expected %q", claims.ID, expectedJobID)
	}

	return claims.Subject, nil
}
