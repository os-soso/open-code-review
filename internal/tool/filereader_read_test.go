// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package tool

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alibaba/open-code-review/internal/gitcmd"
)

// commitWorktree stages and commits everything in dir, so a test can put a
// file into history and then read it at a ref.
func commitWorktree(t *testing.T, dir, message string) {
	t.Helper()
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-m", message}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func TestFileReader_Read_Workspace(t *testing.T) {
	dir := t.TempDir()
	content := "line1\nline2\nline3\n"
	if err := os.WriteFile(filepath.Join(dir, "test.go"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	got, err := fr.Read(context.Background(), "test.go")
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if got != content {
		t.Errorf("Read() = %q, want %q", got, content)
	}
}

func TestFileReader_Read_WorkspaceNotFound(t *testing.T) {
	dir := t.TempDir()
	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	_, err := fr.Read(context.Background(), "missing.go")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestFileReader_Read_PathTraversal(t *testing.T) {
	dir := t.TempDir()
	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}

	_, err := fr.Read(context.Background(), "../../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestFileReader_Read_SymlinkOutsideRepo(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	secretFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("sensitive"), 0644); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(dir, "link.txt")
	if err := os.Symlink(secretFile, link); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	_, err := fr.Read(context.Background(), "link.txt")
	if err == nil {
		t.Error("expected error for symlink pointing outside repo")
	}
}

func TestFileReader_ReadLines_Workspace(t *testing.T) {
	dir := t.TempDir()
	content := "aaa\nbbb\nccc\nddd\n"
	if err := os.WriteFile(filepath.Join(dir, "lines.txt"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}

	t.Run("all lines", func(t *testing.T) {
		lines, total, err := fr.ReadLines(context.Background(), "lines.txt", 1, 100)
		if err != nil {
			t.Fatal(err)
		}
		if total != 5 {
			t.Errorf("total = %d, want 5", total)
		}
		if len(lines) != 5 {
			t.Errorf("lines count = %d, want 5", len(lines))
		}
	})

	t.Run("start from line 2 with limit", func(t *testing.T) {
		lines, total, err := fr.ReadLines(context.Background(), "lines.txt", 2, 2)
		if err != nil {
			t.Fatal(err)
		}
		if total != 5 {
			t.Errorf("total = %d, want 5", total)
		}
		if len(lines) != 2 {
			t.Fatalf("lines count = %d, want 2", len(lines))
		}
		if lines[0] != "bbb" || lines[1] != "ccc" {
			t.Errorf("lines = %v, want [bbb ccc]", lines)
		}
	})

	t.Run("path traversal rejected", func(t *testing.T) {
		_, _, err := fr.ReadLines(context.Background(), "../../etc/passwd", 1, 10)
		if err == nil {
			t.Error("expected error for path traversal")
		}
	})
}

func TestFileReader_Read_CommitMode(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)

	fr := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit}
	got, err := fr.Read(context.Background(), "hello.go")
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if !strings.Contains(got, "package main") {
		t.Errorf("Read() = %q, want containing 'package main'", got)
	}
	if !strings.Contains(got, "func Hello()") {
		t.Errorf("Read() = %q, want containing 'func Hello()'", got)
	}
}

func TestFileReader_Read_CommitMode_MissingFile(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)

	fr := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit}
	_, err := fr.Read(context.Background(), "nonexistent.go")
	if err == nil {
		t.Error("expected error for missing file in commit mode")
	}
}

func TestFileReader_Read_CommitMode_WithRunner(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	runner := gitcmd.New(4)

	fr := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit, Runner: runner}
	got, err := fr.Read(context.Background(), "hello.go")
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if !strings.Contains(got, "package main") {
		t.Errorf("Read() = %q, want containing 'package main'", got)
	}
}

func TestFileReader_Read_CommitMode_WithRunner_MissingFile(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	runner := gitcmd.New(4)

	fr := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit, Runner: runner}
	_, err := fr.Read(context.Background(), "nonexistent.go")
	if err == nil {
		t.Error("expected error for missing file in commit mode with runner")
	}
}

