// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package tool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/alibaba/open-code-review/internal/gitcmd"
)

func TestBuildGrepArgs_WorkspaceMode(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("myFunc", false, false, false, nil)

	assertContainsInOrder(t, args, "-e", "myFunc", "--")
	assertContains(t, args, "-i")
	assertContains(t, args, "--untracked")
	if idx := slices.Index(args, "--"); idx >= 0 {
		for i := 0; i < idx; i++ {
			if args[i] == "myFunc" && (i == 0 || args[i-1] != "-e") {
				t.Error("myFunc should only appear as argument to -e, not as positional")
			}
		}
	}
}

func TestBuildGrepArgs_CommitMode(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: "abc1234"})
	args := p.buildGrepArgs("myFunc", false, false, false, []string{"pkg/"})

	assertContainsInOrder(t, args, "-e", "myFunc", "abc1234", "--", "pkg/")
	assertNotContains(t, args, "--untracked")
	assertNotContains(t, args, "--end-of-options")
}

func TestBuildGrepArgs_RejectsOptionLikeRef(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: "-O./pwn.sh"})
	args := p.buildGrepArgs("myFunc", false, false, false, nil)
	if args != nil {
		t.Fatalf("expected buildGrepArgs to return nil for option-like ref, got %v", args)
	}
}

func TestGitGrep_RejectsOptionLikeRef(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: "-O./pwn.sh"})
	result, err := p.gitGrep(context.Background(), "myFunc", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result != "Error: ref must not start with '-'" {
		t.Fatalf("unexpected result: %s", result)
	}
}

func TestBuildGrepArgs_PatternStartingWithDash(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("-myOption", false, false, false, nil)

	idx := slices.Index(args, "-e")
	if idx < 0 || idx+1 >= len(args) || args[idx+1] != "-myOption" {
		t.Errorf("expected -e to immediately precede -myOption, got %v", args)
	}
}

func TestBuildGrepArgs_CaseSensitive(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("foo", true, false, false, nil)

	assertNotContains(t, args, "-i")
}

func TestBuildGrepArgs_CaseInsensitive(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("foo", false, false, false, nil)

	assertContains(t, args, "-i")
}

func TestBuildGrepArgs_PerlRegexp(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("foo", false, true, false, nil)

	assertContains(t, args, "-P")
	assertNotContains(t, args, "-F")
}

func TestBuildGrepArgs_FixedString(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("foo", false, false, false, nil)

	assertContains(t, args, "-F")
	assertNotContains(t, args, "-E")
	assertNotContains(t, args, "-P")
}

func setupTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("setup %v: %v\n%s", args, err, out)
		}
	}
	run("git", "init")
	run("git", "config", "user.email", "test@test.com")
	run("git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "hello.go"), []byte("package main\n\nfunc Hello() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "pkg"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pkg", "util.go"), []byte("package pkg\n\nfunc Util() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("git", "add", ".")
	run("git", "commit", "-m", "init")
	return dir
}

func getHeadCommit(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func TestGitGrep_WorkspaceMode_Found(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "Hello", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "hello.go") {
		t.Errorf("expected hello.go in result, got: %s", result)
	}
}

func TestGitGrep_WorkspaceMode_NoMatch(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "nonexistentXYZ", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches found" {
		t.Errorf("expected 'No matches found', got: %s", result)
	}
}

func TestGitGrep_CommitMode_Found(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: commit, Mode: ModeCommit})
	result, err := p.gitGrep(context.Background(), "Hello", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "hello.go") {
		t.Errorf("expected hello.go in result, got: %s", result)
	}
	if !strings.Contains(result, "Match lines: 1") {
		t.Errorf("expected 1 match line, got: %s", result)
	}
}

func TestGitGrep_CommitMode_NoMatch(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: commit, Mode: ModeCommit})
	result, err := p.gitGrep(context.Background(), "nonexistentXYZ", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches found" {
		t.Errorf("expected 'No matches found', got: %s", result)
	}
}

func TestGitGrep_CommitMode_WithPathspec(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: commit, Mode: ModeCommit})

	result, err := p.gitGrep(context.Background(), "Util", false, false, []string{"pkg/"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "util.go") {
		t.Errorf("expected util.go in result, got: %s", result)
	}

	result2, err2 := p.gitGrep(context.Background(), "Hello", false, false, []string{"pkg/"})
	if err2 != nil {
		t.Fatal(err2)
	}
	if result2 != "No matches found" {
		t.Errorf("expected 'No matches found' when pathspec excludes match, got: %s", result2)
	}
}

func TestGitGrep_OptionLikeRefDoesNotLaunchPager(t *testing.T) {
	dir := setupTestRepo(t)
	proofPath := filepath.Join(dir, "PROOF")
	pagerPath := filepath.Join(dir, "pwn.sh")
	if err := os.WriteFile(pagerPath, []byte("#!/bin/sh\nprintf pwned > PROOF\n"), 0755); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "-O./pwn.sh", Mode: ModeCommit})
	result, err := p.gitGrep(context.Background(), "Hello", false, false, []string{"hello.go"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result, "Error:") {
		t.Fatalf("expected git error for invalid ref, got: %s", result)
	}
	if _, err := os.Stat(proofPath); err == nil {
		t.Fatal("option-like ref launched pager and created proof file")
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestGitGrep_CommitMode_WithBadPathspec(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: commit, Mode: ModeCommit})

	result, err := p.gitGrep(context.Background(), "Hello", false, false, []string{"nonexistent/"})
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches found" {
		t.Errorf("expected 'No matches found' with bad pathspec, got: %s", result)
	}
}

func TestGitGrep_LiteralWithRegexMetaChars(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "Hello()", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "hello.go") {
		t.Errorf("expected hello.go in result for literal 'Hello()' search, got: %s", result)
	}
}

func TestGitGrep_CommitMode_LiteralWithRegexMetaChars(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: commit, Mode: ModeCommit})
	result, err := p.gitGrep(context.Background(), "Hello()", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "hello.go") {
		t.Errorf("expected hello.go in result for literal 'Hello()' search at commit, got: %s", result)
	}
}

func TestGitGrep_InvalidRef_ReturnsError(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "nonexistent_ref_abc123", Mode: ModeCommit})
	result, err := p.gitGrep(context.Background(), "Hello", false, false, nil)
	if err == nil {
		t.Fatal("expected invalid ref to return an error")
	}
	if result != "" {
		t.Errorf("expected empty result for invalid ref, got: %s", result)
	}
	if !strings.Contains(err.Error(), "git grep failed") {
		t.Errorf("expected git grep failure, got: %v", err)
	}
}

func TestGitGrep_PerlRegexp_InvalidPattern_ReturnsError(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "(unclosed", false, true, nil)
	if err == nil {
		t.Fatal("expected invalid perl regexp to return an error")
	}
	if result != "" {
		t.Errorf("expected empty result for invalid perl regexp, got: %s", result)
	}
	if !strings.Contains(err.Error(), "git grep failed") {
		t.Errorf("expected git grep failure, got: %v", err)
	}
}

