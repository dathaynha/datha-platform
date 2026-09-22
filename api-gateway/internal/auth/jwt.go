package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ExternalUser is the provider-agnostic identity extracted from any IdP.
// OwnerID must be prefixed: "google_<sub>" or "entra_<oid>".
type ExternalUser struct {
	OwnerID string
	Email   string
	Name    string
	Picture string
}

// Claims is the payload we embed in every internal JWT.
type Claims struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	Picture string `json:"picture"`
	jwt.RegisteredClaims
}

// IssueToken creates and signs a new internal JWT for the given external user.
// The JWT Subject is set to ExternalUser.OwnerID (e.g. "google_<sub>", "entra_<oid>").
func IssueToken(user *ExternalUser, secret string, ttlSeconds int) (string, error) {
	now := time.Now()
	claims := Claims{
		Email:   user.Email,
		Name:    user.Name,
		Picture: user.Picture,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.OwnerID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(ttlSeconds) * time.Second)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		return "", fmt.Errorf("sign JWT: %w", err)
	}

	return signed, nil
}

// VerifyToken parses and validates an internal JWT, returning its claims.
func VerifyToken(tokenString, secret string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, hmacKeyFunc(secret))
	if err != nil {
		return nil, fmt.Errorf("parse JWT: %w", err)
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid JWT claims")
	}

	return claims, nil
}