func TestFileReader_ReadLines_CommitMode_WithRunner(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)
	runner := gitcmd.New(4)

	fr := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit, Runner: runner}
	lines, total, err := fr.ReadLines(context.Background(), "hello.go", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 {
		t.Errorf("totalLines = %d, want 4", total)
	}
	if len(lines) < 1 || lines[0] != "package main" {
		t.Errorf("first line = %q, want %q", lines[0], "package main")
	}
}

func TestFileReader_ReadLines_CommitMode_MissingFile(t *testing.T) {
	dir := setupTestRepo(t)
	commit := getHeadCommit(t, dir)

	fr := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit}
	_, _, err := fr.ReadLines(context.Background(), "nonexistent.go", 1, 100)
	if err == nil {
		t.Error("expected error for missing file in commit mode")
	}
}

func TestFileReader_Read_SubdirectoryFile(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "src", "pkg")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "main.go"), []byte("package main"), 0644); err != nil {
		t.Fatal(err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	got, err := fr.Read(context.Background(), "src/pkg/main.go")
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if got != "package main" {
		t.Errorf("Read() = %q, want %q", got, "package main")
	}
}

// TestFileReader_Read_CommitMode_MonorepoSubdirPath reproduces #287 at the
// git-show layer: in a monorepo, git reports paths relative to the repo root
// (e.g. "subproject1/src/models/request_meta.py"). With RepoDir anchored at the
// git top-level (the fix), `git show HEAD:<root-relative-path>` must resolve —
// this is the exact command that failed in the issue.
func TestFileReader_Read_CommitMode_MonorepoSubdirPath(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init")
	git("config", "user.email", "t@t.co")
	git("config", "user.name", "t")

	rel := filepath.Join("subproject1", "src", "models", "request_meta.py")
	if err := os.MkdirAll(filepath.Join(dir, filepath.Dir(rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "class RequestMeta:\n    id = 1\n"
	if err := os.WriteFile(filepath.Join(dir, rel), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "init")
	commit := getHeadCommit(t, dir)

	// Use the git-style forward-slash path the diff/LLM would supply.
	gitPath := "subproject1/src/models/request_meta.py"

	// git-show (commit mode): the exact path from the issue error.
	frShow := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit}
	got, err := frShow.Read(context.Background(), gitPath)
	if err != nil {
		t.Fatalf("commit-mode Read(%q) error: %v", gitPath, err)
	}
	if got != content {
		t.Errorf("commit-mode Read = %q, want %q", got, content)
	}

	// disk (workspace mode): same root-relative path resolves too.
	frDisk := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	gotDisk, err := frDisk.Read(context.Background(), gitPath)
	if err != nil {
		t.Fatalf("workspace-mode Read(%q) error: %v", gitPath, err)
	}
	if gotDisk != content {
		t.Errorf("workspace-mode Read = %q, want %q", gotDisk, content)
	}
}

// TestFileReader_RefusesSecretPath_EveryMode pins the credential gate on the
// reader itself rather than only on the tool that calls it: whichever mode is
// active, and whichever of the two read entry points is used, a credential
// path comes back as ErrSecretPath and no content is returned.
func TestFileReader_RefusesSecretPath_EveryMode(t *testing.T) {
	const secretMarker = "READER-SECRET-MUST-NOT-LEAK"
	dir := setupTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TOKEN="+secretMarker+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	commitWorktree(t, dir, "add env")
	commit := getHeadCommit(t, dir)

	readers := []struct {
		name string
		fr   *FileReader
	}{
		{name: "workspace", fr: &FileReader{RepoDir: dir, Mode: ModeWorkspace}},
		{name: "commit", fr: &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit}},
		{name: "range", fr: &FileReader{RepoDir: dir, Mode: ModeRange, Ref: commit}},
		{name: "commit with runner", fr: &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: commit, Runner: gitcmd.New(4)}},
	}
	for _, r := range readers {
		t.Run(r.name, func(t *testing.T) {
			content, err := r.fr.Read(context.Background(), ".env")
			if !errors.Is(err, ErrSecretPath) {
				t.Fatalf("Read(.env) error = %v, want ErrSecretPath", err)
			}
			if strings.Contains(content, secretMarker) {
				t.Fatalf("Read(.env) returned credential content: %q", content)
			}

			lines, total, err := r.fr.ReadLines(context.Background(), ".env", 1, 10)
			if !errors.Is(err, ErrSecretPath) {
				t.Fatalf("ReadLines(.env) error = %v, want ErrSecretPath", err)
			}
			if len(lines) != 0 || total != 0 {
				t.Fatalf("ReadLines(.env) = (%q, %d), want no lines", lines, total)
			}
		})
	}
}

// TestFileReader_RefusesSecretPathBehindSymlinkedDirectory covers the case a
// name-only check cannot see: the requested path is not a credential path, but
// a symlinked directory component puts the read inside .ssh, so the policy has
// to be applied to the location the name resolves to.
func TestFileReader_RefusesSecretPathBehindSymlinkedDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privileges vary on Windows")
	}

	const secretMarker = "SSH-CONFIG-MUST-NOT-LEAK"
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".ssh"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".ssh", "config"), []byte("Host "+secretMarker+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// "conf/config" matches no secret pattern; ".ssh/config" matches **/.ssh/**.
	if err := os.Symlink(".ssh", filepath.Join(dir, "conf")); err != nil {
		t.Fatal(err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	if _, _, err := fr.ReadLines(context.Background(), "conf/config", 1, 10); !errors.Is(err, ErrSecretPath) {
		t.Fatalf("ReadLines(conf/config) error = %v, want ErrSecretPath", err)
	}
	if _, err := fr.Read(context.Background(), "conf/config"); !errors.Is(err, ErrSecretPath) {
		t.Fatalf("Read(conf/config) error = %v, want ErrSecretPath", err)
	}
}

// TestOpenWorkspaceFile_RootedContainment pins the containment contract of the
// rooted open that workspace reads go through. The cases that matter are the
// ones os.Root decides on its own (a name that leaves the repository through a
// symlink, whether the link is the file or a directory above it) and the one it
// is deliberately relieved of (a link whose text is absolute but whose target
// is inside the repository, which os.Root alone would refuse).
func TestOpenWorkspaceFile_RootedContainment(t *testing.T) {
	base := t.TempDir()
	repoDir := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(repoDir, "pkg"), 0755); err != nil {
		t.Fatal(err)
	}
	outsideDir := filepath.Join(base, "outside")
	if err := os.Mkdir(outsideDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "secret.txt"), []byte("outside-secret\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "inside.txt"), []byte("inside\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "pkg", "nested.txt"), []byte("nested\n"), 0644); err != nil {
		t.Fatal(err)
	}

	symlinksSupported := true
	if err := os.Symlink(filepath.Join(outsideDir, "secret.txt"), filepath.Join(repoDir, "escaping-file")); err != nil {
		symlinksSupported = false
	} else {
		if err := os.Symlink(outsideDir, filepath.Join(repoDir, "escaping-dir")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(repoDir, "inside.txt"), filepath.Join(repoDir, "absolute-inside-link")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("inside.txt", filepath.Join(repoDir, "relative-inside-link")); err != nil {
			t.Fatal(err)
		}
		// A link to itself: resolution fails for a reason that is not "the
		// file does not exist", which must be reported as itself.
		if err := os.Symlink("looping-link", filepath.Join(repoDir, "looping-link")); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		name        string
		path        string
		wantContent string
		wantErr     string
		needSymlink bool
	}{
		{name: "regular file", path: "inside.txt", wantContent: "inside\n"},
		{name: "nested file", path: "pkg/nested.txt", wantContent: "nested\n"},
		{name: "directory instead of a file", path: "pkg", wantErr: "is a directory"},
		{name: "traversal out of the repository", path: filepath.Join("..", "outside", "secret.txt"), wantErr: "outside repository"},
		{name: "escaping file symlink", path: "escaping-file", wantErr: "outside repository", needSymlink: true},
		{name: "escaping directory symlink", path: "escaping-dir/secret.txt", wantErr: "outside repository", needSymlink: true},
		{name: "absolute symlink inside the repository", path: "absolute-inside-link", wantContent: "inside\n", needSymlink: true},
		{name: "relative symlink inside the repository", path: "relative-inside-link", wantContent: "inside\n", needSymlink: true},
		{name: "symlink loop keeps its own diagnosis", path: "looping-link", wantErr: "resolve file", needSymlink: true},
	}

	fr := &FileReader{RepoDir: repoDir, Mode: ModeWorkspace}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.needSymlink && !symlinksSupported {
				t.Skip("symlinks not supported on this platform")
			}
			got, err := fr.Read(context.Background(), tc.path)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("Read(%q) error = %v, want error containing %q", tc.path, err, tc.wantErr)
				}
				if strings.Contains(got, "outside-secret") {
					t.Fatalf("Read(%q) returned content from outside the repository", tc.path)
				}
				return
			}
			if err != nil {
				t.Fatalf("Read(%q) error = %v", tc.path, err)
			}
			if got != tc.wantContent {
				t.Fatalf("Read(%q) = %q, want %q", tc.path, got, tc.wantContent)
			}
		})
	}
}

