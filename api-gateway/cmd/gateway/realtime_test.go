package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/go-chi/chi/v5"

	"chatbot-playground/api-gateway/internal/auth"
	"chatbot-playground/api-gateway/internal/config"
	"chatbot-playground/api-gateway/internal/middleware"
	"chatbot-playground/api-gateway/internal/proxy"
)

func realtimeConfig() *config.Config {
	return &config.Config{
		JWTSecret:                testSecret,
		JWTTTLSeconds:            3600,
		RealtimeStreamTTLSeconds: 90,
		CORSOrigins:              []string{"http://localhost:4000", "http://localhost:4003"},
	}
}

func TestRealtimeStreamTokenIsScopedAndShortLived(t *testing.T) {
	cfg := realtimeConfig()
	jwt, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_1"}, testSecret, 3600)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}

	handler := middleware.Authenticate(testSecret)(realtimeStreamTokenHandler(cfg))
	req := httptest.NewRequest(http.MethodGet, "/api/realtime/token", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		StreamToken string `json:"stream_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// A WebSocket token rides in a query string, so its life must be far
	// shorter than the SPA JWT's hour.
	if body.ExpiresIn != 90 {
		t.Fatalf("expires_in = %d, want 90", body.ExpiresIn)
	}
	if body.ExpiresIn >= cfg.JWTTTLSeconds {
		t.Fatalf("stream token TTL %d must be shorter than the JWT TTL %d", body.ExpiresIn, cfg.JWTTTLSeconds)
	}

	ownerID, err := auth.VerifyStreamToken(body.StreamToken, realtimeStreamScope, testSecret)
	if err != nil {
		t.Fatalf("token does not verify for the realtime scope: %v", err)
	}
	if ownerID != "google_1" {
		t.Fatalf("owner = %q", ownerID)
	}
	// Scope isolation: the same token must not open the notification stream.
	if _, err := auth.VerifyStreamToken(body.StreamToken, notificationStreamScope, testSecret); err == nil {
		t.Fatal("a realtime token must not authorise the notification stream")
	}
}

func TestRealtimeStreamTokenRequiresAJWT(t *testing.T) {
	handler := middleware.Authenticate(testSecret)(realtimeStreamTokenHandler(realtimeConfig()))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/realtime/token", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestOriginAllowed(t *testing.T) {
	allowed := []string{"http://localhost:4000", " http://localhost:4003 "}

	cases := []struct {
		origin string
		want   bool
		why    string
	}{
		{"http://localhost:4000", true, "allowlisted shell origin"},
		{"http://localhost:4003", true, "allowlisted remote origin, trimmed in config"},
		{"HTTP://LOCALHOST:4000", true, "origin comparison is case-insensitive"},
		{"https://evil.example.com", false, "an upgrade gets no preflight, so this is the only guard"},
		{"http://localhost:4999", false, "not on the allowlist"},
		{"", true, "no Origin means a non-browser client; browsers always send one"},
	}
	for _, c := range cases {
		if got := originAllowed(c.origin, allowed); got != c.want {
			t.Errorf("originAllowed(%q) = %v, want %v — %s", c.origin, got, c.want, c.why)
		}
	}
}

func TestRealtimeSocketRejectsDisallowedOrigin(t *testing.T) {
	upstreamCalled := false
	upstream := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { upstreamCalled = true })

	token, err := auth.SignStreamToken(realtimeStreamScope, "google_1", testSecret, 90)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/realtime/ws?stream_token="+url.QueryEscape(token), nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rec := httptest.NewRecorder()

	realtimeSocketHandler(realtimeConfig(), upstream)(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if upstreamCalled {
		t.Fatal("a disallowed origin must never reach realtime-service, valid token or not")
	}
}

func TestRealtimeSocketRequiresAToken(t *testing.T) {
	upstream := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("upstream must not be reached without a token")
	})
	req := httptest.NewRequest(http.MethodGet, "/api/realtime/ws", nil)
	req.Header.Set("Origin", "http://localhost:4000")
	rec := httptest.NewRecorder()

	realtimeSocketHandler(realtimeConfig(), upstream)(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRealtimeSocketRejectsAForeignScopeToken(t *testing.T) {
	// A notification stream token must not open the socket, or one scope's
	// leak becomes every scope's leak.
	token, err := auth.SignStreamToken(notificationStreamScope, "google_1", testSecret, 90)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	upstream := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("upstream must not be reached with a foreign-scope token")
	})
	req := httptest.NewRequest(http.MethodGet, "/api/realtime/ws?stream_token="+url.QueryEscape(token), nil)
	req.Header.Set("Origin", "http://localhost:4000")
	rec := httptest.NewRecorder()

	realtimeSocketHandler(realtimeConfig(), upstream)(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRealtimeSocketStripsTokenAndInjectsOwner(t *testing.T) {
	var gotQuery, gotOwner string
	upstream := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		gotOwner = middleware.OwnerIDFromContext(r.Context())
	})

	token, err := auth.SignStreamToken(realtimeStreamScope, "google_1", testSecret, 90)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet,
		"/api/realtime/ws?stream_token="+url.QueryEscape(token)+"&tab=2", nil)
	req.Header.Set("Origin", "http://localhost:4000")
	rec := httptest.NewRecorder()

	realtimeSocketHandler(realtimeConfig(), upstream)(rec, req)

	if gotOwner != "google_1" {
		t.Fatalf("owner in context = %q, want google_1", gotOwner)
	}
	// The token must not reach realtime-service, where it would be logged again.
	if gotQuery != "tab=2" {
		t.Fatalf("upstream query = %q, want the token stripped and tab kept", gotQuery)
	}
}

// turnRouter mounts the TURN route the way main.go does: behind the JWT, with
// the same proxy that strips /api/realtime.
func turnRouter(t *testing.T, upstream http.Handler) http.Handler {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)

	realtimeProxy, err := proxy.New(server.URL, "/api/realtime")
	if err != nil {
		t.Fatalf("build proxy: %v", err)
	}

	router := chi.NewRouter()
	router.Group(func(r chi.Router) {
		r.Use(middleware.Authenticate(testSecret))
		r.Get("/api/realtime/turn-credentials", realtimeProxy.ServeHTTP)
	})
	return router
}

func TestTurnCredentialsRequireAJWT(t *testing.T) {
	router := turnRouter(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be reached without a JWT")
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/realtime/turn-credentials", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestTurnCredentialsStripThePrefixAndInjectTheOwner(t *testing.T) {
	var gotPath, gotOwner string
	router := turnRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotOwner = r.Header.Get("X-Owner-ID")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"ice_servers":[],"ttl":300,"relay":false}}`))
	}))

	jwt, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_1"}, testSecret, 3600)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/realtime/turn-credentials", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	// A spoofed identity must not survive the hop: realtime-service reads this
	// header and signs a credential for whoever it names.
	req.Header.Set("X-Owner-ID", "google_impostor")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/turn-credentials" {
		t.Fatalf("upstream path = %q, want /turn-credentials", gotPath)
	}
	if gotOwner != "google_1" {
		t.Fatalf("X-Owner-ID = %q, want google_1 from the JWT", gotOwner)
	}
}

func TestTurnCredentialsRouteIsNotAWildcard(t *testing.T) {
	// A /api/realtime/* proxy would also expose realtime-service's own
	// /health and /metrics through the public gateway.
	router := turnRouter(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be reached for an unlisted realtime path")
		w.WriteHeader(http.StatusOK)
	}))

	jwt, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_1"}, testSecret, 3600)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	for _, path := range []string{"/api/realtime/metrics", "/api/realtime/health"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+jwt)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404", path, rec.Code)
		}
	}
}
