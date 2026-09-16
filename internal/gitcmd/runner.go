// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package gitcmd

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
)

const defaultMaxConcurrent = 16

// Runner limits the number of concurrent git subprocesses via an internal
// semaphore. All git command invocations should go through a shared Runner
// instance so that the total system-wide subprocess count stays bounded.
type Runner struct {
	sem chan struct{}
}

// New creates a Runner that allows at most maxConcurrent simultaneous git
// subprocesses. If maxConcurrent <= 0 the default (16) is used.
func New(maxConcurrent int) *Runner {
	if maxConcurrent <= 0 {
		maxConcurrent = defaultMaxConcurrent
	}
	return &Runner{sem: make(chan struct{}, maxConcurrent)}
}

func (r *Runner) acquire(ctx context.Context) error {
	if r.sem == nil {
		return fmt.Errorf("gitcmd.Runner not initialized; use gitcmd.New()")
	}
	select {
	case r.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Runner) release() { <-r.sem }

// Run executes a git command and returns the combined stdout+stderr output.
func (r *Runner) Run(ctx context.Context, repoDir string, args ...string) (string, error) {
	if err := r.acquire(ctx); err != nil {
		return "", err
	}
	defer r.release()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Output executes a git command and returns stdout only.
func (r *Runner) Output(ctx context.Context, repoDir string, args ...string) ([]byte, error) {
	if err := r.acquire(ctx); err != nil {
		return nil, err
	}
	defer r.release()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoDir
	return cmd.Output()
}

// RunSplit executes a git command and returns stdout and stderr separately.
func (r *Runner) RunSplit(ctx context.Context, repoDir string, args ...string) (string, string, error) {
	if err := r.acquire(ctx); err != nil {
		return "", "", err
	}
	defer r.release()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// stream is the subprocess plumbing shared by Stream and StreamSplit. It
// acquires the semaphore, starts a git command in repoDir, captures its stderr
// into an internal buffer and passes its stdout to consume as an io.Reader. The
// semaphore is held for the full duration of the subprocess.
//
// A consume that returns an error causes the subprocess to be killed before it
// is waited on, so a caller needing only a bounded prefix of the output can
// stop reading without leaving cmd.Wait() blocked on a pipe nobody drains.
//
// The three results are reported separately so each exported wrapper can shape
// them into its own error contract: stderr is everything the command wrote to
// its error stream, and is empty when the subprocess never started; consumeErr
// is consume's own error, unwrapped; runErr is the semaphore, stdout-pipe,
// start or cmd.Wait failure, unwrapped.
func (r *Runner) stream(ctx context.Context, repoDir string, consume func(stdout io.Reader) error, args ...string) (stderr string, consumeErr error, runErr error) {
	if err := r.acquire(ctx); err != nil {
		return "", nil, err
	}
	defer r.release()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoDir

	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, err
	}

	if err := cmd.Start(); err != nil {
		return "", nil, err
	}

	consumeErr = consume(stdoutPipe)
	if consumeErr != nil {
		// consume stopped early, so git may still be writing into a pipe that
		// nobody drains. The kill is what lets cmd.Wait() below return instead
		// of blocking on a full pipe; a kill failure only means the process has
		// already exited, which cmd.Wait() reports.
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()

	return stderrBuf.String(), consumeErr, waitErr
}

// Stream acquires the semaphore, starts a git command, and passes its stdout
// as an io.Reader to consume. The semaphore is held for the full duration.
// consume MUST fully drain the stdout reader before returning nil;
// otherwise cmd.Wait() may block or return a broken-pipe error.
func (r *Runner) Stream(ctx context.Context, repoDir string, consume func(stdout io.Reader) error, args ...string) error {
	stderr, consumeErr, runErr := r.stream(ctx, repoDir, consume, args...)

	if consumeErr != nil {
		return consumeErr
	}
	if runErr != nil {
		if len(stderr) > 0 {
			return fmt.Errorf("%w: %s", runErr, stderr)
		}
		return runErr
	}
	return nil
}

// StreamSplit acquires the semaphore, starts a git command, and passes its
// stdout as an io.Reader to consume while reporting the command's stderr
// separately from its error. The semaphore is held for the full duration of the
// subprocess. Callers that classify a git failure by its diagnostic text — an
// empty result versus a missing repository versus a usage error, say — use this
// instead of Stream, which folds stderr into the error it returns.
//
// consume either fully drains the stdout reader and returns nil, or returns an
// error, in which case the subprocess is killed before it is waited on. That
// kill is what lets a caller needing only a bounded prefix of the output stop
// reading: it stops git from producing the rest and keeps the wait from
// blocking on a pipe nobody drains. A bounded consumer therefore reads the
// prefix it wants and returns a sentinel error, for example:
//
//	stderr, err := r.StreamSplit(ctx, dir, func(stdout io.Reader) error {
//		sc := bufio.NewScanner(stdout)
//		for n := 0; n < maxRows && sc.Scan(); n++ {
//			rows = append(rows, sc.Text())
//		}
//		if sc.Err() != nil {
//			return sc.Err()
//		}
//		return errEnough // stops git; surfaced verbatim to the caller
//	}, "grep", "-n", "-e", pattern)
//
// The first result is everything the command wrote to stderr. It is returned on
// success, on a consume error and on a wait error alike, and is empty when the
// subprocess never started — a semaphore, stdout-pipe or start failure yields
// ("", err). The error is consume's error when consume failed, otherwise the
// cmd.Wait error, otherwise nil; neither is wrapped, so callers can match them
// with errors.Is and errors.As.
func (r *Runner) StreamSplit(ctx context.Context, repoDir string, consume func(stdout io.Reader) error, args ...string) (string, error) {
	stderr, consumeErr, runErr := r.stream(ctx, repoDir, consume, args...)

	if consumeErr != nil {
		return stderr, consumeErr
	}
	return stderr, runErr
}
