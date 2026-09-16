// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package telemetry

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/alibaba/open-code-review/internal/stdout"
)

func setupEnabledTelemetry(t *testing.T) {
	t.Helper()
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(resource.Default()))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(resource.Default()))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	tracerProvider = tp
	meterProvider = mp
	initialized = true
	shutdownFuncs = []func(context.Context) error{
		func(ctx context.Context) error { return tp.Shutdown(ctx) },
		func(ctx context.Context) error { return mp.Shutdown(ctx) },
	}
	initMetricsOnce = false
	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
		_ = mp.Shutdown(context.Background())
		tracerProvider = nil
		meterProvider = nil
		initialized = false
		shutdownFuncs = nil
		initMetricsOnce = false
	})
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStderr := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = oldStderr }()

	fn()
	_ = w.Close()

	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)
	return buf.String()
}

func TestEvent_Enabled(t *testing.T) {
	setupEnabledTelemetry(t)
	ctx := context.Background()
	Event(ctx, "test.event", attribute.String("key", "value"))
}

func TestEvent_Disabled(t *testing.T) {
	initialized = false
	shutdownFuncs = nil
	defer func() { initialized = false }()
	Event(context.Background(), "test.event")
}

func TestEvent_NilCtx(t *testing.T) {
	setupEnabledTelemetry(t)
	Event(nil, "test.event") //nolint:staticcheck
}

func TestEventf_Enabled(t *testing.T) {
	setupEnabledTelemetry(t)
	ctx := context.Background()
	Eventf(ctx, "test.eventf", "hello world", attribute.Int("count", 5))
}

func TestErrorEvent_Enabled(t *testing.T) {
	setupEnabledTelemetry(t)
	ctx := context.Background()
	ErrorEvent(ctx, "test.error", errors.New("something failed"), attribute.String("detail", "extra"))
}

func TestErrorEvent_NilErr(t *testing.T) {
	setupEnabledTelemetry(t)
	ctx := context.Background()
	ErrorEvent(ctx, "test.error", nil)
}

func TestErrorEvent_NilCtx(t *testing.T) {
	setupEnabledTelemetry(t)
	ErrorEvent(nil, "test.error", errors.New("fail")) //nolint:staticcheck
}

func TestErrorEvent_Disabled(t *testing.T) {
	initialized = false
	shutdownFuncs = nil
	defer func() { initialized = false }()
	ErrorEvent(context.Background(), "test.error", errors.New("fail"))
}

func TestPhaseEvent_Success(t *testing.T) {
	setupEnabledTelemetry(t)
	ctx := context.Background()
	PhaseEvent(ctx, "scan", "main.go", 500*time.Millisecond, nil)
}

func TestPhaseEvent_WithError(t *testing.T) {
	setupEnabledTelemetry(t)
	ctx := context.Background()
	PhaseEvent(ctx, "scan", "main.go", 500*time.Millisecond, errors.New("parse error"))
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	restore := stdout.Swap(&buf)
	defer restore()
	fn()
	return buf.String()
}

func TestPrintTraceSummary_WithTokenDetails(t *testing.T) {
	out := captureStdout(t, func() {
		PrintTraceSummary(TraceSummary{
			FilesReviewed: 5, CommentsGenerated: 10,
			InputTokens: 1000, OutputTokens: 200, TotalTokens: 1200,
			Duration: 3 * time.Second,
		})
	})
	want := "[ocr] Summary: 5 file(s) reviewed, 10 comment(s), ~1200 token(s) used (input: ~1000, output: ~200), 3s elapsed\n"
	if out != want {
		t.Errorf("PrintTraceSummary output = %q, want %q", out, want)
	}
}

func TestPrintTraceSummary_WithCacheTokens(t *testing.T) {
	out := captureStdout(t, func() {
		PrintTraceSummary(TraceSummary{
			FilesReviewed: 3, CommentsGenerated: 2,
			InputTokens: 500, OutputTokens: 100, TotalTokens: 600,
			CacheReadTokens: 200, CacheWriteTokens: 50,
			Duration: 2 * time.Second,
		})
	})
	want := "[ocr] Summary: 3 file(s) reviewed, 2 comment(s), ~600 token(s) used (input: ~500, output: ~100), cache(read: ~200, write: ~50), 2s elapsed\n"
	if out != want {
		t.Errorf("PrintTraceSummary output = %q, want %q", out, want)
	}
}