// TestOpenWorkspaceFile_RefusesUnapprovedOpenedFile drives the comparison that
// ties the content served to the object the resolver examined. The no-follow
// lookup is stood in for, because the window the comparison closes — between
// examining the final component and opening it — cannot be timed by a fixture:
// here the resolver is made to examine one file while another is opened, which
// is what a worktree mutation landing in that window looks like.
func TestOpenWorkspaceFile_RefusesUnapprovedOpenedFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "requested.txt"), []byte("requested-content\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("other-content\n"), 0644); err != nil {
		t.Fatal(err)
	}

	original := rootLstat
	t.Cleanup(func() { rootLstat = original })
	rootLstat = func(root *os.Root, name string) (os.FileInfo, error) {
		if name == "requested.txt" {
			return original(root, "other.txt")
		}
		return original(root, name)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	got, err := fr.Read(context.Background(), "requested.txt")
	if err == nil || !strings.Contains(err.Error(), "file changed while it was being opened") {
		t.Fatalf("Read error = %v, want the changed-while-opening refusal", err)
	}
	if got != "" {
		t.Fatalf("Read returned %q, want no content", got)
	}
	if _, _, err := fr.ReadLines(context.Background(), "requested.txt", 1, 10); err == nil ||
		!strings.Contains(err.Error(), "file changed while it was being opened") {
		t.Fatalf("ReadLines error = %v, want the changed-while-opening refusal", err)
	}
}

