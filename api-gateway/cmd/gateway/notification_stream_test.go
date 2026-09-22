package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatbot-playground/api-gateway/internal/auth"
	"chatbot-playground/api-gateway/internal/config"
	"chatbot-playground/api-gateway/internal/middleware"
)

const testSecret = "test-secret"

func testConfig() *config.Config {
	return &config.Config{JWTSecret: testSecret, JWTTTLSeconds: 60}
}

func TestNotificationStreamTokenHandler_MintsVerifiableToken(t *testing.T) {
	jwt, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_123"}, testSecret, 60)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}

	handler := middleware.Authenticate(testSecret)(notificationStreamTokenHandler(testConfig()))
	req := httptest.NewRequest(http.MethodGet, "/api/notifications/stream-token", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	ownerID, err := auth.VerifyStreamToken(body["stream_token"], notificationStreamScope, testSecret)
	if err != nil {
		t.Fatalf("minted token failed verification: %v", err)
	}
	if ownerID != "google_123" {
		t.Fatalf("expected owner google_123, got %q", ownerID)
	}
}

func TestNotificationStreamTokenHandler_RejectsMissingJWT(t *testing.T) {
	handler := middleware.Authenticate(testSecret)(notificationStreamTokenHandler(testConfig()))
	req := httptest.NewRequest(http.MethodGet, "/api/notifications/stream-token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestNotificationStreamHandler_RejectsMissingOrInvalidToken(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream must not be called without a valid stream_token")
	})
	handler := notificationStreamHandler(testConfig(), upstream)

	for name, target := range map[string]string{
		"missing": "/api/notifications/stream",
		"garbage": "/api/notifications/stream?stream_token=garbage",
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s token: expected 401, got %d", name, rec.Code)
		}
	}
}

func TestNotificationStreamHandler_RejectsWrongScope(t *testing.T) {
	// A chatbot job token must not open the notification stream.
	jobToken, err := auth.SignStreamToken("some-job-id", "google_123", testSecret, 60)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	handler := notificationStreamHandler(testConfig(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("upstream must not be called for a wrong-scope token")
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/notifications/stream?stream_token="+jobToken, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestNotificationStreamHandler_ForwardsOwnerAndStripsToken(t *testing.T) {
	streamToken, err := auth.SignStreamToken(notificationStreamScope, "google_123", testSecret, 60)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	var gotOwner, gotQuery string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOwner = middleware.OwnerIDFromContext(r.Context())
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	})
	handler := notificationStreamHandler(testConfig(), upstream)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/notifications/stream?stream_token="+streamToken, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if gotOwner != "google_123" {
		t.Fatalf("expected owner google_123 in context, got %q", gotOwner)
	}
	if gotQuery != "" {
		t.Fatalf("expected stream_token stripped from query, got %q", gotQuery)
	}
}