func TestTrimGitUsage(t *testing.T) {
	tests := []struct {
		name   string
		stderr string
		want   string
	}{
		{
			name:   "English",
			stderr: "error: unknown option `max-count'\nusage: git grep [<options>]\n\n    --cached",
			want:   "error: unknown option `max-count'",
		},
		{
			name:   "Chinese",
			stderr: "\u9519\u8bef\uff1a\u672a\u77e5\u9009\u9879 `max-count'\n\u7528\u6cd5\uff1agit grep [<\u9009\u9879>]\n\n    --cached",
			want:   "\u9519\u8bef\uff1a\u672a\u77e5\u9009\u9879 `max-count'",
		},
		{
			name:   "French",
			stderr: "erreur : option inconnue `max-count'\nutilisation : git grep [<options>]\n\n    --cached",
			want:   "erreur : option inconnue `max-count'",
		},
		{
			name:   "Japanese",
			stderr: "\u30a8\u30e9\u30fc: \u4e0d\u660e\u306a\u30aa\u30d7\u30b7\u30e7\u30f3 `max-count'\n\u4f7f\u7528\u6cd5: git grep [<\u30aa\u30d7\u30b7\u30e7\u30f3>]\n\n    --cached",
			want:   "\u30a8\u30e9\u30fc: \u4e0d\u660e\u306a\u30aa\u30d7\u30b7\u30e7\u30f3 `max-count'",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := trimGitUsage(tt.stderr, 129); got != tt.want {
				t.Errorf("trimGitUsage() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTrimGitUsage_PreservesDiagnosticWithoutUsage(t *testing.T) {
	stderr := "fatal: ambiguous argument 'missing': unknown revision\nhint: verify the revision name"
	got := trimGitUsage(stderr, 128)
	if got != stderr {
		t.Errorf("trimGitUsage() = %q, want %q", got, stderr)
	}
}

func TestTrimGitUsage_WhitespaceOnly(t *testing.T) {
	if got := trimGitUsage(" \n\t", 129); got != "" {
		t.Errorf("trimGitUsage() = %q, want empty string", got)
	}
}

// TestGrepFailureClass verifies a git failure is reported as one of a fixed
// set of messages. git's own text is read to tell the failures apart and then
// discarded, because it carries the absolute path of the checkout and whatever
// the model put in its pattern, and this message reaches the model, the
// session record and the operator's terminal.
func TestGrepFailureClass(t *testing.T) {
	tests := []struct {
		name     string
		stderr   string
		exitCode int
		want     string
	}{
		{
			name:     "out-of-repository pathspec",
			stderr:   "fatal: /etc/hostname: '/etc/hostname' is outside repository at '/home/u/repo'",
			exitCode: 128,
			want:     "a file_pattern is outside the repository",
		},
		{
			name:     "plain directory",
			stderr:   "fatal: not a git repository (or any of the parent directories): .git",
			exitCode: 128,
			want:     "the directory is not a git repository",
		},
		{
			name:     "unresolvable revision",
			stderr:   "fatal: unable to resolve revision: nonexistent_ref_abc123",
			exitCode: 128,
			want:     "the requested revision could not be resolved",
		},
		{
			name:     "pattern git will not compile",
			stderr:   "fatal: -e option, '\x1b[31m(unclosed': missing terminating ] for character class",
			exitCode: 128,
			want:     "git rejected the search pattern",
		},
		{
			name:     "option git does not know",
			stderr:   "error: unknown option `max-count'\nusage: git grep [<options>]",
			exitCode: 129,
			want:     "git rejected the search options",
		},
		{
			name:     "pathspec that matched nothing",
			stderr:   "fatal: pathspec 'nonexistent/' did not match any file(s) known to git",
			exitCode: 128,
			want:     "a file_pattern did not match any file",
		},
		{
			name:     "failure git describes in a way this does not recognize",
			stderr:   "fatal: something at /home/u/repo went wrong",
			exitCode: 42,
			want:     "git exited with status 42",
		},
		{
			name:     "failure with no exit status at all",
			stderr:   "",
			exitCode: -1,
			want:     "git grep could not be completed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := grepFailureClass(trimGitUsage(tt.stderr, tt.exitCode), tt.exitCode)
			if got != tt.want {
				t.Errorf("grepFailureClass() = %q, want %q", got, tt.want)
			}
			if strings.Contains(got, "/home/u/repo") || strings.Contains(got, "\x1b") {
				t.Errorf("the message repeated git's own text: %q", got)
			}
		})
	}
}

// TestSanitizeErrorText verifies what happens to text that is not one of those
// fixed messages but still has to be reported -- a failure to start git or to
// read its output: the checkout path and any other absolute path are replaced,
// repository-relative paths survive because the model needs them, control
// characters are dropped and the text is flattened to one line.
func TestSanitizeErrorText(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/home/u/repo", Ref: ""})

	tests := []struct {
		name string
		text string
		want string
	}{
		{
			name: "checkout and absolute paths are replaced",
			text: "chdir /home/u/repo: no such file or directory (/etc/hostname)",
			want: "chdir <path>: no such file or directory (<path>)",
		},
		{
			name: "windows checkout paths are replaced",
			text: `chdir 'C:\Users\u\repo': no such file or directory`,
			want: "chdir '<path>': no such file or directory",
		},
		{
			name: "repository-relative paths are kept",
			text: "read internal/tool/code_search.go: input/output error",
			want: "read internal/tool/code_search.go: input/output error",
		},
		{
			name: "control characters are dropped and lines are flattened",
			text: "fork/exec \x1b[31mgit\x07: permission denied\nsee the log",
			want: "fork/exec [31mgit: permission denied see the log",
		},
		{name: "whitespace-only text says nothing", text: " \n\t"},
		{name: "control-only text says nothing", text: "\x1b\x07\x00"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := p.sanitizeErrorText(tt.text); got != tt.want {
				t.Errorf("sanitizeErrorText() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestSanitizeErrorText_BoundsLength verifies such text is shortened to
// gitGrepMaxDiagnosticBytes and marked, so a long message cannot spend the
// model's context.
func TestSanitizeErrorText_BoundsLength(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/home/u/repo", Ref: ""})

	got := p.sanitizeErrorText("chdir " + strings.Repeat("a", 4*gitGrepMaxDiagnosticBytes))
	if want := gitGrepMaxDiagnosticBytes + len(gitGrepTruncatedMarker); len(got) != want {
		t.Errorf("text is %d bytes, want %d", len(got), want)
	}
	if !strings.HasSuffix(got, gitGrepTruncatedMarker) {
		t.Error("shortened text is not marked as shortened")
	}
}

// TestGitGrep_StartFailureHidesRepositoryPath verifies a failure to run git at
// all is reported without the checkout path its cause names.
func TestGitGrep_StartFailureHidesRepositoryPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "gone")
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	result, err := p.gitGrep(context.Background(), "needle", false, false, nil)
	if err == nil {
		t.Fatalf("expected a missing working directory to fail, got result: %q", result)
	}
	msg := err.Error()
	if strings.Contains(msg, dir) {
		t.Errorf("the error disclosed the checkout path: %s", msg)
	}
	if !strings.Contains(msg, "<path>") {
		t.Errorf("expected the path to be replaced, got: %s", msg)
	}
}

// TestGitGrep_FailureHidesRepositoryPath verifies a git failure still names the
// failure but not the location of the checkout. An absolute file_pattern is
// model input that makes git report the worktree's path, and that error is
// forwarded to the model, recorded in the session and printed to the terminal.
func TestGitGrep_FailureHidesRepositoryPath(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	result, err := p.gitGrep(context.Background(), "Hello", false, false, []string{"/etc/hostname"})
	if err == nil {
		t.Fatalf("expected an out-of-repository pathspec to fail, got result: %q", result)
	}
	msg := err.Error()
	if !strings.Contains(msg, "git grep failed") {
		t.Errorf("expected a git grep failure, got: %v", err)
	}
	if strings.Contains(msg, dir) {
		t.Errorf("the error disclosed the checkout path: %s", msg)
	}
	if strings.Contains(msg, "/etc/hostname") {
		t.Errorf("the error disclosed an absolute path: %s", msg)
	}
	if !strings.Contains(msg, "a file_pattern is outside the repository") {
		t.Errorf("expected the failure class, got: %s", msg)
	}
}

// TestGitGrep_FailureStripsControlCharacters verifies git's echo of a
// model-supplied pattern cannot carry an escape sequence into the error, which
// is printed to the operator's terminal and stored in the session record.
func TestGitGrep_FailureStripsControlCharacters(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	result, err := p.gitGrep(context.Background(), "(\x1b[31munclosed", false, true, nil)
	if err == nil {
		t.Fatalf("expected an invalid perl regexp to fail, got result: %q", result)
	}
	msg := err.Error()
	if !strings.Contains(msg, "git grep failed") {
		t.Errorf("expected a git grep failure, got: %v", err)
	}
	for _, r := range msg {
		if unicode.IsControl(r) {
			t.Errorf("the error carried control rune %q: %q", r, msg)
		}
	}
}

func assertContains(t *testing.T, args []string, val string) {
	t.Helper()
	if !slices.Contains(args, val) {
		t.Errorf("expected args to contain %q, got %v", val, args)
	}
}

func assertNotContains(t *testing.T, args []string, val string) {
	t.Helper()
	if slices.Contains(args, val) {
		t.Errorf("expected args NOT to contain %q, got %v", val, args)
	}
}

func assertContainsInOrder(t *testing.T, args []string, vals ...string) {
	t.Helper()
	idx := 0
	for _, a := range args {
		if idx < len(vals) && a == vals[idx] {
			idx++
		}
	}
	if idx != len(vals) {
		t.Errorf("expected args to contain %v in order, got %v (matched up to index %d)", vals, args, idx)
	}
}

func TestGitGrep_WorkspaceMode_UntrackedFile(t *testing.T) {
	dir := setupTestRepo(t)
	untrackedDir := filepath.Join(dir, "newpkg")
	if err := os.MkdirAll(untrackedDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(untrackedDir, "untracked.go"), []byte("package newpkg\n\nfunc UntrackedFunc() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "UntrackedFunc", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "untracked.go") {
		t.Errorf("expected untracked.go in result, got: %s", result)
	}
}

// TestBuildGrepArgs_MaxCountLookahead pins the one-row lookahead in the
// --max-count argument: git's --max-count limits matches PER FILE, not in
// total, so gitGrep enforces the total cap itself and asks git for one row
// beyond gitGrepMaxCount per file to tell a genuinely truncated result from
// exactly gitGrepMaxCount matches.
func TestBuildGrepArgs_MaxCountLookahead(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("foo", false, false, false, nil)

	assertContainsInOrder(t, args, "--max-count", strconv.Itoa(gitGrepMaxCount+1))
}

// countMatchLines counts the result rows of a gitGrep result, i.e. the
// "<lineNum>|<content>" lines. The "File:" and "Match lines:" headers, the
// truncation note and the blank separators between file blocks carry no line
// number before a '|' and are therefore not counted.
func countMatchLines(t *testing.T, result string) int {
	t.Helper()
	count := 0
	for _, line := range strings.Split(result, "\n") {
		pipe := strings.Index(line, "|")
		if pipe < 0 {
			continue
		}
		if _, err := strconv.Atoi(line[:pipe]); err != nil {
			continue
		}
		count++
	}
	return count
}

// TestGitGrep_CapsTotalResultsAcrossFiles verifies the total-result contract:
// gitGrep emits at most gitGrepMaxCount rows however many files a pattern
// matched in, and prefixes the truncation note exactly when the raw output
// exceeded that cap. The cap is the provider's to enforce because --max-count
// bounds matches per file, not in total, and the one-row lookahead is what
// separates a genuinely truncated result from exactly gitGrepMaxCount matches.
func TestGitGrep_CapsTotalResultsAcrossFiles(t *testing.T) {
	tests := []struct {
		name      string
		files     int
		hitsPer   int
		wantLines int
		wantNote  bool
	}{
		{
			name:      "three files of sixty hits are capped at one hundred",
			files:     3,
			hitsPer:   60,
			wantLines: gitGrepMaxCount,
			wantNote:  true,
		},
		{
			name:      "exactly one hundred hits in one file pass through without a note",
			files:     1,
			hitsPer:   gitGrepMaxCount,
			wantLines: gitGrepMaxCount,
			wantNote:  false,
		},
		{
			name:      "one hundred and one hits in one file are capped with a note",
			files:     1,
			hitsPer:   gitGrepMaxCount + 1,
			wantLines: gitGrepMaxCount,
			wantNote:  true,
		},
		{
			name:      "forty hits across two files pass through without a note",
			files:     2,
			hitsPer:   20,
			wantLines: 40,
			wantNote:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := setupTestRepo(t)
			// The needle files stay untracked on purpose: workspace mode
			// reaches them through --untracked, and "needle" matches nothing
			// in the committed fixtures, so the totals asserted below are
			// exactly files x hitsPer.
			for i := 0; i < tt.files; i++ {
				path := filepath.Join(dir, "needle"+strconv.Itoa(i)+".txt")
				if err := os.WriteFile(path, []byte(strings.Repeat("needle line\n", tt.hitsPer)), 0644); err != nil {
					t.Fatal(err)
				}
			}

			p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
			result, err := p.gitGrep(context.Background(), "needle", true, false, nil)
			if err != nil {
				t.Fatal(err)
			}

			if got := countMatchLines(t, result); got != tt.wantLines {
				t.Errorf("emitted %d match lines, want %d", got, tt.wantLines)
			}
			hasNote := strings.HasPrefix(result, "Note: The results have been truncated.")
			if hasNote != tt.wantNote {
				t.Errorf("truncation note present = %v, want %v; output:\n%s", hasNote, tt.wantNote, result)
			}
		})
	}
}

// countingReader records how many bytes a reader was actually asked for, so a
// test can tell a reader that stops from one that drains its input.
type countingReader struct {
	r    io.Reader
	read int
}

func (c *countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.read += n
	return n, err
}

// endlessRowReader is a single result row that never ends: it always fills the
// buffer and never reports EOF, so a test can drive the total-byte ceiling
// without materializing megabytes of fixture.
type endlessRowReader struct {
	read int
}

func (e *endlessRowReader) Read(b []byte) (int, error) {
	for i := range b {
		b[i] = 'y'
	}
	e.read += len(b)
	return len(b), nil
}

// grepRowsFixture renders n result rows in git grep's `<file>:<line>:<content>`
// form, the shape readGrepRows parses its ceilings against.
func grepRowsFixture(t *testing.T, n int) string {
	t.Helper()
	var sb strings.Builder
	for i := 1; i <= n; i++ {
		sb.WriteString(fmt.Sprintf("a.txt:%d:needle line\n", i))
	}
	return sb.String()
}

// TestReadGrepRows verifies the row ceiling on git grep's stdout: at most
// gitGrepMaxCount+1 rows are returned, the extra row being the lookahead that
// tells a truncated result from exactly gitGrepMaxCount matches, and bounded
// reports whether reading stopped before the end of the output.
func TestReadGrepRows(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		wantRows    int
		wantBounded bool
	}{
		{name: "fewer rows than the cap are all returned", input: grepRowsFixture(t, 40), wantRows: 40},
		{name: "exactly the cap is not bounded", input: grepRowsFixture(t, gitGrepMaxCount), wantRows: gitGrepMaxCount},
		{name: "one row past the cap is bounded", input: grepRowsFixture(t, gitGrepMaxCount+1), wantRows: gitGrepMaxCount + 1, wantBounded: true},
		{name: "far more rows stop at the lookahead row", input: grepRowsFixture(t, 5000), wantRows: gitGrepMaxCount + 1, wantBounded: true},
		{name: "a final row without a newline is returned", input: "a.txt:1:needle line", wantRows: 1},
		{name: "empty output yields no rows", input: "", wantRows: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows, bounded, err := readGrepRows(strings.NewReader(tt.input), nil)
			if err != nil {
				t.Fatalf("readGrepRows() error: %v", err)
			}
			if len(rows) != tt.wantRows {
				t.Errorf("read %d rows, want %d", len(rows), tt.wantRows)
			}
			if bounded != tt.wantBounded {
				t.Errorf("bounded = %v, want %v", bounded, tt.wantBounded)
			}
			for _, row := range rows {
				if row == "" {
					t.Error("an empty row was returned; only result lines are rows")
				}
			}
		})
	}
}

// TestReadGrepRows_StopsReadingPastTheCap verifies the reader does not drain
// the subprocess: once the lookahead row is in hand it stops, so the rows a
// broad search would go on producing are never read into memory.
func TestReadGrepRows_StopsReadingPastTheCap(t *testing.T) {
	input := grepRowsFixture(t, 200000)
	counting := &countingReader{r: strings.NewReader(input)}

	rows, bounded, err := readGrepRows(counting, nil)
	if err != nil {
		t.Fatalf("readGrepRows() error: %v", err)
	}
	if !bounded {
		t.Error("bounded = false, want true for output past the cap")
	}
	if len(rows) != gitGrepMaxCount+1 {
		t.Errorf("read %d rows, want %d", len(rows), gitGrepMaxCount+1)
	}
	if counting.read > gitGrepReadBufferBytes {
		t.Errorf("read %d of %d bytes, want at most one %d-byte buffer fill",
			counting.read, len(input), gitGrepReadBufferBytes)
	}
}

// TestReadGrepRows_BoundsRowBytes verifies the per-row ceiling: a matched line
// longer than gitGrepMaxLineBytes keeps its head, is marked as shortened, and
// does not disturb the rows around it.
func TestReadGrepRows_BoundsRowBytes(t *testing.T) {
	long := "a.txt:1:" + strings.Repeat("x", 4*gitGrepMaxLineBytes) + "\n"
	rows, bounded, err := readGrepRows(strings.NewReader(long+"b.txt:2:short\n"), nil)
	if err != nil {
		t.Fatalf("readGrepRows() error: %v", err)
	}
	if bounded {
		t.Error("bounded = true, want false: the output ended on its own")
	}
	if len(rows) != 2 {
		t.Fatalf("read %d rows, want 2", len(rows))
	}
	if want := gitGrepMaxLineBytes + len(gitGrepTruncatedMarker); len(rows[0]) != want {
		t.Errorf("over-long row kept %d bytes, want %d", len(rows[0]), want)
	}
	if !strings.HasSuffix(rows[0], gitGrepTruncatedMarker) {
		t.Errorf("over-long row is not marked as shortened: %q", rows[0][len(rows[0])-40:])
	}
	if rows[1] != "b.txt:2:short" {
		t.Errorf("row after the over-long one = %q, want %q", rows[1], "b.txt:2:short")
	}
}

// TestReadGrepRows_RowAtTheByteCeilingIsComplete verifies the boundary of that
// ceiling: a row whose content is exactly gitGrepMaxLineBytes long lost
// nothing but its terminator, so it is returned whole and unmarked, while one
// byte more is cut and marked.
func TestReadGrepRows_RowAtTheByteCeilingIsComplete(t *testing.T) {
	prefix := "a.txt:1:"
	exact := prefix + strings.Repeat("x", gitGrepMaxLineBytes-len(prefix))
	if len(exact) != gitGrepMaxLineBytes {
		t.Fatalf("fixture is %d bytes, want %d", len(exact), gitGrepMaxLineBytes)
	}

	rows, _, err := readGrepRows(strings.NewReader(exact+"\n"), nil)
	if err != nil {
		t.Fatalf("readGrepRows() error: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("read %d rows, want 1", len(rows))
	}
	if rows[0] != exact {
		t.Errorf("a row of exactly %d bytes was altered: kept %d bytes, marked = %v",
			gitGrepMaxLineBytes, len(rows[0]), strings.HasSuffix(rows[0], gitGrepTruncatedMarker))
	}

	oneMore, _, err := readGrepRows(strings.NewReader(exact+"y\n"), nil)
	if err != nil {
		t.Fatalf("readGrepRows() error: %v", err)
	}
	if len(oneMore) != 1 || !strings.HasSuffix(oneMore[0], gitGrepTruncatedMarker) {
		t.Errorf("a row one byte over the ceiling is not marked as shortened: %v", oneMore)
	}
}

// TestReadGrepRows_BoundsTotalBytes verifies the total-byte ceiling: a row that
// never ends stops the read at gitGrepMaxReadBytes instead of growing with it,
// and the head that was kept is still reported, marked as shortened.
func TestReadGrepRows_BoundsTotalBytes(t *testing.T) {
	endless := &endlessRowReader{}

	rows, bounded, err := readGrepRows(endless, nil)
	if err != nil {
		t.Fatalf("readGrepRows() error: %v", err)
	}
	if !bounded {
		t.Error("bounded = false, want true for a row past the read ceiling")
	}
	if len(rows) != 1 {
		t.Fatalf("read %d rows, want 1", len(rows))
	}
	if !strings.HasSuffix(rows[0], gitGrepTruncatedMarker) {
		t.Error("the kept head of an endless row is not marked as shortened")
	}
	if limit := gitGrepMaxReadBytes + gitGrepReadBufferBytes; endless.read > limit {
		t.Errorf("read %d bytes, want at most %d", endless.read, limit)
	}
}

// TestReadGrepRows_PropagatesReadError verifies a failure on the stdout stream
// is surfaced rather than reported as the end of the results.
func TestReadGrepRows_PropagatesReadError(t *testing.T) {
	want := errors.New("stdout broke")
	rows, bounded, err := readGrepRows(io.MultiReader(
		strings.NewReader("a.txt:1:needle line\n"),
		&failingReader{err: want},
	), nil)
	if !errors.Is(err, want) {
		t.Fatalf("readGrepRows() error = %v, want %v", err, want)
	}
	if bounded {
		t.Error("bounded = true, want false on a read failure")
	}
	if len(rows) != 1 {
		t.Errorf("read %d rows, want the 1 row that arrived before the failure", len(rows))
	}
}

// failingReader fails on the first read, standing in for a stdout stream that
// breaks mid-result.
type failingReader struct {
	err error
}

func (f *failingReader) Read([]byte) (int, error) { return 0, f.err }

// TestReadGrepRows_WithheldRowsDoNotSpendTheCap verifies a row the filter
// rejects is dropped as it is read and does not count against the cap: the
// files after a heavily matching withheld path still get the whole budget.
func TestReadGrepRows_WithheldRowsDoNotSpendTheCap(t *testing.T) {
	var input strings.Builder
	for i := 1; i <= 5*gitGrepMaxCount; i++ {
		input.WriteString(fmt.Sprintf("secret.txt:%d:needle line\n", i))
	}
	for i := 1; i <= gitGrepMaxCount+1; i++ {
		input.WriteString(fmt.Sprintf("keep.go:%d:needle line\n", i))
	}

	keep := func(row string) bool { return !strings.HasPrefix(row, "secret.txt:") }
	rows, bounded, err := readGrepRows(strings.NewReader(input.String()), keep)
	if err != nil {
		t.Fatalf("readGrepRows() error: %v", err)
	}
	if !bounded {
		t.Error("bounded = false, want true: a reportable row past the cap was available")
	}
	if len(rows) != gitGrepMaxCount+1 {
		t.Fatalf("read %d reportable rows, want %d", len(rows), gitGrepMaxCount+1)
	}
	for _, row := range rows {
		if !strings.HasPrefix(row, "keep.go:") {
			t.Fatalf("a withheld row was returned: %q", row)
		}
	}
}

// TestGitGrep_SecretFileDoesNotSpendResultBudget verifies the secret-path
// policy costs the model nothing: a credential file whose matches exceed the
// cap is withheld without consuming the cap, so the reportable files are still
// returned in full rather than replaced by a truncation note.
func TestGitGrep_SecretFileDoesNotSpendResultBudget(t *testing.T) {
	dir := setupTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"),
		[]byte(strings.Repeat("API_TOKEN=needle\n", 5*gitGrepMaxCount)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.go"),
		[]byte(strings.Repeat("// needle\n", 60)), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "needle", true, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result, ".env") || strings.Contains(result, "API_TOKEN") {
		t.Errorf("a credential file reached the result:\n%s", result)
	}
	if !strings.Contains(result, grepSecretWithheldNote) {
		t.Errorf("expected the withheld note, got:\n%s", result)
	}
	if !strings.Contains(result, "Match lines: 60") {
		t.Errorf("expected all 60 reportable matches from keep.go, got:\n%s", result)
	}
	if got := countMatchLines(t, result); got != 60 {
		t.Errorf("emitted %d match lines, want 60", got)
	}
	if strings.HasPrefix(result, "Note: The results have been truncated.") {
		t.Errorf("results below the cap were reported as truncated:\n%s", result)
	}
}

// TestParseGrepRow verifies how a raw result row is read in each search mode,
// and which rows are not results at all.
func TestParseGrepRow(t *testing.T) {
	tests := []struct {
		name        string
		row         string
		hasRef      bool
		wantPath    string
		wantLine    int
		wantContent string
		wantParsed  bool
	}{
		{
			name:        "workspace row",
			row:         "internal/tool/code_search.go:42:\tneedle := true",
			wantPath:    "internal/tool/code_search.go",
			wantLine:    42,
			wantContent: "\tneedle := true",
			wantParsed:  true,
		},
		{
			name:        "ref row keeps the path after the ref",
			row:         "abc1234:internal/tool/code_search.go:42:\tneedle := true",
			hasRef:      true,
			wantPath:    "internal/tool/code_search.go",
			wantLine:    42,
			wantContent: "\tneedle := true",
			wantParsed:  true,
		},
		{
			name:        "content keeps its own colons",
			row:         "a.go:7:m := map[string]string{\"k\": \"v\"}",
			wantPath:    "a.go",
			wantLine:    7,
			wantContent: "m := map[string]string{\"k\": \"v\"}",
			wantParsed:  true,
		},
		{
			// The only reading of this row puts the line number in the third
			// field, so the path is the two fields before it.
			name:        "path with a colon is read as the path",
			row:         "a:b.go:3:needle",
			wantPath:    "a:b.go",
			wantLine:    3,
			wantContent: "needle",
			wantParsed:  true,
		},
		{
			// Two readings are possible and the first is displayed: a path
			// without colons is the ordinary case, and reading this row the
			// other way would mis-split every match whose text contains
			// `:<digits>:`.
			name:        "ambiguous row is displayed as its first reading",
			row:         "a.go:42:see other.go:7:here",
			wantPath:    "a.go",
			wantLine:    42,
			wantContent: "see other.go:7:here",
			wantParsed:  true,
		},
		{name: "binary notice is not a result", row: "Binary file a.bin matches"},
		{name: "non-numeric line number is not a result", row: "a.go:x:needle"},
		{name: "empty row is not a result", row: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, lineNum, content, parsed := parseGrepRow(tt.row, tt.hasRef)
			if parsed != tt.wantParsed {
				t.Fatalf("parsed = %v, want %v", parsed, tt.wantParsed)
			}
			if !tt.wantParsed {
				return
			}
			if path != tt.wantPath || lineNum != tt.wantLine || content != tt.wantContent {
				t.Errorf("parseGrepRow() = (%q, %d, %q), want (%q, %d, %q)",
					path, lineNum, content, tt.wantPath, tt.wantLine, tt.wantContent)
			}
		})
	}
}

// TestGitGrep_TruncationNoteStatesWhatWasKept verifies the note counts the
// rows the model actually received. The cap is what it states when the cap is
// what stopped the read; when the byte ceiling stopped it first, fewer rows
// survive and the note says so rather than claiming the full hundred.
func TestGitGrep_TruncationNoteStatesWhatWasKept(t *testing.T) {
	dir := setupTestRepo(t)
	// One matching line so long that reading it exhausts the byte ceiling
	// before a second row can be read.
	long := "needle " + strings.Repeat("z", gitGrepMaxReadBytes+gitGrepReadBufferBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "huge.txt"), []byte(long+"needle second\n"), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "needle", true, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	shown := countMatchLines(t, result)
	if shown >= gitGrepMaxCount {
		t.Fatalf("expected the byte ceiling to stop the read well below the cap, got %d rows", shown)
	}
	want := fmt.Sprintf("Note: The results have been truncated. Only showing first %d results.\n", shown)
	if !strings.HasPrefix(result, want) {
		t.Errorf("note does not state the %d rows kept; result starts:\n%s", shown, result[:min(len(result), 200)])
	}
}

// TestGitGrep_BoundsLongResultLine verifies a matched line longer than
// gitGrepMaxLineBytes reaches the model shortened and marked as such, so a
// single generated or minified line cannot fill the model's context.
func TestGitGrep_BoundsLongResultLine(t *testing.T) {
	dir := setupTestRepo(t)
	long := "needle " + strings.Repeat("z", 8*gitGrepMaxLineBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "long.txt"), []byte(long), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "needle", true, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, gitGrepTruncatedMarker) {
		t.Errorf("expected the shortened-row marker in the result, got %d bytes", len(result))
	}
	limit := gitGrepMaxLineBytes + len(gitGrepTruncatedMarker)
	for _, row := range strings.Split(result, "\n") {
		if len(row) > limit {
			t.Errorf("result row is %d bytes, want at most %d", len(row), limit)
		}
	}
}

// TestGitGrep_WithRunner_CapsTotalResults verifies the shared-runner path is
// capped like the direct one: stdout is streamed through the runner and the
// provider stops git once the lookahead row is in hand.
func TestGitGrep_WithRunner_CapsTotalResults(t *testing.T) {
	dir := setupTestRepo(t)
	for i := 0; i < 3; i++ {
		path := filepath.Join(dir, "needle"+strconv.Itoa(i)+".txt")
		if err := os.WriteFile(path, []byte(strings.Repeat("needle line\n", 60)), 0644); err != nil {
			t.Fatal(err)
		}
	}

	runner := gitcmd.New(4)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace, Runner: runner})
	result, err := p.gitGrep(context.Background(), "needle", true, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := countMatchLines(t, result); got != gitGrepMaxCount {
		t.Errorf("emitted %d match lines, want %d", got, gitGrepMaxCount)
	}
	if !strings.HasPrefix(result, "Note: The results have been truncated.") {
		t.Errorf("expected the truncation note, got:\n%s", result)
	}
}

// TestGitGrep_NonGitDirectoryFallback verifies code_search works in a plain
// (non-git) directory by retrying git grep in --no-index mode instead of
// failing with git's exit 128, while still honoring .gitignore.
func TestGitGrep_NonGitDirectoryFallback(t *testing.T) {
	dir := t.TempDir() // plain dir, no `git init`

	write := func(rel, content string) {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("server.go", "package main\n\nfunc Handler() {}\n")
	write("internal/svc.go", "package internal\n\nfunc Handler() {}\n")
	write(".gitignore", "node_modules/\n")
	write("node_modules/lib.js", "function Handler() {}\n") // excluded by .gitignore

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	out, err := p.gitGrep(context.Background(), "Handler", false, false, nil)
	if err != nil {
		t.Fatalf("gitGrep should not error in a non-git dir, got: %v", err)
	}
	if !strings.Contains(out, "server.go") || !strings.Contains(out, "internal/svc.go") {
		t.Errorf("expected matches in tracked-like files, got:\n%s", out)
	}
	if strings.Contains(out, "node_modules") {
		t.Errorf("node_modules should be excluded via --exclude-standard, got:\n%s", out)
	}
}

// TestGitGrep_NonGitDirectoryNoMatch verifies the no-match path in a non-git
// dir returns the sentinel rather than an error.
func TestGitGrep_NonGitDirectoryNoMatch(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	out, err := p.gitGrep(context.Background(), "nonexistentXYZ", false, false, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "No matches found" {
		t.Errorf("expected 'No matches found', got: %q", out)
	}
}

// TestGitGrep_WithholdsSecretPathMatches verifies the secret-path policy on
// results: a match inside a credential file is not reported, the output states
// that matches were withheld and why, and matches outside the denylist are
// returned as usual. git grep reaches an untracked, non-ignored credential
// file as readily as any other, and a reported row would be sent to the model
// and persisted in the session record.
func TestGitGrep_WithholdsSecretPathMatches(t *testing.T) {
	dir := setupTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("API_TOKEN=needle-value\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.go"),
		[]byte("package main\n\n// needle-value is read from the environment\n"), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "needle-value", true, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result, ".env") || strings.Contains(result, "API_TOKEN") {
		t.Errorf("a credential file reached the result:\n%s", result)
	}
	if !strings.Contains(result, grepSecretWithheldNote) {
		t.Errorf("expected the withheld note, got:\n%s", result)
	}
	if !strings.Contains(result, "config.go") {
		t.Errorf("expected config.go in the result, got:\n%s", result)
	}
}

// TestGitGrep_WithholdsSecretPathWithColons verifies the secret-path policy
// reads a row whose path is ambiguous the strict way. A colon is legal in a
// git path, so `safe:123:dir/.env:1:TOKEN=x` names either `safe` at line 123
// or `safe:123:dir/.env` at line 1, and only the second reading is on the
// denylist: the row must be withheld rather than reported on the strength of
// the reading that happens to be allowed.
func TestGitGrep_WithholdsSecretPathWithColons(t *testing.T) {
	dir := setupTestRepo(t)
	weird := filepath.Join(dir, "safe:123:dir")
	if err := os.MkdirAll(weird, 0o755); err != nil {
		t.Skipf("this filesystem does not allow a colon in a path: %v", err)
	}
	if err := os.WriteFile(filepath.Join(weird, ".env"), []byte("API_TOKEN=needle-value\n"), 0600); err != nil {
		t.Skipf("this filesystem does not allow a colon in a path: %v", err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	result, err := p.gitGrep(context.Background(), "needle-value", true, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result, "API_TOKEN") || strings.Contains(result, ".env") {
		t.Errorf("a credential file with a colon in its path reached the result:\n%s", result)
	}
	if !strings.Contains(result, grepSecretWithheldNote) {
		t.Errorf("expected the withheld note, got:\n%s", result)
	}
}

// TestGrepRowReadings verifies every path a raw row could be naming is offered
// to the policy, since the colon that separates git's fields can also be part
// of the path itself. The formatter takes the first of these readings and the
// policy takes all of them, so this is the one scan both depend on.
func TestGrepRowReadings(t *testing.T) {
	tests := []struct {
		name   string
		row    string
		hasRef bool
		want   []string
	}{
		{
			name: "ordinary row names one path",
			row:  "internal/tool/code_search.go:42:needle",
			want: []string{"internal/tool/code_search.go"},
		},
		{
			name: "colons in the path give every reading",
			row:  "safe:123:dir/.env:1:API_TOKEN=needle",
			want: []string{"safe", "safe:123:dir/.env"},
		},
		{
			name:   "ref mode skips the ref and reads the rest",
			row:    "abc1234:safe:123:dir/.env:1:API_TOKEN=needle",
			hasRef: true,
			want:   []string{"safe", "safe:123:dir/.env"},
		},
		{
			name: "content that looks like a field is offered too",
			row:  "a.go:42:see other.go:7:here",
			want: []string{"a.go", "a.go:42:see other.go"},
		},
		{name: "binary notice names nothing", row: "Binary file a.bin matches"},
		{name: "empty row names nothing", row: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, reading := range grepRowReadings(tt.row, tt.hasRef) {
				got = append(got, reading.path)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("grepRowReadings() paths = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestCodeSearchProvider_RowVerdict verifies the strictest reading of an
// ambiguous row is the one that counts, and that an unambiguous row is
// unaffected.
func TestCodeSearchProvider_RowVerdict(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "regular.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/hostname", filepath.Join(dir, "link.txt")); err != nil {
		t.Skipf("symlinks are unavailable on this filesystem: %v", err)
	}
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	tests := []struct {
		name string
		row  string
		want grepPathVerdict
	}{
		{name: "regular file is reported", row: "regular.go:1:package main", want: grepPathAllowed},
		{name: "credential file is withheld", row: ".env:1:TOKEN=x", want: grepPathSecret},
		{
			name: "credential file hidden behind colons is withheld",
			row:  "safe:123:dir/.env:1:TOKEN=x",
			want: grepPathSecret,
		},
		{name: "row that is not a result is reported", row: "Binary file a.bin matches", want: grepPathAllowed},
		{name: "non-regular path is withheld", row: "link.txt:1:needle", want: grepPathIrregular},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := p.rowVerdict(tt.row, false, make(map[string]grepPathVerdict)); got != tt.want {
				t.Errorf("rowVerdict(%q) = %d, want %d", tt.row, got, tt.want)
			}
		})
	}
}

// TestCodeSearchProvider_RowVerdictStrictestReadingWins verifies the strictest
// reading of an ambiguous row decides it even when an earlier reading is
// allowed. `safe:9:link:1:needle` names either `safe` at line 9 or
// `safe:9:link` at line 1; the first path does not exist, so on its own it
// would be reported, while the second is a symlink and must not be.
func TestCodeSearchProvider_RowVerdictStrictestReadingWins(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("/etc/hostname", filepath.Join(dir, "safe:9:link")); err != nil {
		t.Skipf("colon-named symlinks are unavailable on this filesystem: %v", err)
	}
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	row := "safe:9:link:1:needle"
	if got := p.rowVerdict(row, false, make(map[string]grepPathVerdict)); got != grepPathIrregular {
		t.Errorf("rowVerdict(%q) = %d, want %d", row, got, grepPathIrregular)
	}
}

// TestLineNumberValue verifies what the row scan accepts as the field git
// writes for a line number, and the value it reads from it. Only digits
// qualify: a signed or spaced number would be accepted by strconv.Atoi but is
// not something git emits, and treating it as the line number would end a path
// reading in the wrong place and hide the credential path that follows it.
func TestLineNumberValue(t *testing.T) {
	tests := []struct {
		field     string
		want      int
		wantIsNum bool
	}{
		{field: "1", want: 1, wantIsNum: true},
		{field: "4096", want: 4096, wantIsNum: true},
		{field: "007", want: 7, wantIsNum: true},
		{field: ""},
		{field: "-1"},
		{field: "+1"},
		{field: " 1"},
		{field: "1a"},
		{field: "１"}, // allow-non-english: fixture exercises a non-ASCII digit
		{field: strings.Repeat("9", grepMaxLineNumberDigits), want: 999999999999999999, wantIsNum: true},
		{field: strings.Repeat("9", grepMaxLineNumberDigits+1)},
	}

	for _, tt := range tests {
		got, gotIsNum := lineNumberValue(tt.field)
		if gotIsNum != tt.wantIsNum || got != tt.want {
			t.Errorf("lineNumberValue(%q) = (%d, %v), want (%d, %v)",
				tt.field, got, gotIsNum, tt.want, tt.wantIsNum)
		}
	}
}

// TestCodeSearchProvider_StartAndReadFailures verifies both of the paths that
// still have to carry text out of the provider. A failure to run git, or to
// read what it wrote, is named for what it is and its cause is redacted; when
// redaction leaves nothing to say, the bare failure is reported rather than an
// error with an empty tail.
func TestCodeSearchProvider_StartAndReadFailures(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/home/u/repo", Ref: "", Mode: ModeWorkspace})

	tests := []struct {
		name    string
		got     error
		wantMsg string
	}{
		{
			name:    "start failure names the failure and redacts its cause",
			got:     p.startFailure(errors.New("chdir /home/u/repo/gone: no such file or directory")),
			wantMsg: "git grep could not be started: chdir <path>/gone: no such file or directory",
		},
		{
			name:    "start failure with nothing left to say is reported bare",
			got:     p.startFailure(errors.New("\x1b\x00")),
			wantMsg: "git grep could not be started",
		},
		{
			name:    "read failure names the failure and redacts its cause",
			got:     p.readFailure(errors.New("read |0: file already closed")),
			wantMsg: "git grep output could not be read: read |0: file already closed",
		},
		{
			name:    "read failure with nothing left to say is reported bare",
			got:     p.readFailure(errors.New("\x07")),
			wantMsg: "git grep output could not be read",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got == nil {
				t.Fatal("expected an error")
			}
			if tt.got.Error() != tt.wantMsg {
				t.Errorf("error = %q, want %q", tt.got.Error(), tt.wantMsg)
			}
		})
	}
}

// TestCodeSearchProvider_FailuresPreserveContextIdentity verifies the caller's
// own cancellation keeps its identity through both wrappers. gitGrep maps a
// cancelled context itself, and errors.Is is how its callers tell an abandoned
// search from a broken one, so neither wrapper may absorb it.
func TestCodeSearchProvider_FailuresPreserveContextIdentity(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/home/u/repo", Ref: "", Mode: ModeWorkspace})

	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		if got := p.startFailure(fmt.Errorf("exec: %w", cause)); !errors.Is(got, cause) {
			t.Errorf("startFailure lost %v, got %v", cause, got)
		}
		if got := p.readFailure(fmt.Errorf("read: %w", cause)); !errors.Is(got, cause) {
			t.Errorf("readFailure lost %v, got %v", cause, got)
		}
	}
}

// TestCodeSearchProvider_PathVerdict verifies the per-path policy behind those
// notes: credential paths are withheld by the built-in denylist in every mode,
// a worktree entry that is not a regular file is withheld by containment, a
// regular file is reported, a path git named but that cannot be stat'd is
// reported because git read its bytes from the repository, and a ref search
// skips the worktree check because its content comes from the object store.
func TestCodeSearchProvider_PathVerdict(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "regular.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/hostname", filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	workspace := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})
	atRef := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "abc1234", Mode: ModeCommit})

	tests := []struct {
		name string
		p    *CodeSearchProvider
		path string
		want grepPathVerdict
	}{
		{name: "regular file is reported", p: workspace, path: "regular.go", want: grepPathAllowed},
		{name: "credential file is withheld", p: workspace, path: ".env", want: grepPathSecret},
		{name: "credential file is withheld at a ref too", p: atRef, path: ".ssh/id_rsa", want: grepPathSecret},
		{name: "symlink is withheld", p: workspace, path: "link.txt", want: grepPathIrregular},
		{name: "directory is withheld", p: workspace, path: "sub", want: grepPathIrregular},
		{name: "unstattable path is reported", p: workspace, path: "gone.go", want: grepPathAllowed},
		{name: "ref search skips the worktree check", p: atRef, path: "link.txt", want: grepPathAllowed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.p.pathVerdict(tt.path); got != tt.want {
				t.Errorf("pathVerdict(%q) = %d, want %d", tt.path, got, tt.want)
			}
		})
	}
}

