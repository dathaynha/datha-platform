package config

import "testing"

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("GOOGLE_CLIENT_SECRET", "google-secret")
	t.Setenv("AZURE_CLIENT_ID", "azure-client")
	t.Setenv("JWT_SECRET", "jwt-secret")
	t.Setenv("CHATBOT_SERVICE_URL", "http://localhost:8050")
	t.Setenv("FILE_SERVICE_URL", "http://localhost:8060")
	t.Setenv("EVENT_STORE_URL", "http://localhost:8070")
	t.Setenv("NOTIFICATION_SERVICE_URL", "http://localhost:3003")
	t.Setenv("ACCOUNTS_SERVICE_URL", "http://localhost:3006")
}

func TestEntraTenantAllowed(t *testing.T) {
	cfg := &Config{
		AzureAllowedTenantIDs: map[string]struct{}{
			"9188040d-6c67-4c5b-b112-36a304b66dad": {},
		},
	}

	if !cfg.EntraTenantAllowed("9188040D-6C67-4C5B-B112-36A304B66DAD") {
		t.Fatal("expected case-insensitive tenant match")
	}
	if cfg.EntraTenantAllowed("") {
		t.Fatal("expected empty tid to be rejected")
	}
	if cfg.EntraTenantAllowed("00000000-0000-0000-0000-000000000000") {
		t.Fatal("expected unknown tenant to be rejected")
	}
}

func TestLoadAzureTenantAllowlistFromEnv(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("AZURE_ALLOWED_TENANT_IDS", "aaa-bbbb-cccc, DDDD-EEEE-FFFF ")
	t.Setenv("AZURE_TENANT_ID", "")

	cfg := Load()

	if !cfg.EntraTenantAllowed("aaa-bbbb-cccc") {
		t.Fatal("expected first allowlist tenant")
	}
	if !cfg.EntraTenantAllowed("dddd-eeee-ffff") {
		t.Fatal("expected normalized second tenant")
	}
}

func TestLoadFallsBackToAzureTenantID(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("AZURE_ALLOWED_TENANT_IDS", "")
	t.Setenv("AZURE_TENANT_ID", "Home-Tenant-GUID")

	cfg := Load()

	if !cfg.EntraTenantAllowed("home-tenant-guid") {
		t.Fatal("expected AZURE_TENANT_ID fallback in allowlist")
	}
}

func TestLoadDefaultsPortAndCORS(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("AZURE_TENANT_ID", "tenant-1")
	t.Setenv("PORT", "")
	t.Setenv("CORS_ORIGINS", " http://localhost:4000 ,http://localhost:4001 ")

	cfg := Load()

	if cfg.Port != "8080" {
		t.Fatalf("port: got %q want 8080", cfg.Port)
	}
	if len(cfg.CORSOrigins) != 2 {
		t.Fatalf("CORS origins: got %v", cfg.CORSOrigins)
	}
	if cfg.CORSOrigins[0] != "http://localhost:4000" || cfg.CORSOrigins[1] != "http://localhost:4001" {
		t.Fatalf("CORS origins: got %v", cfg.CORSOrigins)
	}
}
