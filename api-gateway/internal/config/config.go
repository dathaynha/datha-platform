package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// Config holds api-gateway settings loaded from the environment.
type Config struct {
	Port                   string
	GoogleClientID         string
	GoogleClientSecret     string
	AzureClientID          string
	AzureTenantID          string              // Home / default tenant; seeds allowlist when AZURE_ALLOWED_TENANT_IDS is unset.
	AzureAllowedTenantIDs  map[string]struct{} // Normalized lowercase GUIDs; tid must match to issue internal JWT.
	JWTSecret              string
	JWTTTLSeconds          int
	ChatbotServiceURL      string
	FileServiceURL         string
	EventStoreServiceURL   string
	NotificationServiceURL string
	AccountsServiceURL     string
	MessengerServiceURL    string // Messenger durable domain state (:3005)
	RealtimeServiceURL     string // Messenger WebSocket service (:3004)
	// TTL for the token that authorises the realtime WebSocket. Deliberately
	// far shorter than JWTTTLSeconds: it travels in a query string, and query
	// strings land in access logs and proxy telemetry. It is needed only at connect.
	RealtimeStreamTTLSeconds int
	NATSURL                  string // optional; JetStream publish for gateway.auth.login
	CORSOrigins              []string
}

// Load reads configuration from environment variables.
func Load() *Config {
	ttl := 3600
	if v := os.Getenv("JWT_TTL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			ttl = n
		}
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	rawOrigins := os.Getenv("CORS_ORIGINS")
	var origins []string
	for _, o := range strings.Split(rawOrigins, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}

	cfg := &Config{
		Port:                   port,
		GoogleClientID:         strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID")),
		GoogleClientSecret:     strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_SECRET")),
		AzureClientID:          strings.TrimSpace(os.Getenv("AZURE_CLIENT_ID")),
		AzureTenantID:          strings.TrimSpace(os.Getenv("AZURE_TENANT_ID")),
		JWTSecret:              strings.TrimSpace(os.Getenv("JWT_SECRET")),
		JWTTTLSeconds:          ttl,
		ChatbotServiceURL:      strings.TrimSpace(os.Getenv("CHATBOT_SERVICE_URL")),
		FileServiceURL:         strings.TrimSpace(os.Getenv("FILE_SERVICE_URL")),
		EventStoreServiceURL:   strings.TrimSpace(os.Getenv("EVENT_STORE_URL")),
		NotificationServiceURL: strings.TrimSpace(os.Getenv("NOTIFICATION_SERVICE_URL")),
		AccountsServiceURL:     strings.TrimSpace(os.Getenv("ACCOUNTS_SERVICE_URL")),
		// Messenger URLs default rather than being required: adding a required
		// var breaks every existing .env on the next pull, which is exactly how
		// the gateway failed to boot on 2026-09-06.
		MessengerServiceURL:      urlOr("MESSENGER_SERVICE_URL", "http://localhost:3005"),
		RealtimeServiceURL:       urlOr("REALTIME_SERVICE_URL", "http://localhost:3004"),
		RealtimeStreamTTLSeconds: positiveIntOr("REALTIME_STREAM_TTL_SECONDS", 90),
		NATSURL:                  strings.TrimSpace(os.Getenv("NATS_URL")),
		CORSOrigins:              origins,
	}

	parseAzureTenantAllowlist(cfg)

	validate(cfg)
	return cfg
}

// urlOr reads a service URL, falling back to its local-development default and
// saying so, so a missing var is visible in the log without being fatal.
func urlOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	slog.Warn("service URL not set; using local default", "var", key, "default", fallback)
	return fallback
}

func positiveIntOr(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
		slog.Warn("ignoring invalid value; using default", "var", key, "default", fallback)
	}
	return fallback
}

func normalizeAzureTenantGUID(s string) string {
	return strings.TrimSpace(strings.ToLower(s))
}

// parseAzureTenantAllowlist fills AzureAllowedTenantIDs from AZURE_ALLOWED_TENANT_IDS
// or falls back to AZURE_TENANT_ID alone.
func parseAzureTenantAllowlist(cfg *Config) {
	raw := strings.TrimSpace(os.Getenv("AZURE_ALLOWED_TENANT_IDS"))
	var ids []string
	for _, part := range strings.Split(raw, ",") {
		if n := normalizeAzureTenantGUID(part); n != "" {
			ids = append(ids, n)
		}
	}
	if len(ids) == 0 {
		if t := normalizeAzureTenantGUID(cfg.AzureTenantID); t != "" {
			ids = append(ids, t)
		}
	}
	m := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		m[id] = struct{}{}
	}
	cfg.AzureAllowedTenantIDs = m
}

func validate(cfg *Config) {
	required := map[string]string{
		"GOOGLE_CLIENT_SECRET":     cfg.GoogleClientSecret,
		"AZURE_CLIENT_ID":          cfg.AzureClientID,
		"JWT_SECRET":               cfg.JWTSecret,
		"CHATBOT_SERVICE_URL":      cfg.ChatbotServiceURL,
		"FILE_SERVICE_URL":         cfg.FileServiceURL,
		"EVENT_STORE_URL":          cfg.EventStoreServiceURL,
		"NOTIFICATION_SERVICE_URL": cfg.NotificationServiceURL,
		"ACCOUNTS_SERVICE_URL":     cfg.AccountsServiceURL,
	}
	for k, v := range required {
		if v == "" {
			slog.Error("required env var is not set", "var", k)
			os.Exit(1)
		}
	}
	if len(cfg.AzureAllowedTenantIDs) == 0 {
		slog.Error("no Entra tenant allowlist: set AZURE_ALLOWED_TENANT_IDS or AZURE_TENANT_ID",
			"hint", "Use comma-separated tenant GUIDs; personal Microsoft tokens use tenant 9188040d-6c67-4c5b-b112-36a304b66dad")
		os.Exit(1)
	}
}

// EntraTenantAllowed reports whether id_token tid is allowed for this gateway.
func (cfg *Config) EntraTenantAllowed(tid string) bool {
	if tid == "" {
		return false
	}
	_, ok := cfg.AzureAllowedTenantIDs[normalizeAzureTenantGUID(tid)]
	return ok
}
