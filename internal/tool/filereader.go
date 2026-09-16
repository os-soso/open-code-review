// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package tool

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	allowedext "github.com/alibaba/open-code-review/internal/config/allowlist"
	"github.com/alibaba/open-code-review/internal/diff"
	"github.com/alibaba/open-code-review/internal/gitcmd"
	"github.com/alibaba/open-code-review/internal/pathutil"
)

// ReviewMode represents the active review mode.
type ReviewMode int

const (
	// ModeWorkspace reads files from the current working tree.
	ModeWorkspace ReviewMode = iota
	// ModeRange reads files as they exist at a specific git ref (--to value).
	ModeRange
	// ModeCommit reads files as they exist at a specific commit hash.
	ModeCommit
)

// ParseReviewMode returns the correct ReviewMode based on provided flag values.
func ParseReviewMode(from, to, commit string) ReviewMode {
	if commit != "" {
		return ModeCommit
	}
	if from != "" && to != "" {
		return ModeRange
	}
	return ModeWorkspace
}

// RefValue returns the git ref that should be used for reading file contents
// in range or commit mode. Returns ("", false) for workspace mode.
func (m ReviewMode) RefValue(toRef, commit string) (string, bool) {
	switch m {
	case ModeRange:
		return toRef, true
	case ModeCommit:
		return commit, true
	default:
		return "", false
	}
}

// FileReader resolves file contents according to the active review mode.
type FileReader struct {
	RepoDir string
	Mode    ReviewMode
	// Ref is the git ref to use for ModeRange (--to) or ModeCommit (--commit).
	// Empty for ModeWorkspace.
	Ref    string
	Runner *gitcmd.Runner
}

const (
	// maxSymlinkHops bounds symlink resolution the way the kernel bounds its
	// own, so a link cycle inside the worktree ends in a diagnosis.
	maxSymlinkHops = 32

	// workspaceIgnoreTimeout bounds the single question the ignore policy
	// asks git per workspace read.
	workspaceIgnoreTimeout = 10 * time.Second
)

// ErrSecretPath reports a read that the built-in secret-path policy refused.
// It is a sentinel rather than a formatted string so that a tool provider can
// recognize the refusal with errors.Is and answer its caller in its own words.
var ErrSecretPath = errors.New("path is blocked by the built-in secret-path policy")

// ErrIgnoredPath reports a read refused because the repository ignores the
// path and does not track it, which puts it outside the content a review
// covers — the place a project keeps its own credentials.
var ErrIgnoredPath = errors.New("path is ignored by the repository and not tracked")

var errTooManySymlinkHops = errors.New("too many levels of symbolic links")

// denySecretPath applies the built-in credential denylist to a single path.
//
// The denylist already keeps credential files out of review selection
// (internal/agent and internal/scan consult it before a file is reviewed).
// FileReader needs the same policy of its own because it backs the file_read
// tool, whose path argument is chosen by the model: a reader that trusted the
// selection-time decision would still hand over .env, .netrc or .ssh/id_rsa
// when asked for one by name, and that content would then be forwarded to the
// LLM and written into the recorded session.
//
// The gate is unconditional. No tool argument and no review mode can waive
// it, so reading a credential file remains a human decision taken outside
// this process rather than something a prompt can talk the model into.
func denySecretPath(path string) error {
	if !allowedext.IsSecretPath(path) {
		return nil
	}
	return fmt.Errorf("%w: %q", ErrSecretPath, path)
}

