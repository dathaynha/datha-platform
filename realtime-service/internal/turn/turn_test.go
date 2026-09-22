package turn

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"datha-platform/realtime-service/internal/metrics"
)

func fixedIssuer(secret string, turnURLs, stunURLs []string) *Issuer {
	issuer := NewIssuer(secret, "", "", turnURLs, stunURLs, 5*time.Minute)
	// 1700000000 minus the TTL, so the username's expiry lands on a round
	// number the vector below was computed from.
	issuer.now = func() time.Time { return time.Unix(1700000000, 0).Add(-5 * time.Minute) }
	return issuer
}

func TestIssueMatchesTheCoturnRESTVector(t *testing.T) {
	// The expected credential was computed outside Go —
	// base64(HMAC-SHA1("test-secret", "1700000000:google_1")) — so this asserts
	// interoperability with coturn rather than agreement with our own code.
	const wantUsername = "1700000000:google_1"
	const wantCredential = "Rc00piJaCwcGj1zDjxbmdWCoQmo=" // gitleaks:allow — HMAC of "test-secret", not a credential

	issuer := fixedIssuer("test-secret", []string{"turn:localhost:3478"}, nil)
	creds, err := issuer.Issue("google_1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if len(creds.ICEServers) != 1 {
		t.Fatalf("ice servers = %+v, want one TURN entry", creds.ICEServers)
	}
	got := creds.ICEServers[0]
	if got.Username != wantUsername {
		t.Fatalf("username = %q, want %q", got.Username, wantUsername)
	}
	if got.Credential != wantCredential {
		t.Fatalf("credential = %q, want %q", got.Credential, wantCredential)
	}
}

func TestIssueServesFixedCredentialsWhenConfigured(t *testing.T) {
	// A hosted relay that cannot verify a signed username issues one credential
	// for everybody. This platform develops behind CGNAT (2026-09-13), so a
	// self-hosted coturn is unreachable from a second network and a public
	// relay is the only way the relay path can be exercised at all.
	issuer := NewIssuer(
		"ignored-secret",
		"openrelayproject",
		"openrelaypassword",
		[]string{"turn:relay.example:80"},
		[]string{"stun:stun.example:19302"},
		time.Minute,
	)

	creds, err := issuer.Issue("google_1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if !creds.Relay {
		t.Fatal("relay = false, want true when a fixed pair is configured")
	}
	if len(creds.ICEServers) != 2 {
		t.Fatalf("ice servers = %+v, want STUN and TURN", creds.ICEServers)
	}
	turnServer := creds.ICEServers[1]
	if turnServer.Username != "openrelayproject" {
		t.Fatalf("username = %q, want the configured one verbatim", turnServer.Username)
	}
	if turnServer.Credential != "openrelaypassword" {
		t.Fatalf("credential = %q, want the configured one verbatim", turnServer.Credential)
	}
	// The shared secret must not leak into the response in any form.
	if strings.Contains(turnServer.Credential, "ignored") ||
		strings.Contains(turnServer.Username, ":") {
		t.Fatalf("fixed credentials must not be signed: %+v", turnServer)
	}
}

func TestHalfConfiguredFixedCredentialsFallBackToSigning(t *testing.T) {
	// A username with no password is a mistake, not a configuration. Falling
	// back to the shared secret keeps a working relay instead of handing the
	// browser half a credential.
	issuer := NewIssuer(
		"test-secret",
		"openrelayproject",
		"",
		[]string{"turn:relay.example:80"},
		nil,
		time.Minute,
	)

	creds, err := issuer.Issue("google_1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if !strings.HasSuffix(creds.ICEServers[0].Username, ":google_1") {
		t.Fatalf("username = %q, want a signed <expiry>:owner", creds.ICEServers[0].Username)
	}
}

func TestRelayConfiguredWithFixedCredentialsAndNoSecret(t *testing.T) {
	issuer := NewIssuer("", "user", "pass", []string{"turn:relay.example:80"}, nil, time.Minute)
	if !issuer.RelayConfigured() {
		t.Fatal("RelayConfigured = false; a fixed pair is a complete configuration")
	}

	// URLs are still mandatory: credentials alone relay nothing.
	noURLs := NewIssuer("", "user", "pass", nil, nil, time.Minute)
	if noURLs.RelayConfigured() {
		t.Fatal("RelayConfigured = true with no TURN URLs")
	}
}

