// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package gitcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test",
			"GIT_AUTHOR_EMAIL=test@test.com",
			"GIT_COMMITTER_NAME=test",
			"GIT_COMMITTER_EMAIL=test@test.com",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init")
	run("config", "user.email", "test@test.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", "hello.txt")
	run("commit", "-m", "init")
	return dir
}

func TestRunner_New(t *testing.T) {
	r := New(0)
	if r == nil {
		t.Fatal("New(0) returned nil")
	}
	if cap(r.sem) != defaultMaxConcurrent {
		t.Errorf("default capacity = %d, want %d", cap(r.sem), defaultMaxConcurrent)
	}

	r2 := New(4)
	if cap(r2.sem) != 4 {
		t.Errorf("capacity = %d, want 4", cap(r2.sem))
	}
}

func TestRunner_Run(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	out, err := r.Run(context.Background(), dir, "log", "--oneline")
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if !strings.Contains(out, "init") {
		t.Errorf("expected 'init' in output: %q", out)
	}
}

func TestRunner_Run_InvalidCommand(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	_, err := r.Run(context.Background(), dir, "nonexistent-subcommand")
	if err == nil {
		t.Error("expected error for invalid git subcommand")
	}
}

func TestRunner_Output(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	out, err := r.Output(context.Background(), dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatalf("Output error: %v", err)
	}
	hash := strings.TrimSpace(string(out))
	if len(hash) != 40 {
		t.Errorf("expected 40-char hash, got %q", hash)
	}
}

func TestRunner_RunSplit(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	stdout, stderr, err := r.RunSplit(context.Background(), dir, "status", "--short")
	if err != nil {
		t.Fatalf("RunSplit error: %v", err)
	}
	_ = stderr
	if strings.Contains(stdout, "??") {
		t.Errorf("unexpected untracked files in clean repo: %q", stdout)
	}
}

func TestRunner_Stream(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	var content string
	err := r.Stream(context.Background(), dir, func(stdout io.Reader) error {
		data, err := io.ReadAll(stdout)
		if err != nil {
			return err
		}
		content = string(data)
		return nil
	}, "show", "HEAD:hello.txt")
	if err != nil {
		t.Fatalf("Stream error: %v", err)
	}
	if content != "hello\n" {
		t.Errorf("Stream content = %q, want %q", content, "hello\n")
	}
}

