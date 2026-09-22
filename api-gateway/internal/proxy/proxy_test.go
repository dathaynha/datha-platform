package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"chatbot-playground/api-gateway/internal/auth"
	"chatbot-playground/api-gateway/internal/middleware"
)

func TestNewInvalidURL(t *testing.T) {
	if _, err := New("://bad-url", ""); err == nil {
		t.Fatal("expected error for invalid upstream URL")
	}
}

func TestProxyStripsPathAndInjectsOwnerFromStreamContext(t *testing.T) {
	var gotPath, gotOwner string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotOwner = r.Header.Get("X-Owner-ID")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler, err := New(upstream.URL, "/chatbot")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/chatbot/v1/conversations", nil)
	req = req.WithContext(middleware.WithOwnerID(req.Context(), "google_stream"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d", rec.Code)
	}
	if gotPath != "/api/v1/conversations" {
		t.Fatalf("path: got %q want /api/v1/conversations", gotPath)
	}
	if gotOwner != "google_stream" {
		t.Fatalf("X-Owner-ID: got %q want google_stream", gotOwner)
	}
}

func TestProxyInjectsJWTClaimsAndStripsSpoofedHeaders(t *testing.T) {
	const secret = "proxy-secret"
	token, err := auth.IssueToken(&auth.ExternalUser{
		OwnerID: "google_real",
		Email:   "real@example.com",
		Name:    "Real User",
		Picture: "https://pic.example/real.png",
	}, secret, 3600)
	if err != nil {
		t.Fatal(err)
	}

	var gotOwner, gotEmail, gotName, gotPicture string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOwner = r.Header.Get("X-Owner-ID")
		gotEmail = r.Header.Get("X-User-Email")
		gotName = r.Header.Get("X-User-Name")
		gotPicture = r.Header.Get("X-User-Picture")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxyHandler, err := New(upstream.URL, "/chatbot")
	if err != nil {
		t.Fatal(err)
	}
	handler := middleware.Authenticate(secret)(proxyHandler)

	req := httptest.NewRequest(http.MethodGet, "/api/chatbot/v1/foo", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Owner-ID", "spoofed")
	req.Header.Set("X-User-Email", "spoofed@evil.com")
	req.Header.Set("X-User-Name", "Spoofed Name")
	req.Header.Set("X-User-Picture", "https://evil.example/pwn.png")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if gotOwner != "google_real" {
		t.Fatalf("X-Owner-ID: got %q want google_real", gotOwner)
	}
	if gotEmail != "real@example.com" {
		t.Fatalf("X-User-Email: got %q want real@example.com", gotEmail)
	}
	if gotName != "Real User" {
		t.Fatalf("X-User-Name: got %q want Real User", gotName)
	}
	if gotPicture != "https://pic.example/real.png" {
		t.Fatalf("X-User-Picture: got %q want https://pic.example/real.png", gotPicture)
	}
}

func TestProxyStripsUpstreamCORSHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://evil.example")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	handler, err := New(upstream.URL, "")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("expected upstream CORS header to be stripped, got %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}
}
