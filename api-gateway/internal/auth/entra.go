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

// EntraTokenResponse mirrors the JSON body Entra returns from its token endpoint.
type EntraTokenResponse struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
}

// EntraIDClaims holds the fields we care about from an Entra ID token payload.
type EntraIDClaims struct {
	// oid is the stable, immutable object ID for the user across the tenant.
	// We prefer this over sub, which can change across app registrations.
	OID               string `json:"oid"`
	TID               string `json:"tid"` // Directory tenant issuing the token; used for gateway allowlisting.
	PreferredUsername string `json:"preferred_username"`
	Name              string `json:"name"`
}

// EntraLoginPool selects which Entra authority segment was used for sign-in ("work/school"
// vs consumer Microsoft accounts). It must align with issuer + token endpoint.
const (
	EntraPoolOrganizations = "organizations"
	EntraPoolConsumers     = "consumers"
)

// EntraTokenURLForLoginPool returns the v2 OAuth token endpoint for the given login pool.
func EntraTokenURLForLoginPool(pool string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(pool)) {
	case "", EntraPoolOrganizations:
		return "https://login.microsoftonline.com/organizations/oauth2/v2.0/token", nil
	case EntraPoolConsumers:
		return "https://login.microsoftonline.com/consumers/oauth2/v2.0/token", nil
	default:
		return "", fmt.Errorf("invalid login pool")
	}
}

// ExchangeEntraCode forwards a PKCE or refresh_token request to Entra at tokenURL.
// No client_secret is added because the SPA app registration uses PKCE only.
//
// origin must be the browser Origin header from the incoming Angular request
// (e.g. "http://localhost:4001"). Azure SPA registrations enforce that auth codes
// are redeemed via cross-origin requests — without an Origin header the call is
// treated as a same-origin server request and rejected with AADSTS9002327.
func ExchangeEntraCode(ctx context.Context, tokenURL, origin string, formBody url.Values) (*EntraTokenResponse, error) {

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL,
		strings.NewReader(formBody.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build entra request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("entra token exchange: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read entra response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("entra returned %d: %s", resp.StatusCode, string(raw))
	}

	var tokenResp EntraTokenResponse
	if err := json.Unmarshal(raw, &tokenResp); err != nil {
		return nil, fmt.Errorf("parse entra token response: %w", err)
	}

	return &tokenResp, nil
}

// ParseEntraIDTokenClaims decodes the payload of an Entra ID token without verifying
// the signature. This is safe because the token was just received directly from
// Entra's token endpoint over TLS — it has not passed through an untrusted source.
func ParseEntraIDTokenClaims(idToken string) (*EntraIDClaims, error) {
	var claims EntraIDClaims
	if err := decodeIDTokenPayload(idToken, &claims); err != nil {
		return nil, err
	}

	if claims.OID == "" {
		return nil, fmt.Errorf("entra id_token missing 'oid' claim")
	}
	if claims.TID == "" {
		return nil, fmt.Errorf("entra id_token missing 'tid' claim")
	}

	return &claims, nil
}
