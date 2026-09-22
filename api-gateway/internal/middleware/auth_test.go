package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"chatbot-playground/api-gateway/internal/auth"
)

func TestAuthenticateMissingBearer(t *testing.T) {
	h := Authenticate("secret")(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("handler should not run")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/foo", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status: got %d want 401", rec.Code)
	}
}

func TestAuthenticateValidToken(t *testing.T) {
	const secret = "middleware-secret"
	token, err := auth.IssueToken(&auth.ExternalUser{OwnerID: "google_ok"}, secret, 3600)
	if err != nil {
		t.Fatal(err)
	}

	var gotSubject string
	h := Authenticate(secret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFromContext(r.Context())
		if claims == nil {
			t.Fatal("expected claims in context")
		}
		gotSubject = claims.Subject
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/foo", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	if gotSubject != "google_ok" {
		t.Fatalf("subject: got %q", gotSubject)
	}
}

func TestAuthenticateInvalidToken(t *testing.T) {
	h := Authenticate("secret")(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("handler should not run")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/foo", nil)
	req.Header.Set("Authorization", "Bearer not-a-jwt")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status: got %d want 401", rec.Code)
	}
}

func TestWithOwnerIDRoundTrip(t *testing.T) {
	ctx := WithOwnerID(context.Background(), "google_stream_owner")
	if got := OwnerIDFromContext(ctx); got != "google_stream_owner" {
		t.Fatalf("OwnerIDFromContext: got %q", got)
	}
	if got := OwnerIDFromContext(context.Background()); got != "" {
		t.Fatalf("expected empty owner on fresh context, got %q", got)
	}
}