// TestGrepPolicyNotes verifies the note prefix states each policy that
// withheld rows, and nothing when none did.
func TestGrepPolicyNotes(t *testing.T) {
	tests := []struct {
		name       string
		secret     bool
		irregular  bool
		wantSecret bool
		wantIrreg  bool
	}{
		{name: "nothing withheld"},
		{name: "credential file withheld", secret: true, wantSecret: true},
		{name: "non-regular path withheld", irregular: true, wantIrreg: true},
		{name: "both withheld", secret: true, irregular: true, wantSecret: true, wantIrreg: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := grepPolicyNotes(tt.secret, tt.irregular)
			if strings.Contains(got, grepSecretWithheldNote) != tt.wantSecret {
				t.Errorf("secret note present = %v, want %v; notes: %q", !tt.wantSecret, tt.wantSecret, got)
			}
			if strings.Contains(got, grepIrregularWithheldNote) != tt.wantIrreg {
				t.Errorf("irregular note present = %v, want %v; notes: %q", !tt.wantIrreg, tt.wantIrreg, got)
			}
			if !tt.wantSecret && !tt.wantIrreg && got != "" {
				t.Errorf("notes = %q, want empty when nothing was withheld", got)
			}
		})
	}
}

func TestCodeSearchProvider_Tool(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp"})
	if p.Tool() != CodeSearch {
		t.Errorf("Tool() = %v, want CodeSearch", p.Tool())
	}
}