func TestIssueUsernameCarriesFutureExpiryAndOwner(t *testing.T) {
	issuer := NewIssuer("s", "", "", []string{"turn:localhost:3478"}, nil, time.Minute)
	before := time.Now().UTC().Unix()

	creds, err := issuer.Issue("google_7")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	username := creds.ICEServers[0].Username
	expiry, owner, found := strings.Cut(username, ":")
	if !found || owner != "google_7" {
		t.Fatalf("username = %q, want <expiry>:google_7", username)
	}
	ts, err := strconv.ParseInt(expiry, 10, 64)
	if err != nil {
		t.Fatalf("expiry %q is not a unix timestamp: %v", expiry, err)
	}
	// The expiry is what makes the credential self-limiting; coturn rejects
	// anything past the timestamp inside the username.
	if ts <= before {
		t.Fatalf("expiry %d is not in the future (now %d)", ts, before)
	}
}

func TestIssueDiffersPerOwner(t *testing.T) {
	issuer := fixedIssuer("test-secret", []string{"turn:localhost:3478"}, nil)
	first, _ := issuer.Issue("google_1")
	second, _ := issuer.Issue("google_2")
	if first.ICEServers[0].Credential == second.ICEServers[0].Credential {
		t.Fatal("two owners must not share a credential")
	}
}

func TestIssueServesSTUNOnlyWhenTURNIsNotConfigured(t *testing.T) {
	// The local state before coturn is running. STUN alone is honest about
	// what it is, and `relay:false` lets the client warn instead of failing
	// halfway through an ICE gather.
	for name, issuer := range map[string]*Issuer{
		"no secret and no urls": fixedIssuer("", nil, []string{"stun:stun.example:3478"}),
		"urls without a secret": fixedIssuer("", []string{"turn:localhost:3478"}, []string{"stun:stun.example:3478"}),
		"secret without urls":   fixedIssuer("test-secret", nil, []string{"stun:stun.example:3478"}),
	} {
		creds, err := issuer.Issue("google_1")
		if err != nil {
			t.Fatalf("%s: Issue: %v", name, err)
		}
		if creds.Relay {
			t.Fatalf("%s: relay = true, want false", name)
		}
		if len(creds.ICEServers) != 1 || creds.ICEServers[0].URLs[0] != "stun:stun.example:3478" {
			t.Fatalf("%s: ice servers = %+v, want STUN only", name, creds.ICEServers)
		}
		if creds.ICEServers[0].Credential != "" {
			t.Fatalf("%s: STUN entry must carry no credential", name)
		}
	}
}

func TestIssueRejectsAnEmptyOwner(t *testing.T) {
	if _, err := fixedIssuer("test-secret", []string{"turn:x:3478"}, nil).Issue(""); err == nil {
		t.Fatal("an unattributed credential must not be issued")
	}
}

func TestHandlerRequiresTheGatewayOwnerHeader(t *testing.T) {
	recorder := httptest.NewRecorder()
	Handler(fixedIssuer("test-secret", []string{"turn:x:3478"}, nil), metrics.New()).
		ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/turn-credentials", nil))

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "test-secret") {
		t.Fatal("the shared secret must never appear in a response")
	}
}

func TestHandlerNeverLeaksTheSharedSecret(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	request.Header.Set("X-Owner-ID", "google_1")
	recorder := httptest.NewRecorder()

	Handler(fixedIssuer("test-secret", []string{"turn:localhost:3478"}, nil), metrics.New()).
		ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	// The whole point of use-auth-secret: the browser gets a five-minute
	// signature, never the key that signs it.
	if strings.Contains(recorder.Body.String(), "test-secret") {
		t.Fatalf("response leaked the shared secret: %s", recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store — a cache would hand one owner's grant to another", got)
	}

	var body struct {
		Data Credentials `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.Data.Relay || body.Data.TTL != 300 {
		t.Fatalf("data = %+v, want relay true and ttl 300", body.Data)
	}
}
