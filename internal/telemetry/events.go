// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package telemetry

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/alibaba/open-code-review/internal/stdout"
)

// Event emits a structured event as a span with immediate end.
func Event(ctx context.Context, name string, attrs ...attribute.KeyValue) {
	if !IsEnabled() || ctx == nil {
		return
	}

	opts := []trace.SpanStartOption{trace.WithAttributes(attrs...)}
	_, span := otel.GetTracerProvider().Tracer(serviceName).Start(ctx, "event."+name, opts...)
	defer span.End()
}

// Eventf is like Event but includes a message attribute.
func Eventf(ctx context.Context, name string, msg string, attrs ...attribute.KeyValue) {
	Event(ctx, name, append(attrs, attribute.String("message", msg))...)
}

// ErrorEvent emits an error event with error status.
func ErrorEvent(ctx context.Context, name string, err error, extraAttrs ...attribute.KeyValue) {
	if !IsEnabled() || ctx == nil || err == nil {
		return
	}

	attrs := append(extraAttrs, attribute.String("error", err.Error()))
	_, span := otel.GetTracerProvider().Tracer(serviceName).Start(ctx, "event."+name,
		trace.WithAttributes(attrs...))
	span.SetStatus(codes.Error, err.Error())
	span.RecordError(err)
	span.End()
}

// PhaseEvent records a review phase completion with duration and optional error.
func PhaseEvent(ctx context.Context, phase string, filePath string, dur time.Duration, err error) {
	attrs := []attribute.KeyValue{
		attribute.String("phase", phase),
		attribute.String("file.path", filePath),
		attribute.Int64("duration_ms", dur.Milliseconds()),
	}
	if err != nil {
		ErrorEvent(ctx, "phase.completed", err, attrs...)
	} else {
		Event(ctx, "phase.completed", attrs...)
	}
}

// FormatDuration returns a human-readable duration string for console output.
func FormatDuration(dur time.Duration) string {
	return dur.Round(time.Millisecond).String()
}

// TraceSummary carries the metrics printed by PrintTraceSummary.
type TraceSummary struct {
	FilesReviewed     int64
	CommentsGenerated int64
	InputTokens       int64
	OutputTokens      int64
	TotalTokens       int64
	CacheReadTokens   int64
	CacheWriteTokens  int64
	Duration          time.Duration
	SessionID         string
}

// PrintTraceSummary prints a one-line summary of the review to stdout.
// If SessionID is non-empty, an "[ocr] Session: <id>" line follows the summary.
func PrintTraceSummary(s TraceSummary) {
	elapsed := s.Duration.Round(time.Second).String()
	if s.InputTokens > 0 || s.OutputTokens > 0 {
		base := fmt.Sprintf("[ocr] Summary: %d file(s) reviewed, %d comment(s), ~%d token(s) used (input: ~%d, output: ~%d)",
			s.FilesReviewed, s.CommentsGenerated, s.TotalTokens, s.InputTokens, s.OutputTokens)
		if s.CacheReadTokens > 0 || s.CacheWriteTokens > 0 {
			base += fmt.Sprintf(", cache(read: ~%d, write: ~%d)", s.CacheReadTokens, s.CacheWriteTokens)
		}
		fmt.Fprintf(stdout.Writer(), "%s, %s elapsed\n", base, elapsed)
	} else {
		fmt.Fprintf(stdout.Writer(), "[ocr] Summary: %d file(s) reviewed, %d comment(s), ~%d token(s) used, %s elapsed\n",
			s.FilesReviewed, s.CommentsGenerated, s.TotalTokens, elapsed)
	}
	if s.SessionID != "" {
		fmt.Fprintf(stdout.Writer(), "[ocr] Session: %s\n", s.SessionID)
	}
}

// PrintToolCallStarted prints a line when a tool begins execution.
// Args are summarized as key-value pairs (path, search terms, etc.).
// Example: [ocr]   ▶ file_read "internal/config/rules/loader.go"
func PrintToolCallStarted(toolName string, args map[string]any) {
	summary := summarizeArgs(args)
	if summary != "" {
		fmt.Fprintf(stdout.Writer(), "[ocr]   ▶ %s %s\n", toolName, summary)
	} else {
		fmt.Fprintf(stdout.Writer(), "[ocr]   ▶ %s\n", toolName)
	}
}