func TestCodeSearchProvider_Execute_BlankSearchText(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp"})
	got, err := p.Execute(context.Background(), map[string]any{"search_text": "  "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "Error: search_text is blank" {
		t.Errorf("Execute() = %q, want blank error", got)
	}
}

func TestCodeSearchProvider_Execute_Found(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text": "Hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "hello.go") {
		t.Errorf("expected hello.go in result, got: %s", got)
	}
}

func TestCodeSearchProvider_Execute_PropagatesGitFailure(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "nonexistent_ref_abc123", Mode: ModeCommit})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text": "Hello",
	})
	if err == nil {
		t.Fatal("expected git grep failure to propagate from Execute")
	}
	if got != "" {
		t.Errorf("expected empty result on git grep failure, got: %s", got)
	}
	if !strings.Contains(err.Error(), "git grep failed") {
		t.Errorf("expected git grep failure, got: %v", err)
	}
}

func TestCodeSearchProvider_Execute_WithFilePatterns(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text":   "Util",
		"file_patterns": []any{"pkg/"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "util.go") {
		t.Errorf("expected util.go in result, got: %s", got)
	}
}

func TestCodeSearchProvider_Execute_RejectsTraversalPattern(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})
	tests := []struct {
		name    string
		pattern string
		want    string
	}{
		{name: "leading parent", pattern: "../pkg", want: "Error: file_patterns must not contain .."},
		{name: "middle parent", pattern: "pkg/../internal", want: "Error: file_patterns must not contain .."},
		{name: "trailing parent", pattern: "pkg/..", want: "Error: file_patterns must not contain .."},
		{
			// git accepts a magic signature in front of the path, so the
			// traversal check has to read past it: every form below is the
			// path `../pkg` as far as git is concerned.
			name:    "parent behind a long magic signature",
			pattern: ":(exclude)../pkg",
			want:    "Error: file_patterns must not contain ..",
		},
		{
			name:    "parent behind a multi-keyword magic signature",
			pattern: ":(exclude,top)../pkg",
			want:    "Error: file_patterns must not contain ..",
		},
		{
			name:    "parent behind a short exclude signature",
			pattern: ":!../pkg",
			want:    "Error: file_patterns must not contain ..",
		},
		{
			name:    "parent behind a short top signature",
			pattern: ":/../pkg",
			want:    "Error: file_patterns must not contain ..",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := p.Execute(context.Background(), map[string]any{
				"search_text":   "Hello",
				"file_patterns": []any{test.pattern},
			})
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Errorf("Execute() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCodeSearchProvider_Execute_AllowsDoubleDotInFilename(t *testing.T) {
	dir := setupTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "foo..bar.go"), []byte("package main\n\nfunc DoubleDotName() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}

	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})
	got, err := p.Execute(context.Background(), map[string]any{
		"search_text":   "DoubleDotName",
		"file_patterns": []any{"foo..bar.go"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "foo..bar.go") {
		t.Errorf("expected foo..bar.go in result, got: %s", got)
	}
}

// TestPathspecMagicLen verifies how much of a pathspec is read as git's magic
// signature rather than as the path the traversal check inspects. A signature
// git would not accept -- an unterminated long form -- is left whole, so its
// text is checked as a path rather than skipped.
func TestPathspecMagicLen(t *testing.T) {
	tests := []struct {
		pathspec string
		want     int
	}{
		{pathspec: "src/main.go", want: 0},
		{pathspec: "", want: 0},
		{pathspec: ":(exclude)*_test.go", want: 10},
		{pathspec: ":(exclude,top)src/", want: 14},
		{pathspec: ":!vendor/", want: 2},
		{pathspec: ":^vendor/", want: 2},
		{pathspec: ":/src/", want: 2},
		{pathspec: ":!^/x", want: 4},
		{pathspec: ":src/", want: 1},
		{pathspec: ":", want: 1},
		{pathspec: ":(exclude", want: 0},
	}

	for _, tt := range tests {
		if got := pathspecMagicLen(tt.pathspec); got != tt.want {
			t.Errorf("pathspecMagicLen(%q) = %d, want %d", tt.pathspec, got, tt.want)
		}
	}
}

// TestCodeSearchProvider_Execute_AllowsMagicSignature verifies reading past the
// signature does not start rejecting the exclude pathspec the tool's own
// description advertises.
func TestCodeSearchProvider_Execute_AllowsMagicSignature(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text":   "Hello",
		"file_patterns": []any{":(exclude)*_test.go"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(got, "Error:") {
		t.Errorf("an exclude pathspec was rejected: %s", got)
	}
}

func TestCodeSearchProvider_Execute_CaseSensitive(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text":    "hello",
		"case_sensitive": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "Hello") {
		t.Errorf("case-sensitive search for 'hello' should not match 'Hello', got: %s", got)
	}
}

func TestCodeSearchProvider_Execute_PerlRegexp(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text":     "Hell\\w+",
		"use_perl_regexp": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "hello.go") {
		t.Errorf("expected hello.go in perl regexp result, got: %s", got)
	}
}

func TestGitGrep_WithRunner(t *testing.T) {
	dir := setupTestRepo(t)
	runner := gitcmd.New(4)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace, Runner: runner})

	result, err := p.gitGrep(context.Background(), "Hello", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "hello.go") {
		t.Errorf("expected hello.go in result via Runner, got: %s", result)
	}
}

