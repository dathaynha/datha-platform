package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

func decodeIDTokenPayload(idToken string, dest any) error {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return fmt.Errorf("id_token has %d parts, expected 3", len(parts))
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("decode id_token payload: %w", err)
	}

	if err := json.Unmarshal(payload, dest); err != nil {
		return fmt.Errorf("parse id_token claims: %w", err)
	}

	return nil
}