// TestOpenWorkspaceFile_RefusesDirectorySwappedDuringWalk is the deterministic
// form of the race an in-repository swap would otherwise win: a directory
// component is replaced with a symlink to .ssh in the very window between the
// resolver examining that component and descending into it. The descent lands
// somewhere other than what was examined, so the read is abandoned; the retry
// then sees a symlink, resolves it, and the credential policy refuses the path
// it names. Either way no line of the credential file is returned.
func TestOpenWorkspaceFile_RefusesDirectorySwappedDuringWalk(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privileges vary on Windows")
	}

	const secretMarker = "SWAPPED-SSH-CONFIG-MUST-NOT-LEAK"
	dir := t.TempDir()
	for _, name := range []string{"public", ".ssh"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "public", "config"), []byte("public-content\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".ssh", "config"), []byte("Host "+secretMarker+"\n"), 0600); err != nil {
		t.Fatal(err)
	}

	original := rootLstat
	t.Cleanup(func() { rootLstat = original })
	swapped := false
	rootLstat = func(root *os.Root, name string) (os.FileInfo, error) {
		info, err := original(root, name)
		if name == "public" && !swapped {
			swapped = true
			if rmErr := os.RemoveAll(filepath.Join(dir, "public")); rmErr != nil {
				t.Errorf("swap: remove public: %v", rmErr)
			}
			if linkErr := os.Symlink(".ssh", filepath.Join(dir, "public")); linkErr != nil {
				t.Errorf("swap: link public: %v", linkErr)
			}
		}
		return info, err
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	got, err := fr.Read(context.Background(), "public/config")
	if !errors.Is(err, ErrSecretPath) {
		t.Fatalf("Read(public/config) error = %v, want ErrSecretPath after the swap", err)
	}
	if strings.Contains(got, secretMarker) {
		t.Fatalf("Read(public/config) leaked credential content: %q", got)
	}
}