func TestGitGrep_WithRunner_NoMatch(t *testing.T) {
	dir := setupTestRepo(t)
	runner := gitcmd.New(4)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace, Runner: runner})

	result, err := p.gitGrep(context.Background(), "nonexistentXYZ", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result != "No matches found" {
		t.Errorf("expected 'No matches found', got: %s", result)
	}
}

func TestGitGrep_WithRunner_CommitMode(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	runner := gitcmd.New(4)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: commit, Mode: ModeCommit, Runner: runner})

	result, err := p.gitGrep(context.Background(), "Hello", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "hello.go") {
		t.Errorf("expected hello.go in result via Runner commit mode, got: %s", result)
	}
}

func TestGitGrep_Timeout(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result, err := p.gitGrep(ctx, "Hello", false, false, nil)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got: %v", err)
		}
		return
	}
	if !strings.Contains(result, "timed out") && !strings.Contains(result, "No matches found") {
		t.Errorf("expected timeout or no matches message, got: %s", result)
	}
}

func TestBuildGrepArgs_NoIndex(t *testing.T) {
	p := NewCodeSearch(&FileReader{RepoDir: "/tmp", Ref: ""})
	args := p.buildGrepArgs("foo", false, false, true, nil)

	assertContains(t, args, "--no-index")
	assertContains(t, args, "--exclude-standard")
	assertNotContains(t, args, "--untracked")
}

