package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/joho/godotenv"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"chatbot-playground/api-gateway/internal/auth"
	"chatbot-playground/api-gateway/internal/config"
	"chatbot-playground/api-gateway/internal/events"
	"chatbot-playground/api-gateway/internal/logging"
	"chatbot-playground/api-gateway/internal/middleware"
	"chatbot-playground/api-gateway/internal/natsclient"
	"chatbot-playground/api-gateway/internal/proxy"
)

func usableRefreshToken(raw string) bool {
	t := strings.TrimSpace(raw)
	if t == "" {
		return false
	}
	switch strings.ToLower(t) {
	case "null", "undefined":
		return false
	default:
		return true
	}
}

func validateOAuthTokenGrant(form url.Values, supported map[string]struct{}) error {
	gt := form.Get("grant_type")
	if gt == "" {
		return fmt.Errorf("missing grant_type")
	}
	if _, ok := supported[gt]; !ok {
		return fmt.Errorf("unsupported grant_type")
	}
	if gt == "refresh_token" && !usableRefreshToken(form.Get("refresh_token")) {
		return fmt.Errorf("invalid refresh_token")
	}
	return nil
}

func googleSupportedGrants() map[string]struct{} {
	return map[string]struct{}{
		"authorization_code": {},
		"refresh_token":      {},
	}
}

func entraSupportedGrants() map[string]struct{} {
	return map[string]struct{}{
		"authorization_code": {},
		"refresh_token":      {},
	}
}

// setRefreshTokenIfPresent forwards the IdP refresh token so SPA storage can persist it for silent refresh.
func setRefreshTokenIfPresent(resp map[string]any, refreshToken string) {
	if usableRefreshToken(refreshToken) {
		resp["refresh_token"] = refreshToken
	}
}

