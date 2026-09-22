package auth

import (
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

func hmacKeyFunc(secret string) jwt.Keyfunc {
	return func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	}
}