// TestPerlPatternRisk verifies which Perl-compatible patterns are refused
// before git is launched. A quantified group is refused when repeating it can
// match the same text in more than one way -- its body carries a quantifier,
// or its branches are not distinct literals -- and nothing else is: alternation
// between distinct literals matches in linear time, and every pattern the tool
// description advertises is accepted unchanged.
func TestPerlPatternRisk(t *testing.T) {
	risky := []string{
		"(a+)+",
		"(a*)*b",
		"(a|aa)+",
		"(aa|a)+",
		// An optional element in a repeated body is the same ambiguity as
		// (a|aa)+: each repetition can absorb one character or two.
		"(a?a)+",
		"(a?)+",
		`(\d?\d)+`,
		"(foo|)+",
		`(\w|\d)+`,
		"([a-z]|q)+",
		"(a|a)+",
		"((a+))+",
		`(\w+\s*)+`,
		"(a{2,3})+",
		"(?:a+)+",
		"(x+y+)*",
		"(a+){2,}",
	}
	for _, pattern := range risky {
		t.Run("refuses "+pattern, func(t *testing.T) {
			if risk := perlPatternRisk(pattern, true); risk == "" {
				t.Errorf("perlPatternRisk(%q) = \"\", want a reason", pattern)
			}
		})
	}

	safe := []string{
		"class.*extends.*BaseModel",
		"functionName(.*)",
		`\.functionName(.*)`,
		"error|exception|fail",
		`Hell\w+`,
		"[a-z]+",
		"(foo)+",
		"a{2,5}",
		`\(a\+\)\+`,
		"(?i)needle",
		"[(]a+[)]+",
		"(unclosed",
		"needle)",
		// A brace that is not a repetition operator is a literal, so it
		// neither makes a group ambiguous nor quantifies one.
		"a{x}",
		"(a+){z}",
		"(a+){",
		// Alternation between distinct literals is unambiguous: repeating it
		// matches each input exactly one way, so it runs in linear time.
		"(cat|dog)+",
		"(GET|POST|PUT)*",
		"(yes|no){2,3}",
		`(\.|,)+`,
		"(err|warn|info)+",
		// A pattern git will reject for itself is not this check's business.
		`needle\`,
	}
	for _, pattern := range safe {
		t.Run("accepts "+pattern, func(t *testing.T) {
			if risk := perlPatternRisk(pattern, true); risk != "" {
				t.Errorf("perlPatternRisk(%q) = %q, want it accepted", pattern, risk)
			}
		})
	}
}

// TestPerlPatternRisk_GroupIntroducers verifies the scanner reads the `(?...`
// group forms rather than treating their marker as pattern content: a
// non-capturing, named, flagged or lookaround group is judged by its contents,
// so its unambiguous branches are accepted and its ambiguous ones are not.
func TestPerlPatternRisk_GroupIntroducers(t *testing.T) {
	tests := []struct {
		pattern   string
		wantRisky bool
	}{
		{pattern: "(?:cat|dog)+"},
		{pattern: "(?:GET|POST|PUT)*"},
		{pattern: "(?i:cat|dog)+"},
		{pattern: "(?im-sx:cat|dog)+"},
		{pattern: "(?P<verb>cat|dog)+"},
		{pattern: "(?<verb>cat|dog)+"},
		{pattern: "(?'verb'cat|dog)+"},
		{pattern: "(?=cat|dog)needle"},
		{pattern: "(?<=cat|dog)needle"},
		{pattern: "(?>cat|dog)+"},
		{pattern: "(?i)needle"},
		{pattern: "(?:a|aa)+", wantRisky: true},
		{pattern: "(?:a+)+", wantRisky: true},
		{pattern: `(?P<word>\w+\s*)+`, wantRisky: true},
		// Truncated introducers: git rejects the pattern for itself, and the
		// scanner must not read past the end of it to say so.
		{pattern: "(?"},
		{pattern: "(?<"},
		{pattern: "(?P"},
		{pattern: "(?P<name"},
		{pattern: "(?#a comment)needle"},
		// An introducer the scanner does not recognize must not swallow the
		// pattern after it: the nested quantifier here has to stay visible.
		{pattern: "(?P=x)(a+)+(?<n>1)", wantRisky: true},
		{pattern: "(?P>x)(a|aa)+(?<n>1)", wantRisky: true},
		{pattern: `(?<not a name>)(a+)+`, wantRisky: true},
		{pattern: "(?'n'a+)+", wantRisky: true},
		{pattern: "(?P<n>a+)+", wantRisky: true},
	}

	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			risk := perlPatternRisk(tt.pattern, true)
			if (risk != "") != tt.wantRisky {
				t.Errorf("perlPatternRisk(%q) = %q, want risky = %v", tt.pattern, risk, tt.wantRisky)
			}
		})
	}
}

// TestPerlPatternRisk_CaseFolding verifies branches that differ only in case
// are judged by the search's own case sensitivity: they are the same branch to
// a case-insensitive match, which is the default and is also what an inline
// `(?i` flag asks for.
func TestPerlPatternRisk_CaseFolding(t *testing.T) {
	tests := []struct {
		name          string
		pattern       string
		caseSensitive bool
		wantRisky     bool
	}{
		{name: "case-insensitive search folds the branches", pattern: "(A|a)+", wantRisky: true},
		{name: "case-sensitive search keeps them distinct", pattern: "(A|a)+", caseSensitive: true},
		{name: "inline flag folds them even when the search does not", pattern: "(?i)(A|aa)+", caseSensitive: true, wantRisky: true},
		{name: "distinct literals stay accepted when folded", pattern: "(CAT|dog)+"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			risk := perlPatternRisk(tt.pattern, tt.caseSensitive)
			if (risk != "") != tt.wantRisky {
				t.Errorf("perlPatternRisk(%q, caseSensitive=%v) = %q, want risky = %v",
					tt.pattern, tt.caseSensitive, risk, tt.wantRisky)
			}
		})
	}
}

// TestPerlPatternRisk_ExtendedMode verifies the scanner reads a pattern the
// way PCRE will. Under an `x` flag, unescaped whitespace and `#` comments are
// ignored, so `(?x)(a+) +` is `(a+)+` and has to be refused as one, while an
// escaped space and a space inside a character class are still pattern text.
func TestPerlPatternRisk_ExtendedMode(t *testing.T) {
	tests := []struct {
		name      string
		pattern   string
		wantRisky bool
	}{
		{name: "whitespace before the quantifier", pattern: "(?x)(a+) +$", wantRisky: true},
		{name: "newline before the quantifier", pattern: "(?x)(a+)\n+$", wantRisky: true},
		{name: "comment before the quantifier", pattern: "(?x)(a+) # repeat it\n+$", wantRisky: true},
		{name: "scoped extended group", pattern: "(?x:(a+) +)", wantRisky: true},
		{name: "flag combination", pattern: "(?imx)(a|aa) +", wantRisky: true},
		{name: "extended mode with nothing ambiguous", pattern: "(?x) needle | other ", wantRisky: false},
		{name: "extended mode over distinct literals", pattern: "(?x)(cat|dog) +", wantRisky: false},
		{name: "a literal space is not a quantifier without the flag", pattern: "(a+) +$", wantRisky: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			risk := perlPatternRisk(tt.pattern, true)
			if (risk != "") != tt.wantRisky {
				t.Errorf("perlPatternRisk(%q) = %q, want risky = %v", tt.pattern, risk, tt.wantRisky)
			}
		})
	}
}

// TestPerlPatternRisk_CharacterClasses verifies the class scan keeps its
// bearings: an escaped or leading `]` is class content, not the end of the
// class, so the group and branch bookkeeping after it stays aligned.
func TestPerlPatternRisk_CharacterClasses(t *testing.T) {
	tests := []struct {
		pattern   string
		wantRisky bool
	}{
		{pattern: `[\]]+`},
		{pattern: `[\]a]+`},
		{pattern: `[]]+`},
		{pattern: `[^]]+`},
		{pattern: `(cat|dog)[\](]+`},
		{pattern: `[\]](a|aa)+`, wantRisky: true},
		{pattern: `[]](a+)+`, wantRisky: true},
	}

	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			risk := perlPatternRisk(tt.pattern, true)
			if (risk != "") != tt.wantRisky {
				t.Errorf("perlPatternRisk(%q) = %q, want risky = %v", tt.pattern, risk, tt.wantRisky)
			}
		})
	}
}