func TestPrintTraceSummary_NoTokenDetails(t *testing.T) {
	out := captureStdout(t, func() {
		PrintTraceSummary(TraceSummary{
			FilesReviewed: 2, CommentsGenerated: 1,
			TotalTokens: 500,
			Duration:    1 * time.Second,
		})
	})
	want := "[ocr] Summary: 2 file(s) reviewed, 1 comment(s), ~500 token(s) used, 1s elapsed\n"
	if out != want {
		t.Errorf("PrintTraceSummary output = %q, want %q", out, want)
	}
}

func TestPrintTraceSummary_WithSessionID(t *testing.T) {
	out := captureStdout(t, func() {
		PrintTraceSummary(TraceSummary{
			FilesReviewed: 5, CommentsGenerated: 10,
			InputTokens: 1000, OutputTokens: 200, TotalTokens: 1200,
			Duration:  3 * time.Second,
			SessionID: "3a7f2b1c-9d4e-4f8a-b2c1-6e7f8a9b0c1d",
		})
	})
	want := "[ocr] Summary: 5 file(s) reviewed, 10 comment(s), ~1200 token(s) used (input: ~1000, output: ~200), 3s elapsed\n" +
		"[ocr] Session: 3a7f2b1c-9d4e-4f8a-b2c1-6e7f8a9b0c1d\n"
	if out != want {
		t.Errorf("PrintTraceSummary output = %q, want %q", out, want)
	}
}

func TestPrintTraceSummary_WithoutSessionID(t *testing.T) {
	// An empty session ID exercises the omit path: no session line is printed.
	// The empty case arises when session persistence is unavailable, not from
	// preview mode (preview does not reach PrintTraceSummary).
	out := captureStdout(t, func() {
		PrintTraceSummary(TraceSummary{
			FilesReviewed: 2, CommentsGenerated: 1,
			TotalTokens: 500,
			Duration:    1 * time.Second,
		})
	})
	if strings.Contains(out, "Session:") {
		t.Errorf("expected no session line for empty session ID, got %q", out)
	}
}

func TestPrintToolCallStarted_WithArgs(t *testing.T) {
	PrintToolCallStarted("file_read", map[string]any{"path": "main.go"})
}

func TestPrintToolCallStarted_NoArgs(t *testing.T) {
	PrintToolCallStarted("list_files", nil)
}

func TestPrintToolCallFinished(t *testing.T) {
	PrintToolCallFinished("file_read", 123*time.Millisecond)
}

func TestPrintToolCallError(t *testing.T) {
	out := captureStderr(t, func() {
		PrintToolCallError("file_read", fmt.Errorf("permission denied"))
	})
	if !strings.Contains(out, "✘ file_read") {
		t.Errorf("expected tool name with X mark, got %q", out)
	}
	if !strings.Contains(out, "permission denied") {
		t.Errorf("expected error message, got %q", out)
	}
}

func TestFormatDuration(t *testing.T) {
	tests := []struct {
		dur  time.Duration
		want string
	}{
		{0, "0s"},
		{1500 * time.Millisecond, "1.5s"},
		{60 * time.Second, "1m0s"},
		{123 * time.Millisecond, "123ms"},
		{2*time.Minute + 30*time.Second, "2m30s"},
	}
	for _, tc := range tests {
		got := FormatDuration(tc.dur)
		if got != tc.want {
			t.Errorf("FormatDuration(%v) = %q, want %q", tc.dur, got, tc.want)
		}
	}
}

