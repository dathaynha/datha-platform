package auth

import "testing"

func TestIssueVerifyTokenRoundTrip(t *testing.T) {
	const secret = "test-jwt-secret"
	user := &ExternalUser{
		OwnerID: "google_abc123",
		Email:   "user@example.com",
		Name:    "Test User",
	}

	token, err := IssueToken(user, secret, 3600)
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	claims, err := VerifyToken(token, secret)
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if claims.Subject != user.OwnerID {
		t.Fatalf("subject: got %q want %q", claims.Subject, user.OwnerID)
	}
	if claims.Email != user.Email || claims.Name != user.Name {
		t.Fatalf("claims: %+v", claims)
	}
}

func TestVerifyTokenWrongSecret(t *testing.T) {
	token, err := IssueToken(&ExternalUser{OwnerID: "google_x"}, "secret-a", 3600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyToken(token, "secret-b"); err == nil {
		t.Fatal("expected error for wrong secret")
	}
}