// TestGitGrep_RejectsRiskyPerlPattern verifies the refusal reaches the model as
// a result it can act on, that no git process runs for it, and that the check
// applies only to -P searches: the same text searched literally is harmless.
func TestGitGrep_RejectsRiskyPerlPattern(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Ref: "", Mode: ModeWorkspace})

	got, err := p.gitGrep(context.Background(), "(a+)+", false, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "Error: use_perl_regexp pattern rejected:") {
		t.Errorf("gitGrep() = %q, want a rejection of the pattern", got)
	}

	literal, err := p.gitGrep(context.Background(), "(a+)+", false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if literal != "No matches found" {
		t.Errorf("literal search for the same text = %q, want %q", literal, "No matches found")
	}
}

// TestCodeSearchProvider_Execute_RejectsOverlongSearchText verifies the pattern
// length bound is applied to model input, and that a pattern of exactly the
// limit still runs.
func TestCodeSearchProvider_Execute_RejectsOverlongSearchText(t *testing.T) {
	dir := setupTestRepo(t)
	p := NewCodeSearch(&FileReader{RepoDir: dir, Mode: ModeWorkspace})

	got, err := p.Execute(context.Background(), map[string]any{
		"search_text": strings.Repeat("n", gitGrepMaxPatternChars+1),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("Error: search_text must be at most %d characters", gitGrepMaxPatternChars)
	if got != want {
		t.Errorf("Execute() = %q, want %q", got, want)
	}

	atLimit, err := p.Execute(context.Background(), map[string]any{
		"search_text": strings.Repeat("n", gitGrepMaxPatternChars),
	})
	if err != nil {
		t.Fatal(err)
	}
	if atLimit != "No matches found" {
		t.Errorf("Execute() at the limit = %q, want %q", atLimit, "No matches found")
	}
}

// TestGrepBudget verifies a Perl-regexp search runs on a smaller deadline than
// a literal one, since the pattern decides for itself how long git spends
// matching it.
func TestGrepBudget(t *testing.T) {
	if got := grepBudget(false); got != gitGrepTimeout {
		t.Errorf("grepBudget(false) = %v, want %v", got, gitGrepTimeout)
	}
	if got := grepBudget(true); got != gitGrepPerlTimeout {
		t.Errorf("grepBudget(true) = %v, want %v", got, gitGrepPerlTimeout)
	}
	if gitGrepPerlTimeout >= gitGrepTimeout {
		t.Errorf("perl budget %v must be smaller than the literal budget %v", gitGrepPerlTimeout, gitGrepTimeout)
	}
}

// TestGrepPublishedLimits pins the limits the tool publishes. Each value below
// is stated to the model in the code_search description in
// internal/config/toolsconfig/tools.json and to readers in the Limits section
// of pages/src/content/docs/<locale>/tools.md, so a change here without a
// change there would leave both descriptions untrue.
func TestGrepPublishedLimits(t *testing.T) {
	if gitGrepMaxCount != 100 {
		t.Errorf("gitGrepMaxCount = %d, want 100 as published", gitGrepMaxCount)
	}
	if gitGrepMaxLineBytes != 1024 {
		t.Errorf("gitGrepMaxLineBytes = %d, want 1024 as published", gitGrepMaxLineBytes)
	}
	if gitGrepMaxPatternChars != 1000 {
		t.Errorf("gitGrepMaxPatternChars = %d, want 1000 as published", gitGrepMaxPatternChars)
	}
	if gitGrepTruncatedMarker != "...[truncated]" {
		t.Errorf("gitGrepTruncatedMarker = %q, want %q as published", gitGrepTruncatedMarker, "...[truncated]")
	}
	if gitGrepTimeout != 10*time.Second || gitGrepPerlTimeout != 5*time.Second {
		t.Errorf("deadlines are %v (literal) and %v (perl), want 10s and 5s as published",
			gitGrepTimeout, gitGrepPerlTimeout)
	}
	// The Limits section quotes these two failure classes as examples of the
	// fixed set, so they are part of the published text as much as the numbers.
	for _, tt := range []struct {
		stderr string
		want   string
	}{
		{stderr: "fatal: not a git repository", want: "the directory is not a git repository"},
		{stderr: "fatal: invalid regex", want: "git rejected the search pattern"},
	} {
		if got := grepFailureClass(tt.stderr, 128); got != tt.want {
			t.Errorf("grepFailureClass(%q) = %q, want %q as published", tt.stderr, got, tt.want)
		}
	}
}