func TestRunner_ContextCancelled(t *testing.T) {
	r := New(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := r.Run(ctx, ".", "status")
	if err == nil {
		t.Error("expected error for cancelled context")
	}
}

func TestRunner_AcquireTimeout(t *testing.T) {
	r := New(1)
	r.sem <- struct{}{}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := r.Run(ctx, ".", "status")
	if err == nil {
		t.Error("expected timeout error when semaphore full")
	}
}

// errStopAfterPrefix stands for the sentinel a bounded consumer returns once it
// holds the prefix of stdout it needs. Stream and StreamSplit must surface it
// unwrapped so that errors.Is matches it at the call site.
var errStopAfterPrefix = errors.New("stop after prefix")

// prefixReader wraps the stdout reader handed to a consumer and records how it
// was used: how many reads the consumer made, and whether any read arrived
// after the consumer declared itself finished, which would mean stdout kept
// being drained once the consumer had stopped.
type prefixReader struct {
	r        io.Reader
	reads    int
	finished bool
	lateRead bool
}

func (p *prefixReader) Read(b []byte) (int, error) {
	if p.finished {
		p.lateRead = true
	}
	p.reads++
	return p.r.Read(b)
}

// writeUntrackedMatches writes an untracked file of lines matching "needle",
// large enough that git's stdout exceeds the operating system pipe buffer, so a
// consumer that reads only a prefix leaves the subprocess blocked on a write.
func writeUntrackedMatches(t *testing.T, dir string, lines int) {
	t.Helper()
	var sb strings.Builder
	for i := 0; i < lines; i++ {
		fmt.Fprintf(&sb, "needle line %d\n", i)
	}
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(sb.String()), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestRunner_StreamSplit(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	var content string
	stderr, err := r.StreamSplit(context.Background(), dir, func(stdout io.Reader) error {
		data, readErr := io.ReadAll(stdout)
		if readErr != nil {
			return readErr
		}
		content = string(data)
		return nil
	}, "show", "HEAD:hello.txt")
	if err != nil {
		t.Fatalf("StreamSplit error: %v", err)
	}
	if content != "hello\n" {
		t.Errorf("StreamSplit content = %q, want %q", content, "hello\n")
	}
	if stderr != "" {
		t.Errorf("StreamSplit stderr = %q, want empty", stderr)
	}
}

func TestRunner_StreamSplit_StderrSeparate(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	consumed := false
	stderr, err := r.StreamSplit(context.Background(), dir, func(stdout io.Reader) error {
		data, readErr := io.ReadAll(stdout)
		if readErr != nil {
			return readErr
		}
		if len(data) != 0 {
			t.Errorf("stdout = %q, want empty for a failing command", data)
		}
		consumed = true
		return nil
	}, "cat-file", "-p", "nonexistent_ref_abc123")
	if err == nil {
		t.Fatal("expected error for a nonexistent object name")
	}
	if !consumed {
		t.Error("consume was not invoked")
	}
	if !strings.Contains(stderr, "nonexistent_ref_abc123") {
		t.Errorf("stderr = %q, want the git diagnostic naming the bad object", stderr)
	}

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("error = %T (%v), want *exec.ExitError", err, err)
	}
	if err.Error() != exitErr.Error() {
		t.Errorf("error = %q, want the bare wait error %q with stderr kept out of it", err.Error(), exitErr.Error())
	}
	if strings.Contains(err.Error(), "nonexistent_ref_abc123") {
		t.Errorf("error = %q, want no git diagnostic folded into it", err.Error())
	}
}

func TestRunner_StreamSplit_ConsumeErrorKillsProcess(t *testing.T) {
	dir := initRepo(t)
	writeUntrackedMatches(t, dir, 20000)
	r := New(2)

	const prefixLen = 64
	prefix := make([]byte, prefixLen)
	var tracker *prefixReader
	stderr, err := r.StreamSplit(context.Background(), dir, func(stdout io.Reader) error {
		tracker = &prefixReader{r: stdout}
		if _, readErr := io.ReadFull(tracker, prefix); readErr != nil {
			return readErr
		}
		tracker.finished = true
		return errStopAfterPrefix
	}, "grep", "-n", "--no-color", "--untracked", "-e", "needle")

	if !errors.Is(err, errStopAfterPrefix) {
		t.Fatalf("StreamSplit error = %v, want %v", err, errStopAfterPrefix)
	}
	if !strings.Contains(string(prefix), "needle") {
		t.Errorf("prefix = %q, want the first matched rows", prefix)
	}
	if tracker.reads == 0 {
		t.Error("consume made no read of stdout")
	}
	if tracker.lateRead {
		t.Error("stdout was read after consume returned; the bounded prefix is not respected")
	}
	// The wait error of the killed subprocess is discarded in favour of the
	// consumer's sentinel, and the killed git writes no diagnostic.
	if strings.Contains(stderr, "needle") {
		t.Errorf("stderr = %q, want no match rows", stderr)
	}
}

func TestRunner_StreamSplit_ExitStatusWithEmptyStderr(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	stderr, err := r.StreamSplit(context.Background(), dir, func(stdout io.Reader) error {
		data, readErr := io.ReadAll(stdout)
		if readErr != nil {
			return readErr
		}
		if len(data) != 0 {
			t.Errorf("stdout = %q, want empty when nothing matches", data)
		}
		return nil
	}, "grep", "-n", "--no-color", "-e", "no_such_string_xyz")

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("error = %T (%v), want *exec.ExitError", err, err)
	}
	// A caller classifies "nothing matched" by this pair: a non-zero exit
	// status with no diagnostic on stderr.
	if exitErr.ExitCode() != 1 {
		t.Errorf("exit code = %d, want 1", exitErr.ExitCode())
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty", stderr)
	}
}