// denyIgnoredPath refuses a workspace read of a path the repository ignores.
//
// The built-in denylist names the credential files every project has; a
// project names its own — `secrets/prod.json`, `local-credentials.yaml` — in
// its .gitignore, and those are exactly the files a review never selects.
// git is asked the question rather than a pattern matcher answering it,
// because only git applies nested ignore files, .git/info/exclude,
// core.excludesFile and negation order the way the repository's own tooling
// does: a path `git ls-files --cached --others --exclude-standard` lists is
// either tracked or untracked-and-not-ignored, and a path it omits is ignored.
// Tracking wins, so a committed file that happens to match an ignore pattern
// stays readable.
//
// Content inside a submodule is refused by the same rule, because git lists
// the submodule as one entry and never its files. That matches what the rest
// of the toolset can see: file_find enumerates with the same command, and
// code_search does not recurse into submodules either.
//
// Reads at a ref need no such gate: `git show <ref>:<path>` can only produce a
// tracked blob, and a tracked path is not ignored.
func (fr *FileReader) denyIgnoredPath(parentCtx context.Context, paths ...string) error {
	wanted := make([]string, 0, len(paths))
	for _, p := range paths {
		slashed := filepath.ToSlash(p)
		if slashed == "" || slashed == "." || slices.Contains(wanted, slashed) {
			continue
		}
		wanted = append(wanted, slashed)
	}
	if len(wanted) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(parentCtx, workspaceIgnoreTimeout)
	defer cancel()

	// `:(literal)` keeps a model-supplied name from being read as pathspec
	// magic — a leading colon would otherwise change what is being asked.
	args := []string{"ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"}
	for _, p := range wanted {
		args = append(args, ":(literal)"+p)
	}

	var output []byte
	var err error
	if fr.Runner != nil {
		output, err = fr.Runner.Output(ctx, fr.RepoDir, args...)
	} else {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = fr.RepoDir
		output, err = cmd.Output()
	}
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("check ignore status of %q: %w", wanted[0], ctxErr)
		}
		if fr.hasGitDirectory() {
			// git was there to answer and did not: a broken index, an
			// unreadable .git, a misconfigured binary. Falling back to the
			// weaker pattern reader here would quietly downgrade the policy
			// for the rest of the run, so the read fails instead.
			return fmt.Errorf("check ignore status of %q: %w", wanted[0], err)
		}
		// No repository to ask, and `ocr scan` runs on plain directories:
		// fall back to reading the .gitignore that is there, which is the
		// same fallback file_find uses to enumerate.
		return fr.denyIgnoredPathWithoutGit(wanted)
	}

	listed := make(map[string]bool)
	for _, entry := range bytes.Split(output, []byte{0}) {
		if len(entry) > 0 {
			listed[string(entry)] = true
		}
	}
	for _, p := range wanted {
		if !listed[p] {
			return fmt.Errorf("%w: %q", ErrIgnoredPath, p)
		}
	}
	return nil
}

// hasGitDirectory reports whether RepoDir carries a git directory — a .git
// directory, or the .git file a worktree uses. It tells a `git ls-files` that
// failed because there is no repository from one that failed for a reason
// worth reporting.
func (fr *FileReader) hasGitDirectory() bool {
	_, err := os.Lstat(filepath.Join(fr.RepoDir, ".git"))
	return err == nil
}

// denyIgnoredPathWithoutGit is the non-repository fallback: the .gitignore in
// the directory plus the blocklist of directories the diff provider always
// skips, which is what file_find falls back to when git cannot enumerate.
func (fr *FileReader) denyIgnoredPathWithoutGit(paths []string) error {
	patterns := diff.LoadGitignorePatterns(fr.RepoDir)
	for _, p := range paths {
		if diff.IsPathExcluded(fr.RepoDir, p, patterns) {
			return fmt.Errorf("%w: %q", ErrIgnoredPath, p)
		}
	}
	return nil
}

// Read returns the full content of a file path (relative to RepoDir),
// resolved according to the active review mode.
// - Workspace: reads directly from the filesystem.
// - Range / Commit: uses `git show <Ref>:<path>` to read at the given ref.
//
// A credential path is refused before any mode is consulted, so the policy
// holds for workspace reads and for reads at a ref alike.
func (fr *FileReader) Read(ctx context.Context, path string) (string, error) {
	if err := denySecretPath(path); err != nil {
		return "", err
	}
	switch fr.Mode {
	case ModeWorkspace:
		return fr.readFromDisk(ctx, path)
	case ModeRange, ModeCommit:
		return fr.readFromGitShow(ctx, path)
	default:
		return fr.readFromDisk(ctx, path)
	}
}

