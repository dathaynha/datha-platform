package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatbot-playground/api-gateway/internal/auth"
	"chatbot-playground/api-gateway/internal/middleware"
)

func authedRetryLastRequest(t *testing.T, upstream http.Handler) *httptest.ResponseRecorder {
	t.Helper()

	jwt, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_123"}, testSecret, 60)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}

	handler := middleware.Authenticate(testSecret)(retryLastHandler(testConfig(), upstream))
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/chatbot/v1/conversations/c1/retry-last",
		strings.NewReader(`{"model":"gemini-3.6-flash"}`),
	)
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestRetryLastHandler_InjectsStreamTokenForRequeuedJob(t *testing.T) {
	jobID := "22222222-2222-2222-2222-222222222222"
	body := `{"job_id":"` + jobID + `","correlation_id":"` + jobID +
		`","conversation_id":"c1","user_message_id":"m1"}`

	rec := authedRetryLastRequest(t, upstreamStub(http.StatusOK, body))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	token, ok := resp["stream_token"].(string)
	if !ok || token == "" {
		t.Fatalf("expected stream_token in response, got %v", resp)
	}
	ownerID, err := auth.VerifyStreamToken(token, jobID, testSecret)
	if err != nil {
		t.Fatalf("minted token failed verification: %v", err)
	}
	if ownerID != "google_123" {
		t.Fatalf("expected owner google_123, got %q", ownerID)
	}
	if resp["user_message_id"] != "m1" {
		t.Fatalf("expected user_message_id passthrough, got %v", resp["user_message_id"])
	}
}

func TestRetryLastHandler_PassesThrough409WithoutToken(t *testing.T) {
	rec := authedRetryLastRequest(t, upstreamStub(
		http.StatusConflict,
		`{"detail":"a generation is already running for this conversation"}`,
	))

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, exists := resp["stream_token"]; exists {
		t.Fatal("stream_token must not be minted for an error response")
	}
}

func TestRetryLastHandler_PassesThrough404(t *testing.T) {
	rec := authedRetryLastRequest(t, upstreamStub(
		http.StatusNotFound,
		`{"detail":"last reply did not fail"}`,
	))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "stream_token") {
		t.Fatal("stream_token must not be minted for an error response")
	}
}

func TestRetryLastHandler_RequiresAuth(t *testing.T) {
	handler := middleware.Authenticate(testSecret)(
		retryLastHandler(testConfig(), upstreamStub(http.StatusOK, `{"job_id":"j1"}`)),
	)
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/chatbot/v1/conversations/c1/retry-last",
		strings.NewReader(`{}`),
	)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without Authorization, got %d", rec.Code)
	}
}