// TestOpenWorkspaceFile_RepositoryRootIsADirectory pins the degenerate path:
// a name that addresses the repository directory itself is opened and then
// refused by the read, the way any directory is, rather than walking off the
// end of the components.
func TestOpenWorkspaceFile_RepositoryRootIsADirectory(t *testing.T) {
	fr := &FileReader{RepoDir: t.TempDir(), Mode: ModeWorkspace}

	for _, path := range []string{"", ".", "./"} {
		t.Run("path "+strconv.Quote(path), func(t *testing.T) {
			if _, err := fr.Read(context.Background(), path); err == nil ||
				!strings.Contains(err.Error(), "is a directory") {
				t.Fatalf("Read(%q) error = %v, want a directory error", path, err)
			}
		})
	}
}

// TestOpenWorkspaceFile_FileRemovedDuringWalk pins what happens when the file
// disappears between the resolver examining it and opening it: the read
// reports the file as missing instead of serving whatever took its place.
func TestOpenWorkspaceFile_FileRemovedDuringWalk(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "vanishing.txt")
	if err := os.WriteFile(target, []byte("content\n"), 0644); err != nil {
		t.Fatal(err)
	}

	originalLstat := rootLstat
	t.Cleanup(func() { rootLstat = originalLstat })
	removed := false
	rootLstat = func(root *os.Root, name string) (os.FileInfo, error) {
		info, err := originalLstat(root, name)
		if name == "vanishing.txt" && !removed {
			removed = true
			if rmErr := os.Remove(target); rmErr != nil {
				t.Errorf("remove during walk: %v", rmErr)
			}
		}
		return info, err
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	_, err := fr.Read(context.Background(), "vanishing.txt")
	if err == nil || !errors.Is(err, os.ErrNotExist) ||
		!strings.Contains(err.Error(), `read file "vanishing.txt"`) {
		t.Fatalf("Read error = %v, want the not-exist error under read file", err)
	}
}

// TestOpenWorkspaceFile_LookupFailureKeepsItsDiagnosis pins that a lookup
// which fails for a reason other than the file being absent is reported as
// itself, rather than folded into a not-found or a race error.
func TestOpenWorkspaceFile_LookupFailureKeepsItsDiagnosis(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("content\n"), 0644); err != nil {
		t.Fatal(err)
	}

	original := rootLstat
	t.Cleanup(func() { rootLstat = original })
	rootLstat = func(*os.Root, string) (os.FileInfo, error) {
		return nil, errors.New("lookup unavailable")
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	_, err := fr.Read(context.Background(), "file.txt")
	if err == nil || !strings.Contains(err.Error(), `resolve file "file.txt"`) ||
		!strings.Contains(err.Error(), "lookup unavailable") {
		t.Fatalf("Read error = %v, want the lookup failure surfaced under resolve file", err)
	}
}

// TestFileReader_RefusesIgnoredPath covers the other half of the read policy:
// a project's own credentials do not carry the names in the built-in denylist,
// they are simply listed in .gitignore and never tracked. Those paths are
// refused, while tracked content — including a committed file that matches an
// ignore pattern — and untracked-but-not-ignored content stay readable.
func TestFileReader_RefusesIgnoredPath(t *testing.T) {
	const ignoredMarker = "IGNORED-CREDENTIAL-MUST-NOT-LEAK"
	dir := setupTestRepo(t)
	write := func(rel, content string) {
		t.Helper()
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	write(".gitignore", "secrets/\nlocal-credentials.yaml\ndist/\n")
	write("dist/bundle.js", "// committed build output\n")
	commitWorktree(t, dir, "add gitignore")
	// `git add -A` honours .gitignore, so the committed-yet-ignored file has
	// to be forced in; that is exactly the case tracking must win.
	forceAdd := exec.Command("git", "add", "-f", "dist/bundle.js")
	forceAdd.Dir = dir
	if out, err := forceAdd.CombinedOutput(); err != nil {
		t.Fatalf("git add -f: %v\n%s", err, out)
	}
	commitWorktree(t, dir, "add build output")

	write("secrets/prod.json", "{\"token\": \""+ignoredMarker+"\"}\n")
	write("local-credentials.yaml", "password: "+ignoredMarker+"\n")
	write("untracked.go", "package main\n")

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}

	for _, ignored := range []string{"secrets/prod.json", "local-credentials.yaml"} {
		t.Run("refuses "+ignored, func(t *testing.T) {
			content, err := fr.Read(context.Background(), ignored)
			if !errors.Is(err, ErrIgnoredPath) {
				t.Fatalf("Read(%q) error = %v, want ErrIgnoredPath", ignored, err)
			}
			if strings.Contains(content, ignoredMarker) {
				t.Fatalf("Read(%q) returned ignored content: %q", ignored, content)
			}
			if _, _, err := fr.ReadLines(context.Background(), ignored, 1, 10); !errors.Is(err, ErrIgnoredPath) {
				t.Fatalf("ReadLines(%q) error = %v, want ErrIgnoredPath", ignored, err)
			}
		})
	}

	for _, readable := range []string{"hello.go", "dist/bundle.js", "untracked.go", ".gitignore"} {
		t.Run("reads "+readable, func(t *testing.T) {
			if _, err := fr.Read(context.Background(), readable); err != nil {
				t.Fatalf("Read(%q) error = %v, want the file content", readable, err)
			}
		})
	}

	t.Run("ref mode reads the tracked blob", func(t *testing.T) {
		frRef := &FileReader{RepoDir: dir, Mode: ModeCommit, Ref: getHeadCommit(t, dir)}
		got, err := frRef.Read(context.Background(), "dist/bundle.js")
		if err != nil {
			t.Fatalf("Read at ref error = %v", err)
		}
		if !strings.Contains(got, "committed build output") {
			t.Fatalf("Read at ref = %q, want the committed content", got)
		}
	})
}