func (fr *FileReader) readFromDisk(ctx context.Context, path string) (string, error) {
	f, err := fr.openWorkspaceFile(ctx, path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	content, err := io.ReadAll(f)
	if err != nil {
		return "", fmt.Errorf("read file %q: %w", path, err)
	}
	return string(content), nil
}

// errFileChangedWhileOpening reports that the file a read landed on was not
// the file the secret-path policy had just approved, which is what a worktree
// mutation racing the read looks like from here. It is deliberately not an
// ErrSecretPath: nothing was established about the new file, so the read is
// abandoned rather than described.
var errFileChangedWhileOpening = errors.New("file changed while it was being opened")

// rootLstat and rootSelfStat are the two no-follow lookups the resolver below
// bases its decisions on: what a component is before it is opened, and what
// the directory it descended into turned out to be.
//
// They are variables so that a test can stand in for the worktree mutation the
// resolver's identity comparisons exist to catch. The windows they close are a
// few microseconds wide and no fixture can time them from the outside.
var (
	rootLstat = func(root *os.Root, name string) (os.FileInfo, error) {
		return root.Lstat(name)
	}
	rootSelfStat = func(root *os.Root) (os.FileInfo, error) {
		return root.Stat(".")
	}
)

// workspaceFile is an opened workspace file together with what the resolver
// established about it: the identity of the object the descriptor refers to,
// and the repository-relative path the walk ended on, which is the path the
// content actually comes from and therefore the one the policies judge.
type workspaceFile struct {
	file *os.File
	info os.FileInfo
	path string
}

// workspaceResolver walks one requested path under one rooted handle on the
// repository directory.
type workspaceResolver struct {
	root      *os.Root
	repoRoot  string
	requested string
}

// openWorkspaceFile opens a repository-relative path for reading through a
// handle on the repository directory itself, with both read policies applied
// to the path the content actually comes from. The caller owns the returned
// file and must close it.
//
// os.Root is what contains the read: every component of the name is resolved
// under a directory handle, and a name that would leave the repository is
// refused. What this replaced validated a pathname — EvalSymlinks followed by
// a containment test — and then reopened that same name later, from os.ReadFile
// or os.Open; between those two resolutions a mutation of the worktree could
// swap a component, or the file itself, for a symlink out of the repository,
// and the second resolution would follow it.
//
// One retry, and no more: a concurrent write — an editor replacing a file
// while the review runs — moves a file between the resolver's look at it and
// its open, and a single retry absorbs that without handing an attacker an
// unbounded number of attempts at the same race.
func (fr *FileReader) openWorkspaceFile(ctx context.Context, path string) (*os.File, error) {
	repoRoot, err := pathutil.CanonicalPath(fr.RepoDir)
	if err != nil {
		return nil, fmt.Errorf("resolve repository path %q: %w", fr.RepoDir, err)
	}

	// filepath.Join cleans what it joins, so an absolute path or one carrying
	// ".." segments collapses into a single repository-relative name, and a
	// name that still points out of the repository is rejected lexically.
	requested, ok := pathutil.RelWithinBase(repoRoot, filepath.Join(repoRoot, path))
	if !ok {
		return nil, fmt.Errorf("file path %q is outside repository", path)
	}

	root, err := os.OpenRoot(repoRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve repository path %q: %w", fr.RepoDir, err)
	}
	// The opened file outlives the root handle, which is only needed to
	// resolve the name; closing it here keeps one descriptor per read.
	defer root.Close()

	resolver := &workspaceResolver{root: root, repoRoot: repoRoot, requested: path}

	var wf *workspaceFile
	for attempt := 0; attempt < 2; attempt++ {
		wf, err = fr.openConfirmedFile(ctx, resolver, root, requested)
		if !errors.Is(err, errFileChangedWhileOpening) {
			break
		}
	}
	if err != nil {
		if errors.Is(err, errFileChangedWhileOpening) {
			return nil, fmt.Errorf("read file %q: %w", path, err)
		}
		return nil, err
	}
	return wf.file, nil
}

// openConfirmedFile is one attempt at producing a file whose content both read
// policies have cleared: the resolver opens it with the credential policy
// applied to every location its walk named, the ignore policy then judges the
// path the content comes from, and the path is confirmed to still name the
// object that was opened.
//
// That last confirmation is what makes the ignore verdict mean anything. git
// answers about a path, while the bytes come from a descriptor, and a
// descriptor outlives a rename of the name it was opened under: without the
// check, a mutation between the open and the question could present a tracked
// file at that path while the ignored one stayed on the open descriptor.
func (fr *FileReader) openConfirmedFile(ctx context.Context, resolver *workspaceResolver, root *os.Root, requested string) (*workspaceFile, error) {
	wf, err := resolver.open(requested)
	if err != nil {
		return nil, err
	}

	// A directory read fails on its own when the content is asked for, and
	// git has no opinion on directories, so only files reach the ignore gate.
	if wf.info.IsDir() {
		return wf, nil
	}

	if err := fr.denyIgnoredPath(ctx, wf.path, requested); err != nil {
		wf.file.Close()
		return nil, err
	}

	current, err := rootLstat(root, wf.path)
	if err != nil || !os.SameFile(wf.info, current) {
		wf.file.Close()
		return nil, errFileChangedWhileOpening
	}
	return wf, nil
}

// open resolves logical under the resolver's root, following symlinks itself
// so that every location the walk names is judged by the credential policy
// before it is reached, and returns the opened file.
//
// Resolving the chain here rather than handing the whole name to the kernel is
// what ties the policy decision to the object that is opened. A name resolved
// in one place and opened in another can be redirected in between — onto a
// credential file that is still inside the repository, which no containment
// check would object to — so each hop is read from a pinned directory handle
// and confirmed to be the object the hop before it named.
func (r *workspaceResolver) open(logical string) (*workspaceFile, error) {
	for hop := 0; hop <= maxSymlinkHops; hop++ {
		if err := denySecretPath(logical); err != nil {
			return nil, err
		}
		wf, next, err := r.walk(logical)
		if err != nil {
			return nil, err
		}
		if wf != nil {
			return wf, nil
		}
		// A symlink: continue from the location it names, which the next turn
		// of this loop puts through the credential policy in its own right.
		logical = next
	}
	return nil, fmt.Errorf("resolve file %q: %w", r.requested, errTooManySymlinkHops)
}

// walk descends the components of logical under the resolver's root. It
// returns the opened file when the walk reaches something that is not a
// symlink, or the next logical path when a component turns out to be one.
func (r *workspaceResolver) walk(logical string) (*workspaceFile, string, error) {
	components := strings.Split(filepath.ToSlash(logical), "/")

	cur := r.root
	defer func() {
		if cur != r.root {
			cur.Close()
		}
	}()

	for i, component := range components {
		if component == "" || component == "." {
			continue
		}

		info, err := rootLstat(cur, component)
		if err != nil {
			return nil, "", r.lookupError(err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			next, err := r.follow(cur, components[:i], component, components[i+1:])
			return nil, next, err
		}
		if i == len(components)-1 {
			return r.openLeaf(cur, component, info, logical)
		}

		descended, err := cur.OpenRoot(component)
		if err != nil {
			return nil, "", r.lookupError(err)
		}
		// The directory that was opened must be the directory that was just
		// examined; anything else means the component was replaced in between.
		reached, err := rootSelfStat(descended)
		if err != nil {
			descended.Close()
			return nil, "", r.lookupError(err)
		}
		if !os.SameFile(info, reached) {
			descended.Close()
			return nil, "", errFileChangedWhileOpening
		}
		if cur != r.root {
			cur.Close()
		}
		cur = descended
	}

	// Every component was "." or empty: the path addresses the repository
	// directory itself, which the caller's read then rejects as a directory.
	return r.openLeaf(cur, ".", nil, ".")
}

// openLeaf opens the final component from the directory handle that holds it
// and confirms the descriptor refers to the object the walk examined.
func (r *workspaceResolver) openLeaf(cur *os.Root, component string, examined os.FileInfo, logical string) (*workspaceFile, string, error) {
	f, err := cur.Open(component)
	if err != nil {
		return nil, "", r.lookupError(err)
	}
	opened, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, "", fmt.Errorf("read file %q: %w", r.requested, err)
	}
	if examined != nil && !os.SameFile(examined, opened) {
		f.Close()
		return nil, "", errFileChangedWhileOpening
	}
	return &workspaceFile{file: f, info: opened, path: logical}, "", nil
}

// follow reads a symlink component and returns the repository-relative path
// the walk continues from, with any components that followed it reattached.
func (r *workspaceResolver) follow(cur *os.Root, prefix []string, component string, suffix []string) (string, error) {
	link, err := cur.Readlink(component)
	if err != nil {
		return "", r.lookupError(err)
	}

	// os.Root refuses a symlink whose text is absolute outright, but a
	// worktree may legitimately hold one pointing back inside the repository,
	// so an absolute target is mapped onto a repository-relative name; one
	// pointing out of the repository is refused here.
	var next string
	if link = filepath.FromSlash(link); filepath.IsAbs(link) {
		inside, ok := pathutil.RelWithinBase(r.repoRoot, filepath.Clean(link))
		if !ok {
			return "", fmt.Errorf("file path %q is outside repository", r.requested)
		}
		next = inside
	} else {
		next = filepath.Join(append(append([]string{}, prefix...), link)...)
	}

	next = filepath.Join(append([]string{next}, suffix...)...)
	// The reattached name may climb out of the repository with "..", which is
	// refused exactly as a requested path carrying one would be.
	contained, ok := pathutil.RelWithinBase(r.repoRoot, filepath.Join(r.repoRoot, next))
	if !ok {
		return "", fmt.Errorf("file path %q is outside repository", r.requested)
	}
	return contained, nil
}

// lookupError maps a failed lookup on the way to the file: a component that
// does not exist is the not-exist error this reader's callers surface for a
// path the model guessed at, and any other failure — a permission denial, a
// name that is not a directory — keeps its own diagnosis.
func (r *workspaceResolver) lookupError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read file %q: %w", r.requested, err)
	}
	return fmt.Errorf("resolve file %q: %w", r.requested, err)
}