// PrintToolCallFinished prints a line when a tool finishes successfully.
// Example: [ocr]   ✔ file_read "internal/config/rules/loader.go" (12ms)
func PrintToolCallFinished(toolName string, dur time.Duration) {
	fmt.Fprintf(stdout.Writer(), "[ocr]   ✔ %s (%s)\n", toolName, FormatDuration(dur))
}

// PrintToolCallError prints a line when a tool fails.
// Example: [ocr]   ✘ file_read "internal/config/rules/loader.go" failed: permission denied
func PrintToolCallError(toolName string, err error) {
	fmt.Fprintf(os.Stderr, "[ocr]   ✘ %s failed: %v\n", toolName, err)
}

// maxSummaryValueLen bounds a single rendered argument value, counted in runes
// so multibyte text is never cut mid-character. It is a readability bound, not a
// security control: a value past it is truncated and still shown, because a
// summary line that silently dropped the one argument the user wanted to see is
// worse than a shortened one. Escaping, not length, is what makes a value safe
// to print.
const maxSummaryValueLen = 50

// redactedValue replaces the value of a credential-like argument key. It is
// emitted without surrounding quotes, unlike every value that is printed, so it
// cannot be confused with a literal argument value of "[REDACTED]" — that one
// renders as "\"[REDACTED]\"" and is visibly distinct on the console.
const redactedValue = "[REDACTED]"

// sensitiveArgKeyRe matches an argument key that names a credential, so the
// value is replaced rather than echoed. Its vocabulary starts from the one the
// session manifest's redaction floor uses (secretAssignmentRe in
// internal/session/manifest.go) and widens it with access_key, private_key,
// passphrase, credential, cookie and bearer. The two are independent literals
// in independent packages and neither enforces the other, deliberately: this
// one guards a progress line that a human skims, where over-redacting costs
// nothing, while sanitizeReason guards a persisted summary that has to stay
// legible and documents cookies and bodies as its callers' responsibility.
//
// The match is case-insensitive and deliberately unanchored, with no word
// boundaries: tool schemas and models spell these keys in every style, and
// "X-Api-Key", "authToken" and "my_token" all have to be caught, none of which a
// \b-delimited pattern matches. The cost is a false positive on a key that
// merely contains one of the words ("tokenizer"), which prints "[REDACTED]"
// instead of a harmless value — the safe direction to fail for a console line
// that a human reads and may paste elsewhere.
//
// Redaction is keyed on the name and not on the value because a credential
// carries no recognizable shape or length: a four-character password and a
// 200-character JWT are equally secret.
//
// The policy reaches the name of a top-level argument and nothing deeper. A
// credential a model buries inside a nested object value, or writes into a
// search pattern under a key such as search_text, is still escaped and length
// bounded but not replaced — the console line exists to tell the user which
// path was read and which text was searched, so a summary that redacted the
// search argument itself would report nothing. Value-shaped secret detection
// belongs to the persisted record rather than to this progress line, and lives
// in sanitizeReason (internal/session/manifest.go).
var sensitiveArgKeyRe = regexp.MustCompile(`(?i)(authorization|api[_-]?key|access[_-]?(key|token)|refresh[_-]?token|client[_-]?secret|private[_-]?key|passphrase|password|passwd|secret|token|credential|cookie|bearer)`)

