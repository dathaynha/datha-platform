package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const googleTokenURL = "https://oauth2.googleapis.com/token"

// GoogleTokenResponse mirrors the JSON body Google returns from its token endpoint.
type GoogleTokenResponse struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
}

// GoogleIDClaims holds the fields we care about from Google's ID token payload.
type GoogleIDClaims struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

// ExchangeCode forwards an authorization-code token request to Google,
// injecting the client_secret server-side. Returns Google's raw token response.
func ExchangeCode(ctx context.Context, clientID, clientSecret string, formBody url.Values) (*GoogleTokenResponse, error) {
	formBody.Set("client_secret", clientSecret)
	if clientID != "" {
		// Overwrite only if the client sent a mismatched ID; otherwise trust what they sent.
		if sent := formBody.Get("client_id"); sent != "" && sent != clientID {
			return nil, fmt.Errorf("client_id mismatch: got %q, expected %q", sent, clientID)
		}
		formBody.Set("client_id", clientID)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenURL,
		strings.NewReader(formBody.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build google request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("google token exchange: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read google response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google returned %d", resp.StatusCode)
	}

	var tokenResp GoogleTokenResponse
	if err := json.Unmarshal(raw, &tokenResp); err != nil {
		return nil, fmt.Errorf("parse google token response: %w", err)
	}

	return &tokenResp, nil
}

// ParseIDTokenClaims decodes the payload of a Google ID token without verifying
// the signature. This is safe here because the token was just received directly
// from Google's token endpoint over TLS — we did not get it from an untrusted source.
func ParseIDTokenClaims(idToken string) (*GoogleIDClaims, error) {
	var claims GoogleIDClaims
	if err := decodeIDTokenPayload(idToken, &claims); err != nil {
		return nil, err
	}

	if claims.Sub == "" {
		return nil, fmt.Errorf("id_token missing 'sub' claim")
	}

	return &claims, nil
}