func main() {
	// Load .env in local development; ignore error in production (env vars already set).
	_ = godotenv.Load()

	logShutdown := logging.Setup(context.Background())

	cfg := config.Load()

	eventPublisher, closeNats, natsErr := natsclient.ConnectOptional(cfg.NATSURL)
	if natsErr != nil {
		slog.Warn("NATS unavailable; gateway will run without event publish",
			"error", natsErr,
			"nats_url", cfg.NATSURL,
		)
		eventPublisher = nil
		closeNats = func() {}
	}
	shutdown := func(code int) {
		closeNats()
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = logShutdown(flushCtx)
		os.Exit(code)
	}

	chatbotProxy, err := proxy.New(cfg.ChatbotServiceURL, "/chatbot")
	if err != nil {
		slog.Error("invalid CHATBOT_SERVICE_URL", "error", err)
		shutdown(1)
	}

	// Strip /api so /api/files/prepare → /files/prepare on file-service.
	fileProxy, err := proxy.New(cfg.FileServiceURL, "/api")
	if err != nil {
		slog.Error("invalid FILE_SERVICE_URL", "error", err)
		shutdown(1)
	}

	eventStoreProxy, err := proxy.New(cfg.EventStoreServiceURL, "/api/event-store")
	if err != nil {
		slog.Error("invalid EVENT_STORE_URL", "error", err)
		shutdown(1)
	}

	// Strip /api so /api/notifications → /notifications on notification-service.
	notificationProxy, err := proxy.New(cfg.NotificationServiceURL, "/api")
	if err != nil {
		slog.Error("invalid NOTIFICATION_SERVICE_URL", "error", err)
		shutdown(1)
	}

	// Strip /api/accounts so /api/accounts/users/me → /users/me on accounts-service.
	accountsProxy, err := proxy.New(cfg.AccountsServiceURL, "/api/accounts")
	if err != nil {
		slog.Error("invalid ACCOUNTS_SERVICE_URL", "error", err)
		shutdown(1)
	}

	// Strip /api/messenger so /api/messenger/conversations → /conversations.
	messengerProxy, err := proxy.New(cfg.MessengerServiceURL, "/api/messenger")
	if err != nil {
		slog.Error("invalid MESSENGER_SERVICE_URL", "error", err)
		shutdown(1)
	}

	// Strip /api/realtime so /api/realtime/ws → /ws on realtime-service.
	realtimeProxy, err := proxy.New(cfg.RealtimeServiceURL, "/api/realtime")
	if err != nil {
		slog.Error("invalid REALTIME_SERVICE_URL", "error", err)
		shutdown(1)
	}

	r := chi.NewRouter()

	r.Use(middleware.Correlation)
	r.Use(middleware.Logger)
	r.Use(middleware.Metrics)
	r.Use(chiMiddleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Correlation-ID", "X-Microsoft-Login-Pool"},
		ExposedHeaders:   []string{"X-Correlation-ID"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	// Public routes — no JWT required.
	r.Get("/health", healthHandler)
	r.Handle("/metrics", promhttp.Handler())
	r.Post("/auth/google/token", googleTokenHandler(cfg, eventPublisher))
	r.Post("/auth/entra/token", entraTokenHandler(cfg, eventPublisher))

	// Protected routes — JWT required.
	r.Group(func(r chi.Router) {
		r.Use(middleware.Authenticate(cfg.JWTSecret))

		// chatbot-service routes.
		// Every response that names a job_id is intercepted to inject stream_token.
		r.Post("/api/chatbot/v1/messages", messagesHandler(cfg, chatbotProxy))
		r.Get(
			"/api/chatbot/v1/conversations/{conversationID}/active-job",
			activeJobHandler(cfg, chatbotProxy),
		)
		r.Post(
			"/api/chatbot/v1/conversations/{conversationID}/retry-last",
			retryLastHandler(cfg, chatbotProxy),
		)
		r.Handle("/api/chatbot/*", chatbotProxy)

		// file-service routes.
		// /api/files → /files, /api/files/* → /files/* on file-service.
		r.Handle("/api/files", fileProxy)
		r.Handle("/api/files/*", fileProxy)

		// event-store ops API: /api/event-store/events → /events, etc.
		r.Handle("/api/event-store", eventStoreProxy)
		r.Handle("/api/event-store/*", eventStoreProxy)

		// notification-service routes.
		// /api/notifications → /notifications, /api/notifications/* → /notifications/*.
		r.Handle("/api/notifications", notificationProxy)
		r.Handle("/api/notifications/*", notificationProxy)

		// Mints the short-lived token that authorises the notification SSE stream.
		r.Get("/api/notifications/stream-token", notificationStreamTokenHandler(cfg))

		// accounts-service routes.
		// /api/accounts/users/me → /users/me on accounts-service.
		r.Handle("/api/accounts", accountsProxy)
		r.Handle("/api/accounts/*", accountsProxy)

		// messenger-service routes.
		// /api/messenger/conversations → /conversations on messenger-service.
		r.Handle("/api/messenger", messengerProxy)
		r.Handle("/api/messenger/*", messengerProxy)

		// Mints the short-lived token that authorises the realtime WebSocket.
		r.Get("/api/realtime/token", realtimeStreamTokenHandler(cfg))

		// ICE servers for a WebRTC call. A normal JWT-protected route, so the
		// proxy injects X-Owner-ID and realtime-service signs a five-minute
		// TURN credential for that owner; the coturn shared secret stays in
		// that service's .env and never reaches the browser.
		//
		// Listed explicitly rather than proxying /api/realtime/* — a wildcard
		// would also expose that service's /health and /metrics.
		r.Get("/api/realtime/turn-credentials", realtimeProxy.ServeHTTP)
	})

	// Stream endpoints — public routes, secured by short-lived stream_token query param.
	// EventSource cannot set Authorization headers, so we use a scoped token instead.
	r.Get("/api/chatbot/v1/stream/{jobID}", streamHandler(cfg, chatbotProxy))
	r.Get("/api/notifications/stream", notificationStreamHandler(cfg, notificationProxy))
	r.Get("/api/realtime/ws", realtimeSocketHandler(cfg, realtimeProxy))

	addr := fmt.Sprintf(":%s", cfg.Port)
	slog.Info("api-gateway starting", "addr", addr)

	if err := http.ListenAndServe(addr, r); err != nil {
		slog.Error("server error", "error", err)
		shutdown(1)
	}
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"status":"ok"}`)
}

// googleTokenHandler exchanges the Google authorization code, issues an internal JWT,
// and returns it as the access_token in the OAuth token response.
//
// The Google id_token is preserved unchanged so the Angular oauth library
// can still validate the user's identity via OIDC. The access_token is replaced
// with our internal JWT — the Angular library uses access_token as the Bearer
// token for all downstream API calls, which is what we want.
func googleTokenHandler(cfg *config.Config, publisher *events.Publisher) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid form body")
			return
		}

		formBody, err := url.ParseQuery(r.Form.Encode())
		if err != nil {
			writeError(w, http.StatusBadRequest, "could not parse form values")
			return
		}

		if err := validateOAuthTokenGrant(formBody, googleSupportedGrants()); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		googleResp, err := auth.ExchangeCode(r.Context(), cfg.GoogleClientID, cfg.GoogleClientSecret, formBody)
		if err != nil {
			slog.Error("google token exchange failed",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusBadGateway, "authentication failed")
			return
		}

		if googleResp.IDToken == "" {
			slog.Error("google token response missing id_token",
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusBadGateway, "authentication failed")
			return
		}

		idClaims, err := auth.ParseIDTokenClaims(googleResp.IDToken)
		if err != nil {
			slog.Error("failed to parse google id_token",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusInternalServerError, "could not process identity token")
			return
		}

		user := &auth.ExternalUser{
			OwnerID: "google_" + idClaims.Sub,
			Email:   idClaims.Email,
			Name:    idClaims.Name,
			Picture: idClaims.Picture,
		}
		internalJWT, err := auth.IssueToken(user, cfg.JWTSecret, cfg.JWTTTLSeconds)
		if err != nil {
			slog.Error("failed to issue internal JWT",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusInternalServerError, "could not issue token")
			return
		}

		publishLoginAsync(publisher, events.AuthLoginParams{
			OwnerID:       user.OwnerID,
			CorrelationID: middleware.CorrelationIDFromContext(r.Context()),
			Provider:      "google",
			GrantType:     formBody.Get("grant_type"),
		})

		// Return a standard OAuth token response, replacing access_token with our JWT.
		// The Angular oauth library will use access_token as the Bearer token for API calls.
		resp := map[string]any{
			"access_token": internalJWT,
			"id_token":     googleResp.IDToken, // kept for OIDC identity validation in the browser
			"token_type":   "Bearer",
			"expires_in":   cfg.JWTTTLSeconds,
			"scope":        googleResp.Scope,
		}
		setRefreshTokenIfPresent(resp, googleResp.RefreshToken)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// entraTokenHandler proxies the PKCE authorization-code exchange to Azure Entra,
// then issues our internal JWT so downstream services see a uniform token format.
//
// The Angular oauth library posts the code + code_verifier to this endpoint
// (configured via tokenProxyUrl in entraOidc). No client_secret is added because
// Entra SPA registrations use PKCE without a secret.
// entraLoginPoolFromRequest returns organizations|consumers from header or form (SPA sends header on token proxy).
func entraLoginPoolFromRequest(r *http.Request, form url.Values) string {
	if p := strings.TrimSpace(strings.ToLower(r.Header.Get("X-Microsoft-Login-Pool"))); p != "" {
		return p
	}
	return strings.TrimSpace(strings.ToLower(form.Get("login_pool")))
}

func entraTokenHandler(cfg *config.Config, publisher *events.Publisher) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid form body")
			return
		}

		formBody, err := url.ParseQuery(r.Form.Encode())
		if err != nil {
			writeError(w, http.StatusBadRequest, "could not parse form values")
			return
		}

		pool := entraLoginPoolFromRequest(r, formBody)
		formBody.Del("login_pool")

		tokenURL, err := auth.EntraTokenURLForLoginPool(pool)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid login pool")
			return
		}

		if err := validateOAuthTokenGrant(formBody, entraSupportedGrants()); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		origin := r.Header.Get("Origin")
		entraResp, err := auth.ExchangeEntraCode(r.Context(), tokenURL, origin, formBody)
		if err != nil {
			slog.Error("entra token exchange failed",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusBadGateway, "authentication failed")
			return
		}

		if entraResp.IDToken == "" {
			slog.Error("entra token response missing id_token",
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusBadGateway, "authentication failed")
			return
		}

		idClaims, err := auth.ParseEntraIDTokenClaims(entraResp.IDToken)
		if err != nil {
			slog.Error("failed to parse entra id_token",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusInternalServerError, "could not process identity token")
			return
		}

		if !cfg.EntraTenantAllowed(idClaims.TID) {
			slog.Warn("entra sign-in rejected: tenant not allowlisted",
				"tid", idClaims.TID,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusForbidden, "tenant not allowed")
			return
		}

		user := &auth.ExternalUser{
			OwnerID: "entra_" + idClaims.OID,
			Email:   idClaims.PreferredUsername,
			Name:    idClaims.Name,
		}
		internalJWT, err := auth.IssueToken(user, cfg.JWTSecret, cfg.JWTTTLSeconds)
		if err != nil {
			slog.Error("failed to issue internal JWT for entra user",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusInternalServerError, "could not issue token")
			return
		}

		publishLoginAsync(publisher, events.AuthLoginParams{
			OwnerID:       user.OwnerID,
			CorrelationID: middleware.CorrelationIDFromContext(r.Context()),
			Provider:      "entra",
			GrantType:     formBody.Get("grant_type"),
			EntraTenantID: idClaims.TID,
			EntraPool:     pool,
		})

		resp := map[string]any{
			"access_token": internalJWT,
			"id_token":     entraResp.IDToken,
			"token_type":   "Bearer",
			"expires_in":   cfg.JWTTTLSeconds,
			"scope":        entraResp.Scope,
		}
		setRefreshTokenIfPresent(resp, entraResp.RefreshToken)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// messagesHandler forwards POST /messages to chatbot-service and injects a
// short-lived stream_token into the response. The token lets the browser open
// the SSE stream without an Authorization header (EventSource limitation).
func messagesHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return streamTokenInjectingHandler(cfg, upstream)
}

// activeJobHandler forwards GET /conversations/{id}/active-job and injects a
// stream_token for the returned job, so a revisit can re-attach to a running
// generation. 204 (nothing running) passes through untouched.
func activeJobHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return streamTokenInjectingHandler(cfg, upstream)
}

// retryLastHandler forwards POST /conversations/{id}/retry-last and injects a
// stream_token for the re-queued job, so the frontend can open its stream exactly
// as it does after a send.
func retryLastHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return streamTokenInjectingHandler(cfg, upstream)
}

// streamTokenInjectingHandler proxies a chatbot-service response that names a
// job_id and adds a stream_token minted for that job and the caller's identity.
// Ownership stays service-enforced — the gateway only signs what the service
// already returned for this authenticated user.
func streamTokenInjectingHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Buffer the request body so the proxy can read it, then restore it.
		reqBody, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "could not read request body")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(reqBody))

		// Capture the upstream response instead of writing directly to w.
		rec := &responseRecorder{header: make(http.Header), statusCode: http.StatusOK}
		upstream.ServeHTTP(rec, r)

		respBody := rec.body.Bytes()
		statusCode := rec.statusCode

		// On success inject stream_token into the JSON response. 204 carries no body.
		if statusCode >= 200 && statusCode < 300 && statusCode != http.StatusNoContent {
			var jobResp map[string]any
			if err := json.Unmarshal(respBody, &jobResp); err == nil {
				if jobID, ok := jobResp["job_id"].(string); ok {
					ownerID := ""
					if claims := middleware.ClaimsFromContext(r.Context()); claims != nil {
						ownerID = claims.Subject
					}
					if streamToken, err := auth.SignStreamToken(jobID, ownerID, cfg.JWTSecret, cfg.JWTTTLSeconds); err == nil {
						jobResp["stream_token"] = streamToken
						if enriched, err := json.Marshal(jobResp); err == nil {
							respBody = enriched
						}
					}
				}
			}
		}

		// Forward response headers, stripping upstream CORS (gateway owns CORS) and
		// Content-Length (we recalculate it below after body modification).
		for k, vv := range rec.header {
			switch strings.ToLower(k) {
			case "access-control-allow-origin", "access-control-allow-methods",
				"access-control-allow-headers", "access-control-allow-credentials",
				"access-control-expose-headers", "access-control-max-age",
				"content-length":
				continue
			}
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		if statusCode == http.StatusNoContent {
			w.WriteHeader(statusCode)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(respBody)))
		w.WriteHeader(statusCode)
		_, _ = w.Write(respBody)
	}
}

// streamHandler validates the stream_token query param, injects X-Owner-ID via context,
// and forwards the SSE request to chatbot-service via the existing proxy.
func streamHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		jobID := chi.URLParam(r, "jobID")
		streamToken := r.URL.Query().Get("stream_token")

		if streamToken == "" {
			writeError(w, http.StatusUnauthorized, "missing stream_token")
			return
		}

		ownerID, err := auth.VerifyStreamToken(streamToken, jobID, cfg.JWTSecret)
		if err != nil {
			slog.Warn("invalid stream_token",
				"error", err,
				"job_id", jobID,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusUnauthorized, "invalid or expired stream token")
			return
		}

		// Put ownerID in context — proxy.Director picks it up and sets X-Owner-ID.
		ctx := middleware.WithOwnerID(r.Context(), ownerID)

		// Strip stream_token from the query before forwarding upstream.
		q := r.URL.Query()
		q.Del("stream_token")
		r.URL.RawQuery = q.Encode()

		upstream.ServeHTTP(w, r.WithContext(ctx))
	}
}

// notificationStreamScope is the jti claim for notification SSE tokens — a fixed
// scope instead of a job id, since the stream is per-owner rather than per-job.
const notificationStreamScope = "notifications"

// notificationStreamTokenHandler mints a short-lived stream_token so the browser
// can open the notification SSE stream (EventSource cannot send Authorization).
func notificationStreamTokenHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := middleware.ClaimsFromContext(r.Context())
		if claims == nil {
			writeError(w, http.StatusUnauthorized, "missing token claims")
			return
		}

		streamToken, err := auth.SignStreamToken(notificationStreamScope, claims.Subject, cfg.JWTSecret, cfg.JWTTTLSeconds)
		if err != nil {
			slog.Error("sign notification stream token", "error", err)
			writeError(w, http.StatusInternalServerError, "could not issue stream token")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"stream_token": streamToken})
	}
}

// notificationStreamHandler validates the stream_token query param, injects
// X-Owner-ID via context, and forwards the SSE request to notification-service.
func notificationStreamHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		streamToken := r.URL.Query().Get("stream_token")
		if streamToken == "" {
			writeError(w, http.StatusUnauthorized, "missing stream_token")
			return
		}

		ownerID, err := auth.VerifyStreamToken(streamToken, notificationStreamScope, cfg.JWTSecret)
		if err != nil {
			slog.Warn("invalid notification stream_token",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusUnauthorized, "invalid or expired stream token")
			return
		}

		// Put ownerID in context — proxy.Director picks it up and sets X-Owner-ID.
		ctx := middleware.WithOwnerID(r.Context(), ownerID)

		// Strip stream_token from the query before forwarding upstream.
		q := r.URL.Query()
		q.Del("stream_token")
		r.URL.RawQuery = q.Encode()

		upstream.ServeHTTP(w, r.WithContext(ctx))
	}
}

// realtimeStreamScope is the jti claim for realtime WebSocket tokens — a fixed
// scope, since the socket is per-owner rather than per-resource.
const realtimeStreamScope = "realtime"

// realtimeStreamTokenHandler mints the short-lived token that authorises the
// WebSocket. A WebSocket cannot set an Authorization header, exactly like
// EventSource, so this reuses the stream-token pattern already built twice —
// with a much shorter TTL, because the token travels in a query string.
func realtimeStreamTokenHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := middleware.ClaimsFromContext(r.Context())
		if claims == nil {
			writeError(w, http.StatusUnauthorized, "missing token claims")
			return
		}

		streamToken, err := auth.SignStreamToken(
			realtimeStreamScope, claims.Subject, cfg.JWTSecret, cfg.RealtimeStreamTTLSeconds,
		)
		if err != nil {
			slog.Error("sign realtime stream token", "error", err)
			writeError(w, http.StatusInternalServerError, "could not issue stream token")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"stream_token": streamToken,
			"expires_in":   cfg.RealtimeStreamTTLSeconds,
		})
	}
}

// originAllowed reports whether a WebSocket upgrade may proceed.
//
// This check exists because **a WebSocket upgrade gets no CORS preflight**: the
// browser sends no OPTIONS and honours no Access-Control-Allow-Origin, so the
// CORS middleware guarding every other route does nothing here. Without this,
// any page on the internet holding a stolen stream token could open the socket.
//
// An absent Origin is allowed: browsers always send one on an upgrade, so a
// request without it is a non-browser client (a server-side consumer, a probe),
// which is not the threat this guards against.
func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return true
	}
	for _, candidate := range allowed {
		if strings.EqualFold(strings.TrimSpace(candidate), origin) {
			return true
		}
	}
	return false
}

// realtimeSocketHandler validates Origin and the stream_token query param, then
// proxies the upgrade to realtime-service with X-Owner-ID injected.
func realtimeSocketHandler(cfg *config.Config, upstream http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !originAllowed(origin, cfg.CORSOrigins) {
			slog.Warn("rejected websocket upgrade from disallowed origin",
				"origin", origin,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusForbidden, "origin not allowed")
			return
		}

		streamToken := r.URL.Query().Get("stream_token")
		if streamToken == "" {
			writeError(w, http.StatusUnauthorized, "missing stream_token")
			return
		}

		ownerID, err := auth.VerifyStreamToken(streamToken, realtimeStreamScope, cfg.JWTSecret)
		if err != nil {
			slog.Warn("invalid realtime stream_token",
				"error", err,
				"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
			)
			writeError(w, http.StatusUnauthorized, "invalid or expired stream token")
			return
		}

		// Identity for the upstream comes from context — proxy.Director turns it
		// into X-Owner-ID and strips any client-supplied value.
		ctx := middleware.WithOwnerID(r.Context(), ownerID)

		// Strip the token before forwarding: realtime-service must never see it,
		// and it would otherwise be logged again upstream.
		q := r.URL.Query()
		q.Del("stream_token")
		r.URL.RawQuery = q.Encode()

		upstream.ServeHTTP(w, r.WithContext(ctx))
	}
}

// responseRecorder captures an upstream response for post-processing.
type responseRecorder struct {
	header     http.Header
	statusCode int
	body       bytes.Buffer
}

func (r *responseRecorder) Header() http.Header {
	return r.header
}

func (r *responseRecorder) WriteHeader(code int) {
	r.statusCode = code
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	return r.body.Write(b)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func publishLoginAsync(publisher *events.Publisher, params events.AuthLoginParams) {
	if publisher == nil {
		return
	}
	go func() {
		if err := publisher.PublishAuthLogin(params); err != nil {
			slog.Warn("failed to publish gateway.auth.login",
				"error", err,
				"owner_id", params.OwnerID,
				"correlation_id", params.CorrelationID,
				"provider", params.Provider,
			)
		}
	}()
}