func (fr *FileReader) readFromGitShow(parentCtx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(parentCtx, 30*time.Second)
	defer cancel()

	args := []string{"-c", "core.quotepath=false", "show", "--end-of-options", fr.Ref + ":" + path}
	if fr.Runner != nil {
		output, err := fr.Runner.Output(ctx, fr.RepoDir, args...)
		if err != nil {
			return "", fmt.Errorf("git show %s:%s: %w", fr.Ref, path, err)
		}
		return string(output), nil
	}

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = fr.RepoDir
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git show %s:%s: %w", fr.Ref, path, err)
	}
	return string(output), nil
}

// ReadLines returns a window of lines from the file plus the total line count.
// startLine is 1-based; maxLines is the maximum number of lines to collect.
//
// As in Read, a credential path is refused ahead of the mode switch, so the
// window cannot become a way to read a secret a whole-file read would refuse.
func (fr *FileReader) ReadLines(ctx context.Context, path string, startLine, maxLines int) ([]string, int, error) {
	if err := denySecretPath(path); err != nil {
		return nil, 0, err
	}
	switch fr.Mode {
	case ModeWorkspace:
		return fr.readLinesFromDisk(ctx, path, startLine, maxLines)
	case ModeRange, ModeCommit:
		innerCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return fr.readLinesFromGitShow(innerCtx, path, startLine, maxLines)
	default:
		return fr.readLinesFromDisk(ctx, path, startLine, maxLines)
	}
}