func TestRunner_Stream_WaitErrorWithoutStderr(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	err := r.Stream(context.Background(), dir, func(stdout io.Reader) error {
		_, readErr := io.ReadAll(stdout)
		return readErr
	}, "grep", "-n", "--no-color", "-e", "no_such_string_xyz")

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("error = %T (%v), want *exec.ExitError", err, err)
	}
	if err.Error() != exitErr.Error() {
		t.Errorf("error = %q, want the wait error returned bare when stderr is empty", err.Error())
	}
}

func TestRunner_StreamSplit_Uninitialized(t *testing.T) {
	var r Runner

	consumed := false
	stderr, err := r.StreamSplit(context.Background(), t.TempDir(), func(io.Reader) error {
		consumed = true
		return nil
	}, "status", "--short")
	if err == nil {
		t.Fatal("expected error from a zero-value Runner")
	}
	if !strings.Contains(err.Error(), "not initialized") {
		t.Errorf("error = %v, want the not-initialized error", err)
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty when no subprocess starts", stderr)
	}
	if consumed {
		t.Error("consume ran although the semaphore was never acquired")
	}
}

func TestRunner_StreamSplit_ContextCancelled(t *testing.T) {
	dir := initRepo(t)
	r := New(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	consumed := false
	stderr, err := r.StreamSplit(ctx, dir, func(io.Reader) error {
		consumed = true
		return nil
	}, "status", "--short")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty when no subprocess starts", stderr)
	}
	if consumed {
		t.Error("consume ran although the context was already cancelled")
	}
}

func TestRunner_StreamSplit_StartFailure(t *testing.T) {
	r := New(2)
	missing := filepath.Join(t.TempDir(), "no_such_dir")

	consumed := false
	stderr, err := r.StreamSplit(context.Background(), missing, func(io.Reader) error {
		consumed = true
		return nil
	}, "status", "--short")
	if err == nil {
		t.Fatal("expected error when the working directory does not exist")
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty when the subprocess never starts", stderr)
	}
	if consumed {
		t.Error("consume ran although the subprocess never started")
	}
}

func TestRunner_Stream_ConsumeErrorReturnedUnwrapped(t *testing.T) {
	dir := initRepo(t)
	writeUntrackedMatches(t, dir, 20000)
	r := New(2)

	err := r.Stream(context.Background(), dir, func(stdout io.Reader) error {
		if _, readErr := io.ReadFull(stdout, make([]byte, 64)); readErr != nil {
			return readErr
		}
		return errStopAfterPrefix
	}, "grep", "-n", "--no-color", "--untracked", "-e", "needle")
	if !errors.Is(err, errStopAfterPrefix) {
		t.Fatalf("Stream error = %v, want %v", err, errStopAfterPrefix)
	}
	if err.Error() != errStopAfterPrefix.Error() {
		t.Errorf("Stream error = %q, want the sentinel unwrapped", err.Error())
	}
}

func TestRunner_Stream_WaitErrorIncludesStderr(t *testing.T) {
	dir := initRepo(t)
	r := New(2)

	err := r.Stream(context.Background(), dir, func(stdout io.Reader) error {
		_, readErr := io.ReadAll(stdout)
		return readErr
	}, "cat-file", "-p", "nonexistent_ref_abc123")
	if err == nil {
		t.Fatal("expected error for a nonexistent object name")
	}

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("error = %T (%v), want *exec.ExitError", err, err)
	}
	if !strings.HasPrefix(err.Error(), exitErr.Error()+": ") {
		t.Errorf("error = %q, want the wait error followed by the git diagnostic", err.Error())
	}
	if !strings.Contains(err.Error(), "nonexistent_ref_abc123") {
		t.Errorf("error = %q, want the git diagnostic folded in", err.Error())
	}
}