func TestSummarizeArgs(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"nil map", nil, ""},
		{"empty map", map[string]any{}, ""},
		{"path key returns quoted", map[string]any{"path": "foo/bar.go"}, `"foo/bar.go"`},
		{"search key returns quoted", map[string]any{"search": "hello"}, `"hello"`},
		{"query key returns quoted", map[string]any{"query": "world"}, `"world"`},
		{"pattern key returns quoted", map[string]any{"pattern": "*.go"}, `"*.go"`},
		{"generic short value", map[string]any{"foo": "bar"}, `foo="bar"`},
		{
			"long value truncated not dropped",
			map[string]any{"data": strings.Repeat("a", maxSummaryValueLen+10)},
			`data="` + strings.Repeat("a", maxSummaryValueLen) + `"…`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(tc.args)
			if got != tc.want {
				t.Errorf("summarizeArgs(%v) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}

// assertNoRawBytes fails when the rendered summary still carries a byte that a
// terminal acts on rather than displays: ESC introduces an ANSI CSI or OSC
// sequence, BEL terminates an OSC string, CR and LF end the console record.
func assertNoRawBytes(t *testing.T, got string) {
	t.Helper()
	for _, b := range []byte{0x1b, 0x07, 0x0d, 0x0a} {
		if strings.IndexByte(got, b) >= 0 {
			t.Errorf("summary %q still contains raw byte %#x", got, b)
		}
	}
}

// A CR/LF payload must not be able to end the console line: the model would
// otherwise append a second, forged "[ocr] ..." record (CWE-117). The generic
// key `search_text` is code_search's own argument name, the key the finding
// names, so this is the reported exposure exactly.
func TestSummarizeArgs_NewlinePayloadEscaped(t *testing.T) {
	got := summarizeArgs(map[string]any{"search_text": "a\r\n[ocr] Summary: forged"})
	assertNoRawBytes(t, got)
	want := `search_text="a\r\n[ocr] Summary: forged"`
	if got != want {
		t.Errorf("summarizeArgs = %q, want %q", got, want)
	}
}

// ESC-led sequences must reach the console as text, never as instructions to the
// terminal (CWE-150): CSI repaints or recolors the screen, OSC sets the window
// title and, on some terminals, can be made to echo back into the input.
func TestSummarizeArgs_TerminalEscapesEscaped(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{"ansi csi color sequence", "\x1b[31mred\x1b[0m", `search_text="\x1b[31mred\x1b[0m"`},
		{"osc window title sequence", "\x1b]0;title\x07", `search_text="\x1b]0;title\a"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(map[string]any{"search_text": tc.value})
			assertNoRawBytes(t, got)
			if got != tc.want {
				t.Errorf("summarizeArgs = %q, want %q", got, tc.want)
			}
		})
	}
}

// Every byte of a rendered value must be printable ASCII, which is what keeps a
// C1 control, a bidirectional override or a Unicode line separator from reaching
// the terminal in its raw form. strconv.Quote would pass all three through.
func TestSummarizeArgs_NonASCIIRenderedAsASCII(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
		side string
	}{
		// "caf\u00e9" and the three CJK runes are written as escapes so this
		// source file stays ASCII; the values themselves are non-ASCII.
		{"latin-1 accent", map[string]any{"search_text": "caf\u00e9"}, `search_text="caf\u00e9"`, "value"},
		{"cjk text", map[string]any{"search_text": "\u65e5\u672c\u8a9e"}, `search_text="\u65e5\u672c\u8a9e"`, "value"},
		{"c1 control", map[string]any{"search_text": "a\u009bx"}, `search_text="a\u009bx"`, "value"},
		{"bidi override", map[string]any{"search_text": "a\u202eb"}, `search_text="a\u202eb"`, "value"},
		{"unicode line separator", map[string]any{"search_text": "a\u2028b"}, `search_text="a\u2028b"`, "value"},
		{"astral plane rune", map[string]any{"search_text": "a\U0001f600b"}, `search_text="a\U0001f600b"`, "value"},
		// Invalid UTF-8 cannot survive JSON decoding, but fmt.Sprint of an
		// arbitrary value can produce it, and it must still render as ASCII.
		{"invalid utf-8 byte", map[string]any{"search_text": "a\xffb"}, `search_text="a\xffb"`, "value"},
		{"non-ascii key", map[string]any{"cl\u00e9": "v"}, `"cl\u00e9"="v"`, "key"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(tc.args)
			assertNoRawBytes(t, got)
			for i := 0; i < len(got); i++ {
				if got[i] >= 0x80 {
					t.Fatalf("summary %q is not ASCII: byte %#x at %d (%s side)", got, got[i], i, tc.side)
				}
			}
			if got != tc.want {
				t.Errorf("summarizeArgs = %q, want %q", got, tc.want)
			}
		})
	}
}

// Truncation is rune-counted, applies to a preferred key as well as a generic
// one, and marks what it cut with "…" placed after the closing quote so the
// quoted span always shows exactly what was retained.
func TestSummarizeArgs_ValueTruncatedAtRuneBound(t *testing.T) {
	longASCII := strings.Repeat("b", maxSummaryValueLen+25)
	// Multibyte runes: a byte-counted cut would split one and emit U+FFFD.
	longCJK := strings.Repeat("\u65e5", maxSummaryValueLen+5)

	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"generic key", map[string]any{"data": longASCII}, `data="` + strings.Repeat("b", maxSummaryValueLen) + `"…`},
		{"preferred key path", map[string]any{"path": longASCII}, `"` + strings.Repeat("b", maxSummaryValueLen) + `"…`},
		{
			"multibyte value",
			map[string]any{"path": longCJK},
			`"` + strings.Repeat(`\u65e5`, maxSummaryValueLen) + `"…`,
		},
		{"value exactly at the bound is not truncated", map[string]any{"path": strings.Repeat("b", maxSummaryValueLen)},
			`"` + strings.Repeat("b", maxSummaryValueLen) + `"`},
		{"one rune past the bound is truncated", map[string]any{"path": strings.Repeat("b", maxSummaryValueLen+1)},
			`"` + strings.Repeat("b", maxSummaryValueLen) + `"…`},
		// The prefix is sliced from the original bytes, so an invalid UTF-8 byte
		// survives as \xff instead of being folded into U+FFFD by a []rune round
		// trip. The replacement-rune assertion below is what would catch that.
		{
			"invalid utf-8 byte inside a truncated value",
			map[string]any{"path": "\xff" + strings.Repeat("c", maxSummaryValueLen+9)},
			`"\xff` + strings.Repeat("c", maxSummaryValueLen-1) + `"…`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(tc.args)
			assertNoRawBytes(t, got)
			if got != tc.want {
				t.Errorf("summarizeArgs = %q, want %q", got, tc.want)
			}
			if strings.Contains(got, "\ufffd") {
				t.Errorf("summary %q contains the replacement rune, so a rune was cut in half", got)
			}
		})
	}
}

// A credential-like key has its value replaced whatever its length. The short
// values here are the exposure the finding reports: under the previous
// 50-character cutoff every one of them was echoed verbatim.
func TestSummarizeArgs_SensitiveKeysRedacted(t *testing.T) {
	const secret = "s3cr3t-value"

	tests := []struct {
		name string
		key  string
		want string
	}{
		{"lowercase token", "token", "token=[REDACTED]"},
		{"snake case api key", "api_key", "api_key=[REDACTED]"},
		{"capitalized authorization", "Authorization", "Authorization=[REDACTED]"},
		{"header style api key", "X-Api-Key", "X-Api-Key=[REDACTED]"},
		{"password", "password", "password=[REDACTED]"},
		{"passwd", "passwd", "passwd=[REDACTED]"},
		{"passphrase", "passphrase", "passphrase=[REDACTED]"},
		{"camel case auth token", "authToken", "authToken=[REDACTED]"},
		{"embedded token word", "my_token", "my_token=[REDACTED]"},
		{"access key", "accessKey", "accessKey=[REDACTED]"},
		{"refresh token", "refresh-token", "refresh-token=[REDACTED]"},
		{"client secret", "client_secret", "client_secret=[REDACTED]"},
		{"private key", "privateKey", "privateKey=[REDACTED]"},
		{"bare secret", "secret", "secret=[REDACTED]"},
		{"credential", "credential", "credential=[REDACTED]"},
		{"cookie", "cookie", "cookie=[REDACTED]"},
		{"bearer", "bearer", "bearer=[REDACTED]"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(map[string]any{tc.key: secret})
			if got != tc.want {
				t.Errorf("summarizeArgs(%q) = %q, want %q", tc.key, got, tc.want)
			}
			if strings.Contains(got, secret) {
				t.Errorf("summary %q leaks the secret value", got)
			}
		})
	}
}

// The unquoted "[REDACTED]" marker stays distinguishable from a literal value of
// the same text, which renders quoted under a non-sensitive key.
func TestSummarizeArgs_LiteralRedactedValueIsQuoted(t *testing.T) {
	got := summarizeArgs(map[string]any{"note": redactedValue})
	if want := `note="[REDACTED]"`; got != want {
		t.Errorf("summarizeArgs = %q, want %q", got, want)
	}
}

// Keys are as model-controlled as values, so an injected key is escaped too and
// cannot end the line or drive the terminal.
func TestSummarizeArgs_KeysSanitized(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"newline injected key", map[string]any{"a\n[ocr] forged": "v"}, `"a\n[ocr] forged"="v"`},
		{"escape sequence in key", map[string]any{"k\x1b[2J": "v"}, `"k\x1b[2J"="v"`},
		{"empty key", map[string]any{"": "v"}, `""="v"`},
		{"key with space", map[string]any{"two words": "v"}, `"two words"="v"`},
		{
			"over-long key is quoted and truncated",
			map[string]any{strings.Repeat("k", maxSummaryValueLen+1): "v"},
			`"` + strings.Repeat("k", maxSummaryValueLen) + `"…="v"`,
		},
		{"plain key with dot dash underscore stays bare", map[string]any{"max-results_v1.2": "v"}, `max-results_v1.2="v"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(tc.args)
			assertNoRawBytes(t, got)
			if got != tc.want {
				t.Errorf("summarizeArgs = %q, want %q", got, tc.want)
			}
		})
	}
}

// Non-string JSON values arrive as bool, float64 or nil from parseToolArgs; each
// one is rendered through the same escaping path as a string.
func TestSummarizeArgs_NonStringValues(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"bool", map[string]any{"recursive": true}, `recursive="true"`},
		{"float", map[string]any{"ratio": 1.5}, `ratio="1.5"`},
		{"integral float from json", map[string]any{"limit": float64(10)}, `limit="10"`},
		{"nil", map[string]any{"filter": nil}, `filter="<nil>"`},
		{"nested map", map[string]any{"opts": map[string]any{"a": 1}}, `opts="map[a:1]"`},
		{"preferred key with non-string value", map[string]any{"path": 42}, `"42"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := summarizeArgs(tc.args)
			assertNoRawBytes(t, got)
			if got != tc.want {
				t.Errorf("summarizeArgs = %q, want %q", got, tc.want)
			}
		})
	}
}

// The property asserted at the real output boundary: whatever the model puts in
// a tool argument, PrintToolCallStarted emits exactly one console record and no
// byte the terminal acts on. This is the end-to-end form of CWE-117/CWE-150.
func TestPrintToolCallStarted_MaliciousArgsStayOneLine(t *testing.T) {
	// 47 characters, so the payload is inside the old 50-character cutoff: it is
	// the case that used to be printed verbatim rather than dropped.
	const payload = "a\r\n[ocr] Summary: 0 file(s) reviewed\x1b[31m\x1b]0;x\x07"

	out := captureStdout(t, func() {
		PrintToolCallStarted("code_search", map[string]any{"search_text": payload})
	})
	if n := strings.Count(out, "\n"); n != 1 {
		t.Errorf("output has %d newline(s), want exactly 1: %q", n, out)
	}
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("output does not end with a newline: %q", out)
	}
	for _, b := range []byte{0x1b, 0x07, 0x0d} {
		if strings.IndexByte(out, b) >= 0 {
			t.Errorf("output %q contains raw byte %#x", out, b)
		}
	}
	want := "[ocr]   ▶ code_search " +
		`search_text="a\r\n[ocr] Summary: 0 file(s) reviewed\x1b[31m\x1b]0;x\a"` + "\n"
	if out != want {
		t.Errorf("PrintToolCallStarted output = %q, want %q", out, want)
	}
}
