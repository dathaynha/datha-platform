package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The recorder must expose the underlying Flusher — hiding it stalls SSE
// responses in the server write buffer (regression, 2026-08-03).
var _ http.Flusher = (*responseRecorder)(nil)

func TestResponseRecorderForwardsFlush(t *testing.T) {
	underlying := httptest.NewRecorder()
	rec := &responseRecorder{ResponseWriter: underlying, status: http.StatusOK}

	rec.Flush()

	if !underlying.Flushed {
		t.Fatal("Flush was not forwarded to the underlying writer")
	}
}

func TestResponseRecorderFlushToleratesNonFlusher(t *testing.T) {
	rec := &responseRecorder{ResponseWriter: nonFlusherWriter{}, status: http.StatusOK}
	rec.Flush() // must not panic
}

func TestResponseRecorderUnwrap(t *testing.T) {
	underlying := httptest.NewRecorder()
	rec := &responseRecorder{ResponseWriter: underlying, status: http.StatusOK}

	if rec.Unwrap() != underlying {
		t.Fatal("Unwrap must return the wrapped writer for http.ResponseController")
	}
}

type nonFlusherWriter struct{}

func (nonFlusherWriter) Header() http.Header         { return http.Header{} }
func (nonFlusherWriter) Write(b []byte) (int, error) { return len(b), nil }
func (nonFlusherWriter) WriteHeader(int)             {}