// TestFileReader_IgnoreCheckFailsClosedInsideRepository pins that the ignore
// policy is never quietly downgraded: when a repository is present but git
// cannot answer for it, the read fails instead of falling through to the
// weaker pattern reader, which knows nothing of nested ignore files,
// .git/info/exclude or core.excludesFile.
func TestFileReader_IgnoreCheckFailsClosedInsideRepository(t *testing.T) {
	dir := t.TempDir()
	// A .git file with invalid content is a repository as far as this reader
	// can tell, and a fatal error as far as git is concerned.
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: nowhere-valid\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatal(err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	got, err := fr.Read(context.Background(), "main.go")
	if err == nil || !strings.Contains(err.Error(), "check ignore status") {
		t.Fatalf("Read error = %v, want the ignore-status failure surfaced", err)
	}
	if got != "" {
		t.Fatalf("Read returned %q, want no content", got)
	}
}

// TestFileReader_RefusesPathRenamedAfterIgnoreCheck covers the gap between the
// two kinds of answer the ignore policy joins: git answers about a path, the
// content comes from a descriptor, and a descriptor outlives a rename of the
// name it was opened under. The confirmation lookup is stood in for, because
// that window cannot be timed from outside; a path that no longer names the
// opened object must abandon the read rather than serve it under a verdict
// that was given for something else.
func TestFileReader_RefusesPathRenamedAfterIgnoreCheck(t *testing.T) {
	const marker = "RENAMED-AWAY-MUST-NOT-LEAK"
	dir := setupTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte(marker+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("other\n"), 0644); err != nil {
		t.Fatal(err)
	}
	commitWorktree(t, dir, "add files")

	original := rootLstat
	t.Cleanup(func() { rootLstat = original })
	lookups := 0
	rootLstat = func(root *os.Root, name string) (os.FileInfo, error) {
		if name == "file.txt" {
			lookups++
			// The first lookup is the resolver's; every later one is a
			// confirmation, and by then the name points elsewhere.
			if lookups > 1 {
				return original(root, "other.txt")
			}
		}
		return original(root, name)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	got, err := fr.Read(context.Background(), "file.txt")
	if err == nil || !strings.Contains(err.Error(), "file changed while it was being opened") {
		t.Fatalf("Read error = %v, want the changed-while-opening refusal", err)
	}
	if strings.Contains(got, marker) {
		t.Fatalf("Read returned content judged under another path: %q", got)
	}
}

// TestFileReader_RefusesIgnoredPathOutsideGitRepository covers `ocr scan` on a
// plain directory: git cannot answer there, so the .gitignore that is present
// is read directly — the same fallback file_find uses to enumerate.
func TestFileReader_RefusesIgnoredPathOutsideGitRepository(t *testing.T) {
	const ignoredMarker = "PLAIN-DIR-CREDENTIAL-MUST-NOT-LEAK"
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("secrets/\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "secrets"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secrets", "prod.json"), []byte(ignoredMarker+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatal(err)
	}

	fr := &FileReader{RepoDir: dir, Mode: ModeWorkspace}
	content, err := fr.Read(context.Background(), "secrets/prod.json")
	if !errors.Is(err, ErrIgnoredPath) {
		t.Fatalf("Read(secrets/prod.json) error = %v, want ErrIgnoredPath", err)
	}
	if strings.Contains(content, ignoredMarker) {
		t.Fatalf("Read(secrets/prod.json) returned ignored content: %q", content)
	}
	if _, err := fr.Read(context.Background(), "main.go"); err != nil {
		t.Fatalf("Read(main.go) error = %v, want the file content", err)
	}
}

// TestOpenWorkspaceFile_UnresolvableRepoDir pins the failure that precedes any
// name resolution: with no repository directory to root the read in, both
// entry points refuse rather than falling back to an unrooted open.
func TestOpenWorkspaceFile_UnresolvableRepoDir(t *testing.T) {
	fr := &FileReader{RepoDir: filepath.Join(t.TempDir(), "does-not-exist"), Mode: ModeWorkspace}

	if _, err := fr.Read(context.Background(), "any.txt"); err == nil ||
		!strings.Contains(err.Error(), "resolve repository path") {
		t.Fatalf("Read error = %v, want resolve repository path error", err)
	}
	if _, _, err := fr.ReadLines(context.Background(), "any.txt", 1, 10); err == nil ||
		!strings.Contains(err.Error(), "resolve repository path") {
		t.Fatalf("ReadLines error = %v, want resolve repository path error", err)
	}
}

// TestReadLines_Disk_ContainedWhileWorktreeChanges is the regression guard for
// the races the rooted open and the post-open identity check close. A path is
// swapped under the reader while it is being read, either onto a file outside
// the repository or onto a credential file inside it. A read may succeed with
// the innocuous content or fail, but it must never return the content the
// swap points at — which the previous validate-a-name-then-reopen-it sequence
// could do whenever the swap landed between the two resolutions.
func TestReadLines_Disk_ContainedWhileWorktreeChanges(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privileges vary on Windows")
	}

	cases := []struct {
		name            string
		forbiddenMarker string
		// swapTarget names the file the link is repointed at every other
		// iteration, relative to the test's base directory.
		swapTarget func(base, repoDir string) string
	}{
		{
			name:            "swap out of the repository",
			forbiddenMarker: "outside-secret",
			swapTarget: func(base, _ string) string {
				return filepath.Join(base, "secret.txt")
			},
		},
		{
			name:            "swap onto a credential file inside the repository",
			forbiddenMarker: "inside-secret",
			swapTarget: func(_, _ string) string {
				return ".env"
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			repoDir := filepath.Join(base, "repo")
			if err := os.Mkdir(repoDir, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(base, "secret.txt"), []byte("outside-secret\n"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(repoDir, ".env"), []byte("TOKEN=inside-secret\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(repoDir, "inside.txt"), []byte("inside-content\n"), 0644); err != nil {
				t.Fatal(err)
			}

			swapPath := filepath.Join(repoDir, "swap.txt")
			if err := os.Symlink("inside.txt", swapPath); err != nil {
				t.Skipf("symlinks not supported: %v", err)
			}

			stop := make(chan struct{})
			var wg sync.WaitGroup
			wg.Add(1)
			go func() {
				defer wg.Done()
				targets := []string{"inside.txt", tc.swapTarget(base, repoDir)}
				for i := 0; ; i++ {
					select {
					case <-stop:
						return
					default:
					}
					_ = os.Remove(swapPath)
					_ = os.Symlink(targets[i%len(targets)], swapPath)
					time.Sleep(20 * time.Microsecond)
				}
			}()
			t.Cleanup(func() {
				close(stop)
				wg.Wait()
			})

			fr := &FileReader{RepoDir: repoDir, Mode: ModeWorkspace}
			for i := 0; i < 60; i++ {
				lines, _, err := fr.ReadLines(context.Background(), "swap.txt", 1, 10)
				if err != nil {
					// The link was pointing at something the reader refuses,
					// or it was momentarily absent mid-swap.
					continue
				}
				for _, line := range lines {
					if strings.Contains(line, tc.forbiddenMarker) {
						t.Fatalf("ReadLines(swap.txt) returned guarded content: %q", line)
					}
				}
			}
		})
	}
}
