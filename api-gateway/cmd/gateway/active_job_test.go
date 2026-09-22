package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatbot-playground/api-gateway/internal/auth"
	"chatbot-playground/api-gateway/internal/middleware"
)

// upstreamStub stands in for chatbot-service.
func upstreamStub(status int, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if body != "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		if body != "" {
			_, _ = w.Write([]byte(body))
		}
	})
}

func authedActiveJobRequest(t *testing.T, upstream http.Handler) *httptest.ResponseRecorder {
	t.Helper()

	jwt, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_123"}, testSecret, 60)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}

	handler := middleware.Authenticate(testSecret)(activeJobHandler(testConfig(), upstream))
	req := httptest.NewRequest(http.MethodGet, "/api/chatbot/v1/conversations/c1/active-job", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestActiveJobHandler_InjectsStreamTokenForRunningJob(t *testing.T) {
	jobID := "11111111-1111-1111-1111-111111111111"
	body := `{"job_id":"` + jobID + `","user_message_id":"m1","status":"processing"}`

	rec := authedActiveJobRequest(t, upstreamStub(http.StatusOK, body))

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
	// Upstream fields must survive the rewrite.
	if resp["status"] != "processing" {
		t.Fatalf("expected status passthrough, got %v", resp["status"])
	}
}

func TestActiveJobHandler_PassesThrough204WithoutBody(t *testing.T) {
	rec := authedActiveJobRequest(t, upstreamStub(http.StatusNoContent, ""))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("expected empty body on 204, got %q", rec.Body.String())
	}
}

func TestActiveJobHandler_PassesThrough404(t *testing.T) {
	rec := authedActiveJobRequest(t, upstreamStub(http.StatusNotFound, `{"detail":"conversation not found"}`))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, exists := resp["stream_token"]; exists {
		t.Fatal("stream_token must not be minted for an error response")
	}
}

func TestActiveJobHandler_RequiresAuth(t *testing.T) {
	handler := middleware.Authenticate(testSecret)(
		activeJobHandler(testConfig(), upstreamStub(http.StatusOK, `{"job_id":"j1"}`)),
	)
	req := httptest.NewRequest(http.MethodGet, "/api/chatbot/v1/conversations/c1/active-job", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without Authorization, got %d", rec.Code)
	}
}
