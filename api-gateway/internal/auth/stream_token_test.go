package auth

import "testing"

func TestSignVerifyStreamTokenRoundTrip(t *testing.T) {
	const secret = "stream-secret"
	token, err := SignStreamToken("job-42", "google_abc", secret, 300)
	if err != nil {
		t.Fatalf("SignStreamToken: %v", err)
	}

	ownerID, err := VerifyStreamToken(token, "job-42", secret)
	if err != nil {
		t.Fatalf("VerifyStreamToken: %v", err)
	}
	if ownerID != "google_abc" {
		t.Fatalf("ownerID: got %q want google_abc", ownerID)
	}
}

func TestVerifyStreamTokenJobMismatch(t *testing.T) {
	token, err := SignStreamToken("job-a", "google_abc", "secret", 300)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyStreamToken(token, "job-b", "secret"); err == nil {
		t.Fatal("expected job_id mismatch error")
	}
}