// scanLines reads from r line by line, collecting at most maxLines lines
// starting from startLine (1-based), while counting the total number of lines.
// The behavior matches strings.Split(content, "\n") for trailing-newline files.
func scanLines(r io.Reader, startLine, maxLines int) ([]string, int, error) {
	br := bufio.NewReader(r)
	var collected []string
	lineNum := 0
	lastHadNewline := false

	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			lineNum++
			lastHadNewline = line[len(line)-1] == '\n'
			trimmed := strings.TrimSuffix(line, "\n")
			trimmed = strings.TrimSuffix(trimmed, "\r")
			if lineNum >= startLine && len(collected) < maxLines {
				collected = append(collected, trimmed)
			}
		}
		if err != nil {
			if err != io.EOF {
				return nil, 0, err
			}
			break
		}
	}

	if lastHadNewline {
		lineNum++
		if lineNum >= startLine && len(collected) < maxLines {
			collected = append(collected, "")
		}
	}

	return collected, lineNum, nil
}

func (fr *FileReader) readLinesFromDisk(ctx context.Context, path string, startLine, maxLines int) ([]string, int, error) {
	f, err := fr.openWorkspaceFile(ctx, path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	return scanLines(f, startLine, maxLines)
}

func (fr *FileReader) readLinesFromGitShow(ctx context.Context, path string, startLine, maxLines int) ([]string, int, error) {
	args := []string{"-c", "core.quotepath=false", "show", "--end-of-options", fr.Ref + ":" + path}

	var collected []string
	var totalLines int

	if fr.Runner != nil {
		err := fr.Runner.Stream(ctx, fr.RepoDir, func(stdout io.Reader) error {
			var scanErr error
			collected, totalLines, scanErr = scanLines(stdout, startLine, maxLines)
			return scanErr
		}, args...)
		if err != nil {
			return nil, 0, fmt.Errorf("git show %s:%s: %w", fr.Ref, path, err)
		}
		return collected, totalLines, nil
	}

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = fr.RepoDir
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, 0, fmt.Errorf("git show %s:%s: %w", fr.Ref, path, err)
	}
	if err := cmd.Start(); err != nil {
		return nil, 0, fmt.Errorf("git show %s:%s: %w", fr.Ref, path, err)
	}

	collected, totalLines, scanErr := scanLines(stdoutPipe, startLine, maxLines)
	if scanErr != nil {
		cmd.Process.Kill()
	}
	waitErr := cmd.Wait()

	if scanErr != nil {
		return nil, 0, fmt.Errorf("git show %s:%s: %w", fr.Ref, path, scanErr)
	}
	if waitErr != nil {
		return nil, 0, fmt.Errorf("git show %s:%s: %w", fr.Ref, path, waitErr)
	}
	return collected, totalLines, nil
}
