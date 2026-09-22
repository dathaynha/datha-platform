package config

import (
	"testing"
	"time"
)

func TestLoadAppliesDocumentedDefaults(t *testing.T) {
	cfg := Load()

	if cfg.Port != "3004" {
		t.Errorf("Port = %q, want 3004", cfg.Port)
	}
	if cfg.PresenceTTL != 45*time.Second {
		t.Errorf("PresenceTTL = %v, want 45s", cfg.PresenceTTL)
	}
	if cfg.PresenceHeartbeat != 15*time.Second {
		t.Errorf("PresenceHeartbeat = %v, want 15s", cfg.PresenceHeartbeat)
	}
	// The TTL must outlive the heartbeat, or a live tab flickers offline.
	if cfg.PresenceTTL <= cfg.PresenceHeartbeat {
		t.Errorf("PresenceTTL %v must exceed heartbeat %v", cfg.PresenceTTL, cfg.PresenceHeartbeat)
	}
	if cfg.PingInterval != 25*time.Second {
		t.Errorf("PingInterval = %v, want 25s", cfg.PingInterval)
	}
	if cfg.MaxConnectionsPerOwner != 5 {
		t.Errorf("MaxConnectionsPerOwner = %d, want 5", cfg.MaxConnectionsPerOwner)
	}
	if cfg.TURNCredentialTTL != 300*time.Second {
		t.Errorf("TURNCredentialTTL = %v, want 300s", cfg.TURNCredentialTTL)
	}
}

func TestLoadReadsOverrides(t *testing.T) {
	t.Setenv("PORT", "4004")
	t.Setenv("PRESENCE_TTL_SECONDS", "90")
	t.Setenv("TURN_URLS", " turn:one:3478 , turn:two:3478 ")
	t.Setenv("WS_MAX_CONNECTIONS_PER_OWNER", "3")

	cfg := Load()
	if cfg.Port != "4004" {
		t.Errorf("Port = %q", cfg.Port)
	}
	if cfg.PresenceTTL != 90*time.Second {
		t.Errorf("PresenceTTL = %v", cfg.PresenceTTL)
	}
	if len(cfg.TURNURLs) != 2 || cfg.TURNURLs[0] != "turn:one:3478" || cfg.TURNURLs[1] != "turn:two:3478" {
		t.Errorf("TURNURLs = %#v, want the list trimmed and split", cfg.TURNURLs)
	}
	if cfg.MaxConnectionsPerOwner != 3 {
		t.Errorf("MaxConnectionsPerOwner = %d", cfg.MaxConnectionsPerOwner)
	}
}

func TestLoadFallsBackOnGarbageNumbers(t *testing.T) {
	// A typo in an env var must not take the service down or, worse, disable a
	// cap by setting it to zero.
	t.Setenv("WS_MAX_CONNECTIONS_PER_OWNER", "lots")
	t.Setenv("PRESENCE_TTL_SECONDS", "-5")

	cfg := Load()
	if cfg.MaxConnectionsPerOwner != 5 {
		t.Errorf("MaxConnectionsPerOwner = %d, want the default 5", cfg.MaxConnectionsPerOwner)
	}
	if cfg.PresenceTTL != 45*time.Second {
		t.Errorf("PresenceTTL = %v, want the default 45s", cfg.PresenceTTL)
	}
}

func TestTURNSecretIsNotDefaulted(t *testing.T) {
	// A default shared secret would be worse than none: it would look
	// configured while signing credentials anyone could reproduce.
	cfg := Load()
	if cfg.TURNStaticSecret != "" {
		t.Errorf("TURNStaticSecret = %q, want empty until configured", cfg.TURNStaticSecret)
	}
}