// quoteForConsole renders s as a printable-ASCII double-quoted Go literal, built
// from at most the first maxSummaryValueLen runes of s. Escaping expands one
// rune to at most ten characters (\U0010ffff, for a rune outside the basic
// multilingual plane), so the rendered value is bounded by roughly ten times the
// rune bound and a single argument cannot flood the console.
//
// strconv.QuoteToASCII, rather than strconv.Quote, is what makes the result safe
// for a terminal: CR and LF become the two-character escapes \r and \n so the
// value cannot end the console line, ESC becomes \x1b so an ANSI CSI or OSC
// sequence is displayed instead of interpreted, and every rune at or above 0x80
// becomes a \u or \U escape so no non-ASCII byte — including a C1 control, a
// bidirectional override or a Unicode line separator — reaches the terminal. A
// byte that is not valid UTF-8 becomes \xXX. strconv.Quote escapes control
// characters but passes printable non-ASCII through unchanged, which is why it
// is not sufficient here.
//
// When s is longer than the bound, only the retained prefix is quoted and the
// truncation marker follows the closing quote. Keeping the marker outside the
// quoted span means the quotes always delimit exactly what was retained, so a
// reader can tell a truncated value from one that genuinely ends in the marker.
//
// The prefix is found by ranging over s and stopping at the byte offset of rune
// maxSummaryValueLen+1, which decodes no more of s than the preview needs and
// allocates nothing beyond the quoted result. Neither utf8.RuneCountInString nor
// a []rune conversion is used: both walk the whole string, and the conversion
// also allocates a rune slice for all of it, which an argument value has no
// upstream size limit to keep small — parseToolArgs (internal/llmloop/loop.go)
// unmarshals whatever the model sent. Slicing the original bytes also keeps an
// invalid UTF-8 byte as \xXX in the truncated branch, where a round trip through
// []rune would have replaced it with U+FFFD first.
func quoteForConsole(s string) string {
	runes := 0
	for i := range s {
		if runes == maxSummaryValueLen {
			return strconv.QuoteToASCII(s[:i]) + "…"
		}
		runes++
	}
	return strconv.QuoteToASCII(s)
}

// summarizeArgValue renders the value of argument key for console display,
// redacting it when the key names a credential and otherwise escaping it.
//
// fmt.Sprint is applied inside the non-sensitive branch only, so the value of a
// credential-like key is never even formatted into a string that could be
// retained by a later change to this function.
func summarizeArgValue(key string, v any) string {
	if sensitiveArgKeyRe.MatchString(key) {
		return redactedValue
	}
	return quoteForConsole(fmt.Sprint(v))
}

// isPlainArgKey reports whether k is safe and legible to print bare, i.e. a
// non-empty run of ASCII letters, digits, '_', '.' or '-' no longer than
// maxSummaryValueLen. Every key the tool schemas declare is of that shape, which
// keeps the common summary line free of quotes; the test is on the bytes rather
// than on runes because the accepted set is ASCII-only, making length in bytes
// and in runes the same for any key that passes.
func isPlainArgKey(k string) bool {
	if k == "" || len(k) > maxSummaryValueLen {
		return false
	}
	for i := 0; i < len(k); i++ {
		switch c := k[i]; {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '_', c == '.', c == '-':
		default:
			return false
		}
	}
	return true
}

// consoleArgKey renders an argument key for console display: bare when it is a
// plain identifier, quoted and escaped otherwise. The key is as model-controlled
// as the value — both are parsed from the tool call the model emitted — so a key
// carrying a newline or an escape sequence has to be neutralized exactly like a
// value.
func consoleArgKey(k string) string {
	if isPlainArgKey(k) {
		return k
	}
	return quoteForConsole(k)
}

// summarizeArgs extracts a concise key=value summary from tool arguments for
// console display. It picks the most human-readable fields depending on the
// argument keys: a path, search, query or pattern argument identifies the call
// on its own and is printed as a bare value, and anything else is accumulated as
// key=value pairs.
//
// Both the keys and the values come from the model's tool call (parsed by
// parseToolArgs in internal/llmloop/loop.go), so neither is ever printed raw.
// Everything is rendered through quoteForConsole, which escapes to printable
// ASCII: an unescaped CR or LF would end the console line and let the model
// forge a further "[ocr] ..." record that a human — or a log scraper — reads as
// this program's own output (CWE-117), and an unescaped ESC would drive the
// user's terminal through an ANSI or OSC sequence, repainting the screen or
// setting the window title (CWE-150).
//
// A credential-like key has its value redacted outright, decided by the key name
// because a credential can arrive at any length. That replaces the previous
// 50-character cutoff, which was never a security control: it echoed every short
// secret verbatim while silently dropping long legitimate values. Length is now
// handled by truncating inside quoteForConsole, so no argument is dropped.
func summarizeArgs(args map[string]any) string {
	parts := make([]string, 0, len(args))
	for k, v := range args {
		switch k {
		case "path":
			return summarizeArgValue(k, v)
		case "search", "query", "pattern":
			return summarizeArgValue(k, v)
		default:
			parts = append(parts, fmt.Sprintf("%s=%s", consoleArgKey(k), summarizeArgValue(k, v)))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " ")
}
