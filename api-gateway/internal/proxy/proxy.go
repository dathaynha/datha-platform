package proxy

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"chatbot-playground/api-gateway/internal/middleware"
)

// New creates a reverse proxy to the given upstream base URL.
//
// stripSegment is a path segment to remove before forwarding, so each service
// can keep its own route structure unchanged. For example, with stripSegment "/chatbot":
//
//	/api/chatbot/v1/conversations → /api/v1/conversations (sent to chatbot-service)
//
// Pass an empty string to forward the path as-is.
func New(upstreamURL string, stripSegment string) (http.Handler, error) {
	target, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}

	rp := httputil.NewSingleHostReverseProxy(target)

	// Override the default Director to control headers and path precisely.
	defaultDirector := rp.Director
	rp.Director = func(req *http.Request) {
		defaultDirector(req)

		// Rewrite path by removing the service-specific segment.
		// e.g. /api/chatbot/v1/foo → /api/v1/foo
		if stripSegment != "" {
			req.URL.Path = strings.Replace(req.URL.Path, stripSegment, "", 1)
			if req.URL.RawPath != "" {
				req.URL.RawPath = strings.Replace(req.URL.RawPath, stripSegment, "", 1)
			}
		}

		// Propagate correlation ID downstream.
		if id := middleware.CorrelationIDFromContext(req.Context()); id != "" {
			req.Header.Set("X-Correlation-ID", id)
		}

		// Inject authenticated user identity so downstream services never need to
		// parse a JWT. Strip any client-supplied value first to prevent spoofing.
		req.Header.Del("X-Owner-ID")
		req.Header.Del("X-User-Email")
		req.Header.Del("X-User-Name")
		req.Header.Del("X-User-Picture")
		if claims := middleware.ClaimsFromContext(req.Context()); claims != nil {
			// Normal authenticated route: identity comes from the Bearer JWT.
			req.Header.Set("X-Owner-ID", claims.Subject)
			if claims.Email != "" {
				req.Header.Set("X-User-Email", claims.Email)
			}
			if claims.Name != "" {
				req.Header.Set("X-User-Name", claims.Name)
			}
			if claims.Picture != "" {
				req.Header.Set("X-User-Picture", claims.Picture)
			}
		} else if ownerID := middleware.OwnerIDFromContext(req.Context()); ownerID != "" {
			// Stream route: identity comes from a verified stream_token query param.
			req.Header.Set("X-Owner-ID", ownerID)
		}

		// Ensure the upstream sees the real client IP.
		if clientIP := req.RemoteAddr; clientIP != "" {
			req.Header.Set("X-Forwarded-For", clientIP)
		}

		// Remove the Host header so the upstream uses its own hostname.
		req.Host = target.Host
	}

	// Replace the default error handler so we never leak upstream stack traces.
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Error("upstream proxy error",
			"error", err,
			"path", r.URL.Path,
			"correlation_id", middleware.CorrelationIDFromContext(r.Context()),
		)
		http.Error(w, `{"error":"upstream unavailable"}`, http.StatusBadGateway)
		w.Header().Set("Content-Type", "application/json")
	}

	rp.ModifyResponse = func(resp *http.Response) error {
		// Strip upstream CORS headers — the gateway is the sole owner of CORS for all
		// public responses. Leaving upstream headers causes doubled values and browser errors.
		resp.Header.Del("Access-Control-Allow-Origin")
		resp.Header.Del("Access-Control-Allow-Methods")
		resp.Header.Del("Access-Control-Allow-Headers")
		resp.Header.Del("Access-Control-Allow-Credentials")
		resp.Header.Del("Access-Control-Expose-Headers")
		resp.Header.Del("Access-Control-Max-Age")

		// SSE streams must not be buffered — flush each chunk immediately.
		if resp.Header.Get("Content-Type") == "text/event-stream" {
			resp.Header.Del("Content-Length")
		}
		return nil
	}

	return rp, nil
}
