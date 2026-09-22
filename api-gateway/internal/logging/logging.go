package logging

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// How often a continuing OTLP export failure is repeated in the log.
const otlpErrorReportInterval = time.Minute

const serviceName = "api-gateway"

// Setup installs the default slog logger: JSON to stdout always, plus an OTLP
// push to the observability stack when OTEL_EXPORTER_OTLP_ENDPOINT is set.
// The returned shutdown flushes buffered log records; it is a no-op when OTLP
// is disabled. OTLP export failures never block or crash the gateway.
func Setup(ctx context.Context) (shutdown func(context.Context) error) {
	stdout := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	shutdown = func(context.Context) error { return nil }

	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		slog.SetDefault(slog.New(stdout))
		return shutdown
	}

	exporter, err := otlploghttp.New(ctx)
	if err != nil {
		slog.SetDefault(slog.New(stdout))
		slog.Warn("OTLP log exporter init failed; logging to stdout only", "error", err)
		return shutdown
	}

	// The SDK reports one error per failed export, and its default handler goes
	// through the stdlib log, which slog.SetDefault redirects into the handler
	// below — so unthrottled it buries every other line while the collector is
	// down. Writes to stdout only: reporting through the fanout would queue the
	// failure message to the exporter that just failed.
	otel.SetErrorHandler(&throttledErrorHandler{
		log:      slog.New(stdout),
		interval: otlpErrorReportInterval,
		now:      time.Now,
	})

	res, _ := resource.Merge(resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(serviceName)))

	provider := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
		sdklog.WithResource(res),
	)

	otlp := otelslog.NewHandler(serviceName, otelslog.WithLoggerProvider(provider))
	slog.SetDefault(slog.New(newFanoutHandler(stdout, otlp)))
	return provider.Shutdown
}

// fanoutHandler forwards every record to all wrapped handlers.
type fanoutHandler struct {
	handlers []slog.Handler
}

func newFanoutHandler(handlers ...slog.Handler) *fanoutHandler {
	return &fanoutHandler{handlers: handlers}
}

func (f *fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (f *fanoutHandler) Handle(ctx context.Context, rec slog.Record) error {
	var firstErr error
	for _, h := range f.handlers {
		if !h.Enabled(ctx, rec.Level) {
			continue
		}
		if err := h.Handle(ctx, rec.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (f *fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		next[i] = h.WithAttrs(attrs)
	}
	return &fanoutHandler{handlers: next}
}

func (f *fanoutHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		next[i] = h.WithGroup(name)
	}
	return &fanoutHandler{handlers: next}
}

// throttledErrorHandler reports OpenTelemetry errors at most once per interval,
// counting what it swallowed in between.
type throttledErrorHandler struct {
	log      *slog.Logger
	interval time.Duration
	now      func() time.Time

	mu         sync.Mutex
	last       time.Time
	suppressed int
}

func (h *throttledErrorHandler) Handle(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := h.now()
	if !h.last.IsZero() && now.Sub(h.last) < h.interval {
		h.suppressed++
		return
	}

	if h.suppressed > 0 {
		h.log.Warn("OTLP export failing", "error", err, "suppressed", h.suppressed)
	} else {
		h.log.Warn("OTLP export failing", "error", err)
	}
	h.last = now
	h.suppressed = 0
}
