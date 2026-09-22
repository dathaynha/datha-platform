package logging

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestThrottledErrorHandlerReportsFirstAndSuppressesRepeats(t *testing.T) {
	var buf bytes.Buffer
	now := time.Now()
	h := &throttledErrorHandler{
		log:      slog.New(slog.NewJSONHandler(&buf, nil)),
		interval: time.Minute,
		now:      func() time.Time { return now },
	}

	for range 100 {
		h.Handle(errors.New("connection refused"))
	}

	lines := nonEmptyLines(buf.String())
	if len(lines) != 1 {
		t.Fatalf("want 1 line for 100 identical errors, got %d:\n%s", len(lines), buf.String())
	}
	if !strings.Contains(lines[0], "OTLP export failing") {
		t.Errorf("unexpected line: %s", lines[0])
	}
	if strings.Contains(lines[0], `"level":"INFO"`) {
		t.Error("an export failure must not be reported at INFO")
	}
}

func TestThrottledErrorHandlerReportsAgainAfterIntervalWithCount(t *testing.T) {
	var buf bytes.Buffer
	now := time.Now()
	h := &throttledErrorHandler{
		log:      slog.New(slog.NewJSONHandler(&buf, nil)),
		interval: time.Minute,
		now:      func() time.Time { return now },
	}

	h.Handle(errors.New("boom")) // reported
	for range 9 {
		h.Handle(errors.New("boom")) // suppressed
	}
	now = now.Add(time.Minute + time.Second)
	h.Handle(errors.New("boom")) // reported again

	lines := nonEmptyLines(buf.String())
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %d:\n%s", len(lines), buf.String())
	}

	var second map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatalf("second line not JSON: %v", err)
	}
	if got := second["suppressed"]; got != float64(9) {
		t.Errorf("suppressed = %v, want 9", got)
	}
}

// The spam this fixes only reaches the log because slog.SetDefault redirects
// the stdlib log that otel's default handler uses. Pin that mechanism, so a
// future Go or otel change that breaks the assumption is visible here.
func TestStdlibLogIsRedirectedThroughSlogAtInfo(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))

	log.Print(errors.New("dial tcp: connection refused"))

	if !strings.Contains(buf.String(), `"level":"INFO"`) {
		t.Fatalf("stdlib log no longer arrives via slog at INFO: %s", buf.String())
	}
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}
