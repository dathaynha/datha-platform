// Package turn issues the short-lived ICE credentials a browser needs to reach
// coturn. It implements the coturn `use-auth-secret` (TURN REST API) scheme.
package turn

// SHA-1 is not a design choice here: coturn's use-auth-secret scheme (the TURN
// REST API) defines the credential as HMAC-SHA1 of the username. It signs a
// five-minute relay grant inside an HMAC, and hashes nothing at rest.
import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // required by the coturn TURN REST API scheme
	"encoding/base64"
	"fmt"
	"strconv"
	"time"
)

// ICEServer is one entry of RTCPeerConnection's iceServers array.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Credentials is the response body handed to the browser. `ttl` lets the client
// refresh before expiry instead of discovering it mid-call.
type Credentials struct {
	ICEServers []ICEServer `json:"ice_servers"`
	TTL        int         `json:"ttl"`
	// Relay reports whether a TURN relay is actually on offer. STUN alone fails
	// behind symmetric NAT, so a client that cares can warn rather than fail
	// halfway through an ICE gather.
	Relay bool `json:"relay"`
}

// Issuer mints credentials from the coturn shared secret.
//
// The secret never leaves this process: it signs a username the browser cannot
// forge, and a long-lived TURN credential sitting in a SPA bundle is a
// relay-bandwidth theft vector.
type Issuer struct {
	secret string
	// Fixed credentials for a relay that cannot verify a signed username.
	// Both set means they are served as-is and `secret` is unused.
	username string
	password string
	turnURLs []string
	stunURLs []string
	ttl      time.Duration
	now      func() time.Time
}

// NewIssuer builds an issuer. A missing credential or TURN URL list is not an
// error: the endpoint then serves STUN only, which is exactly the local
// development state before coturn is running.
//
// `username`/`password` are for a hosted relay that does not implement the TURN
// REST API — every free one works that way. When both are present they win over
// the shared secret, which is the only time a credential this service hands out
// is not self-limiting.
func NewIssuer(
	secret, username, password string,
	turnURLs, stunURLs []string,
	ttl time.Duration,
) *Issuer {
	return &Issuer{
		secret:   secret,
		username: username,
		password: password,
		turnURLs: turnURLs,
		stunURLs: stunURLs,
		ttl:      ttl,
		now:      time.Now,
	}
}

// usesStaticCredentials reports whether a fixed pair replaces the signed one.
func (i *Issuer) usesStaticCredentials() bool {
	return i.username != "" && i.password != ""
}

// RelayConfigured reports whether both halves of the TURN configuration are
// present. Half-configured is treated as unconfigured, and said out loud at
// startup rather than discovered on the first call.
func (i *Issuer) RelayConfigured() bool {
	if len(i.turnURLs) == 0 {
		return false
	}
	return i.secret != "" || i.usesStaticCredentials()
}

// Issue mints credentials for one owner.
//
// The username carries the expiry, which is what makes the credential
// self-limiting: coturn recomputes the HMAC from the username it is given and
// rejects anything past the timestamp inside it, with no shared state.
func (i *Issuer) Issue(ownerID string) (Credentials, error) {
	if ownerID == "" {
		return Credentials{}, fmt.Errorf("owner id is required")
	}

	creds := Credentials{
		TTL:        int(i.ttl.Seconds()),
		Relay:      i.RelayConfigured(),
		ICEServers: make([]ICEServer, 0, 2),
	}
	if len(i.stunURLs) > 0 {
		creds.ICEServers = append(creds.ICEServers, ICEServer{URLs: i.stunURLs})
	}
	if !creds.Relay {
		return creds, nil
	}

	if i.usesStaticCredentials() {
		// Nothing to sign and nothing owner-specific: the provider issued one
		// credential for everybody. It is long-lived by definition, which is
		// why config.Load warns about it on every boot.
		creds.ICEServers = append(creds.ICEServers, ICEServer{
			URLs:       i.turnURLs,
			Username:   i.username,
			Credential: i.password,
		})
		return creds, nil
	}

	expiry := i.now().UTC().Add(i.ttl).Unix()
	username := strconv.FormatInt(expiry, 10) + ":" + ownerID
	creds.ICEServers = append(creds.ICEServers, ICEServer{
		URLs:       i.turnURLs,
		Username:   username,
		Credential: sign(i.secret, username),
	})
	return creds, nil
}

// sign is the TURN REST API credential: base64(HMAC-SHA1(secret, username)).
func sign(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
