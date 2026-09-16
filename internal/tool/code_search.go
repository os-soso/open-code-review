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
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	allowedext "github.com/alibaba/open-code-review/internal/config/allowlist"
)

const (
	gitGrepMaxCount = 100
	gitGrepTimeout  = 10 * time.Second
	// gitGrepPerlTimeout is the deadline for a -P search. A Perl-compatible
	// pattern comes from the model and decides for itself how long git spends
	// matching it, so it runs on a smaller budget than a literal search; the
	// shapes that backtrack exponentially are refused outright by
	// perlPatternRisk.
	gitGrepPerlTimeout = 5 * time.Second
	// gitGrepMaxPatternChars bounds the pattern accepted from the model, so
	// neither the argument vector nor git's matcher grows with whatever the
	// model chose to send.
	gitGrepMaxPatternChars = 1000
	// gitGrepMaxLineBytes is how much of one result row is kept. git grep
	// reports the whole matched line, and a generated or minified file can
	// hold a single line of megabytes; the head of the row is what locates
	// the match.
	gitGrepMaxLineBytes = 1024
	// gitGrepMaxReadBytes bounds the stdout read from one git grep run.
	// --max-count is a per-file limit, so a broad search can produce
	// gitGrepMaxCount+1 rows in every matching file: the ceiling stops the
	// bytes handled after the last reportable row from growing with the
	// repository.
	gitGrepMaxReadBytes = 8 << 20
	// gitGrepReadBufferBytes is the buffer that stdout stream is read through.
	gitGrepReadBufferBytes = 64 << 10
	// gitGrepMaxDiagnosticBytes bounds how much of git's stderr is repeated
	// back to the model, the session record and the terminal.
	gitGrepMaxDiagnosticBytes = 300
	// gitGrepTruncatedMarker ends a row or a diagnostic that was shortened, so
	// a cut value is never presented as a complete one.
	gitGrepTruncatedMarker = "...[truncated]"
	// grepMaxGroupNameRunes bounds the name a `(?<name>` introducer may carry
	// in a Perl pattern, so a malformed one cannot send the scanner looking
	// for its closing delimiter through the rest of the pattern.
	grepMaxGroupNameRunes = 64
)

// Notes that precede the results when a policy or a ceiling removed rows. They
// tell the model what was withheld and why without naming the paths.
const (
	grepSecretWithheldNote    = "Note: Matches in credential files were withheld by the secret-path policy.\n"
	grepIrregularWithheldNote = "Note: Matches in paths that are not regular files were withheld.\n"
)

// errGrepOutputBounded stops the stdout consumer once the reader holds every
// row it is allowed to report. It never escapes runGitGrep, which turns it
// back into the flag that drives the truncation note.
var errGrepOutputBounded = errors.New("git grep output bounded")

// CodeSearchProvider performs text search across the repository using git grep.
type CodeSearchProvider struct {
	FileReader *FileReader
}

func NewCodeSearch(fr *FileReader) *CodeSearchProvider { return &CodeSearchProvider{FileReader: fr} }

func (p *CodeSearchProvider) Tool() Tool { return CodeSearch }

func (p *CodeSearchProvider) Execute(ctx context.Context, args map[string]any) (string, error) {
	searchText, _ := args["search_text"].(string)
	caseSensitive, _ := args["case_sensitive"].(bool)
	usePerlRegexp, _ := args["use_perl_regexp"].(bool)

	filePatternsIface, _ := args["file_patterns"].([]any)
	var patterns []string
	for _, item := range filePatternsIface {
		if s, ok := item.(string); ok && s != "" {
			if hasTraversalPathComponent(s) {
				return "Error: file_patterns must not contain ..", nil
			}
			patterns = append(patterns, s)
		}
	}

	if strings.TrimSpace(searchText) == "" {
		return "Error: search_text is blank", nil
	}

	result, err := p.gitGrep(ctx, searchText, caseSensitive, usePerlRegexp, patterns)
	if err != nil {
		return "", err
	}
	return result, nil
}

func (p *CodeSearchProvider) buildGrepArgs(searchText string, caseSensitive bool, usePerlRegexp bool, noIndex bool, pathspec []string) []string {
	cmdArgs := []string{"--no-pager", "grep"}

	if noIndex {
		// Non-git directory: search the working tree directly while still
		// honoring .gitignore and skipping .git (via --exclude-standard).
		cmdArgs = append(cmdArgs, "--no-index", "--exclude-standard")
	} else if p.FileReader.Ref == "" {
		cmdArgs = append(cmdArgs, "--untracked")
	}

	if !caseSensitive {
		cmdArgs = append(cmdArgs, "-i")
	}
	if usePerlRegexp {
		cmdArgs = append(cmdArgs, "-P")
	} else {
		cmdArgs = append(cmdArgs, "-F")
	}

	cmdArgs = append(cmdArgs, "-n", "--no-color")
	// Ask for one row more than the cap per file: --max-count is a PER-FILE
	// limit, so gitGrep enforces the total itself and uses the extra row to
	// tell a genuinely truncated result from exactly gitGrepMaxCount matches.
	cmdArgs = append(cmdArgs, "--max-count", fmt.Sprintf("%d", gitGrepMaxCount+1))

	cmdArgs = append(cmdArgs, "-e", searchText)

	if ref := p.FileReader.Ref; ref != "" {
		if strings.HasPrefix(ref, "-") {
			// Defense-in-depth: reject option-like refs here even though
			// validateReviewRefs already verifies the ref upstream.
			// NOTE: git grep < 2.45 does not support --end-of-options before
			// the revision, so this is the one git invocation where we can't
			// rely on that separator.
			return nil
		}
		cmdArgs = append(cmdArgs, ref)
	}

	cmdArgs = append(cmdArgs, "--")
	cmdArgs = append(cmdArgs, pathspec...)

	return cmdArgs
}

func hasTraversalPathComponent(pathspec string) bool {
	// The check runs on the path, not on the magic signature git allows in
	// front of it: `:(exclude)../secret` and `:!../secret` are the same path
	// as `../secret`, and splitting the whole string on `/` would compare
	// `:(exclude)..` against `..` and find nothing.
	path := pathspec[pathspecMagicLen(pathspec):]
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// pathspecMagicLen returns how many leading bytes of a pathspec are git's
// magic signature rather than part of the path. git accepts a long form,
// `:(exclude,top)path`, and a short form built from `!` `^` and `/`, as in
// `:!path` or `:/path`; anything else after the colon is already the path.
//
// An unterminated long form is left whole, because git does not accept it as a
// signature either -- it reports `Missing ')' at the end of pathspec magic` --
// so treating its text as the path is what keeps the two readings aligned.
func pathspecMagicLen(pathspec string) int {
	if !strings.HasPrefix(pathspec, ":") {
		return 0
	}
	if strings.HasPrefix(pathspec, ":(") {
		if end := strings.IndexByte(pathspec, ')'); end >= 0 {
			return end + 1
		}
		return 0
	}
	n := 1
	for n < len(pathspec) && strings.IndexByte("!^/", pathspec[n]) >= 0 {
		n++
	}
	return n
}

// grepPatternBranch is one alternative of a group in a Perl pattern. literal
// holds the branch's text while it is still a plain literal; plain goes false
// as soon as the branch contains anything whose overlap with another branch
// cannot be read off the pattern -- a character class, a nested group, an
// optional element, a quantifier or a metacharacter.
type grepPatternBranch struct {
	literal string
	plain   bool
}

// grepPatternGroup is the state of one open group while a pattern is scanned.
type grepPatternGroup struct {
	quantified bool
	branches   []grepPatternBranch
}

// perlPatternRiskReason is what the model is told when its pattern is refused.
// It names the shape and the way out, because the model has to rewrite the
// pattern to get any result at all.
const perlPatternRiskReason = "repeating this group can match the same text in more than one way, so the search can hang; rewrite it with a character class"

// perlPatternRisk reports why a Perl-compatible pattern must not be handed to
// `git grep -P`, or "" when it may run. The pattern is model input, and PCRE
// backtracking turns exponential when a repeated group can match the same text
// in more than one way. A quantified group is therefore refused when either
// holds:
//
//   - its body carries a quantifier of its own, an optional element included
//     -- `(a+)+`, `(\w+\s*)+`, `(a?a)+` -- so each repetition can absorb a
//     different number of characters;
//   - its branches are not clearly distinct: one is a prefix of another as in
//     `(a|aa)+`, or one is something other than a plain literal as in
//     `(\w|\d)+`, where the overlap cannot be read off the pattern.
//
// Alternation between distinct literals is unambiguous and matches in linear
// time, so `(cat|dog)+` and `(?:GET|POST|PUT)*` are accepted, as is every
// pattern the tool description advertises -- `class.*extends.*BaseModel`,
// `functionName(.*)` and `error|exception|fail`.
//
// caseSensitive is the search's own setting, because branches that differ only
// in case -- `(A|a)+` -- are the same branch to a case-insensitive match. An
// inline `(?i` flag in the pattern has the same effect and is read as such.
func perlPatternRisk(pattern string, caseSensitive bool) string {
	var stack []grepPatternGroup
	runes := []rune(pattern)
	inClass := false
	// Where the current character class's contents begin: a `]` there is a
	// literal bracket rather than the end of the class.
	classBody := 0
	fold := !caseSensitive || strings.Contains(pattern, "(?i")
	extended := perlExtendedMode(runes)

	// The three writers below all act on the innermost open group; outside any
	// group there is nothing to record, because only a group can be repeated.
	markNotPlain := func() {
		if len(stack) == 0 {
			return
		}
		g := &stack[len(stack)-1]
		g.branches[len(g.branches)-1].plain = false
	}
	addLiteral := func(r rune) {
		if len(stack) == 0 {
			return
		}
		if fold {
			r = unicode.ToLower(r)
		}
		g := &stack[len(stack)-1]
		if b := &g.branches[len(g.branches)-1]; b.plain {
			b.literal += string(r)
		}
	}
	markQuantified := func() {
		if len(stack) > 0 {
			stack[len(stack)-1].quantified = true
		}
	}
	// quantifierAfter measures the quantifier that applies to the group
	// closing at runes[i], looking past whatever extended mode ignores: in
	// `(?x)(a+) +` the `+` applies to the group even though a space sits
	// between them.
	quantifierAfter := func(i int) int {
		j := i + 1
		for extended && j < len(runes) {
			switch {
			case unicode.IsSpace(runes[j]):
				j++
			case runes[j] == '#':
				for j < len(runes) && runes[j] != '\n' {
					j++
				}
			default:
				return quantifierLen(runes, j)
			}
		}
		return quantifierLen(runes, j)
	}

	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case inClass:
			switch {
			case r == '\\':
				// An escaped rune inside a class is inert, including `\]`.
				i++
			case r == ']' && i > classBody:
				inClass = false
			}
		case r == '\\':
			if i+1 >= len(runes) {
				// Trailing backslash; git rejects the pattern itself.
				markNotPlain()
				continue
			}
			// An escaped punctuation mark is the literal character; an escaped
			// letter or digit names a class (\w, \d, \s and the rest), which
			// can overlap whatever another branch matches.
			if next := runes[i+1]; unicode.IsLetter(next) || unicode.IsDigit(next) {
				markNotPlain()
			} else {
				addLiteral(next)
			}
			i++
		case extended && unicode.IsSpace(r):
			// Extended mode: unescaped whitespace is not part of the pattern,
			// so `(?x)(a+) +` is `(a+)+` and has to be read as one.
		case extended && r == '#':
			// Extended mode: a comment runs to the end of the line.
			for i+1 < len(runes) && runes[i+1] != '\n' {
				i++
			}
		case r == '[':
			inClass = true
			classBody = i + 1
			if classBody < len(runes) && runes[classBody] == '^' {
				// `[^]]` excludes a literal bracket, so the contents start
				// after the negation.
				classBody++
			}
			markNotPlain()
		case r == '(':
			// The branch now holds a group rather than a literal.
			markNotPlain()
			stack = append(stack, grepPatternGroup{branches: []grepPatternBranch{{plain: true}}})
			// Step over a `(?...` introducer -- non-capturing, flags, named or
			// lookaround -- so the group's first branch starts on its actual
			// contents: `(?:cat|dog)+` is as unambiguous as `(cat|dog)+`.
			i += groupIntroLen(runes, i)
		case r == ')':
			if len(stack) == 0 {
				// Unbalanced pattern; git rejects it with its own diagnostic.
				continue
			}
			body := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			ambiguous := body.quantified || ambiguousBranches(body.branches)
			quantified := quantifierAfter(i) > 0
			if ambiguous && quantified {
				return perlPatternRiskReason
			}
			// To an enclosing group, an ambiguous or repeated body is as good
			// as a quantifier in its own body.
			if ambiguous || quantified {
				markQuantified()
			}
		case r == '|':
			if len(stack) > 0 {
				g := &stack[len(stack)-1]
				g.branches = append(g.branches, grepPatternBranch{plain: true})
			}
		case r == '?':
			// An optional element makes the body ambiguous exactly as a
			// repetition does: `(a?a)+` absorbs one or two characters each
			// time round, which is `(a|aa)+` written differently.
			markNotPlain()
			markQuantified()
		case r == '.', r == '^', r == '$':
			markNotPlain()
		default:
			if n := quantifierLen(runes, i); n > 0 {
				markQuantified()
				markNotPlain()
				i += n - 1
				continue
			}
			addLiteral(r)
		}
	}
	return ""
}

// perlExtendedMode reports whether the pattern turns on PCRE's extended mode,
// in which unescaped whitespace and `#` comments are ignored: `(?x)(a+) +` is
// `(a+)+` to the matcher, and a scanner that read the space as pattern text
// would miss that the group is repeated.
//
// Any `x` among the flag letters of any inline flag group switches it on for
// the whole pattern here rather than for the scope PCRE would give it. That
// errs the safe way: reading more whitespace as ignorable can only make a
// group's quantifier more visible, never less.
func perlExtendedMode(runes []rune) bool {
	for i := 0; i+2 < len(runes); i++ {
		if runes[i] != '(' || runes[i+1] != '?' {
			continue
		}
		for j := i + 2; j < len(runes); j++ {
			if runes[j] == 'x' {
				return true
			}
			if !unicode.IsLetter(runes[j]) && runes[j] != '-' {
				break
			}
		}
	}
	return false
}

// groupIntroLen returns how many runes after the `(` at runes[i] belong to a
// group introducer rather than to the group's contents: `?:` for a
// non-capturing group, `?=` `?!` `?<=` `?<!` for a lookaround, `?>` for an
// atomic group, `?<name>` `?P<name>` `?'name'` for a named group, and the flag
// letters of `?i` `?im-sx:`.
//
// It returns 0 for a plain capturing group and for any form it does not
// recognize, rather than guessing how far the introducer runs: the `?` is then
// read as an ordinary metacharacter, which makes the branch non-literal and so
// only ever refuses more patterns. Every scan here is bounded, because an
// introducer that swallowed part of the pattern would hide whatever it skipped
// from the ambiguity check this function serves.
func groupIntroLen(runes []rune, i int) int {
	if i+1 >= len(runes) || runes[i+1] != '?' {
		return 0
	}
	j := i + 2 // the rune after '?'
	if j >= len(runes) {
		return 0
	}
	switch runes[j] {
	case ':', '=', '!', '>':
		return j + 1 - (i + 1)
	case '<':
		// Lookbehind `(?<=` / `(?<!`, otherwise a named group `(?<name>`.
		if j+1 < len(runes) && (runes[j+1] == '=' || runes[j+1] == '!') {
			return j + 2 - (i + 1)
		}
		if end := scanGroupName(runes, j+1, '>'); end >= 0 {
			return end + 1 - (i + 1)
		}
	case 'P':
		// Only `(?P<name>` is read here; `(?P=name)` and `(?P>name)` are left
		// unrecognized rather than assumed.
		if j+1 < len(runes) && runes[j+1] == '<' {
			if end := scanGroupName(runes, j+2, '>'); end >= 0 {
				return end + 1 - (i + 1)
			}
		}
	case '\'':
		if end := scanGroupName(runes, j+1, '\''); end >= 0 {
			return end + 1 - (i + 1)
		}
	default:
		// Inline flags: letters and '-', optionally ending in ':'. The ')' of
		// a bare `(?i)` is left for the scanner to see as the group's end.
		for j < len(runes) && (unicode.IsLetter(runes[j]) || runes[j] == '-') {
			j++
		}
		if j == i+2 {
			// Not a flag list -- `(?#comment)` and the like.
			return 0
		}
		if j < len(runes) && runes[j] == ':' {
			return j + 1 - (i + 1)
		}
		return j - (i + 1)
	}
	return 0
}

// scanGroupName returns the index of the delimiter that closes a group name
// starting at runes[j], or -1 when what follows is not a name: a name is at
// most grepMaxGroupNameRunes word characters, so the search cannot run on into
// the rest of the pattern looking for a delimiter that is not there.
func scanGroupName(runes []rune, j int, close rune) int {
	for n := 0; j < len(runes) && n <= grepMaxGroupNameRunes; j, n = j+1, n+1 {
		if runes[j] == close {
			return j
		}
		if !unicode.IsLetter(runes[j]) && !unicode.IsDigit(runes[j]) && runes[j] != '_' {
			return -1
		}
	}
	return -1
}

// ambiguousBranches reports whether repeating a group that alternates between
// these branches could match the same text in more than one way. Two branches
// are distinct when both are plain literals and neither is a prefix of the
// other; an empty branch, or one holding anything but a literal, is treated as
// overlapping, because the pattern does not say whether it is.
func ambiguousBranches(branches []grepPatternBranch) bool {
	if len(branches) < 2 {
		return false
	}
	for _, b := range branches {
		if !b.plain || b.literal == "" {
			return true
		}
	}
	for i, a := range branches {
		for j, b := range branches {
			if i != j && strings.HasPrefix(a.literal, b.literal) {
				return true
			}
		}
	}
	return false
}

// grepBudget is how long one git grep run may take. A Perl-compatible pattern
// is model input whose matching cost it chooses itself, so -P searches get the
// smaller budget; a literal search costs what the repository costs and keeps
// the full one.
func grepBudget(usePerlRegexp bool) time.Duration {
	if usePerlRegexp {
		return gitGrepPerlTimeout
	}
	return gitGrepTimeout
}

// quantifierLen returns the rune length of the repetition operator starting at
// runes[i], or 0 when there is none. The forms it reads are `*`, `+` and the
// `{n}`, `{n,}` and `{n,m}` family, which is what makes a group's repetition
// count ambiguous; a bare `?` is not a repetition and is handled by the
// scanner itself, which treats an optional element in a body the same way.
func quantifierLen(runes []rune, i int) int {
	if i >= len(runes) {
		return 0
	}
	switch runes[i] {
	case '*', '+':
		return 1
	case '{':
		j := i + 1
		digits := 0
		for j < len(runes) && runes[j] >= '0' && runes[j] <= '9' {
			j++
			digits++
		}
		if digits == 0 {
			return 0
		}
		if j < len(runes) && runes[j] == ',' {
			j++
			for j < len(runes) && runes[j] >= '0' && runes[j] <= '9' {
				j++
			}
		}
		if j < len(runes) && runes[j] == '}' {
			return j + 1 - i
		}
	}
	return 0
}

// grepRowFilter decides whether one raw result row may be reported. A row it
// rejects is dropped as it is read and does not count against the result cap,
// so a credential file with more matches than the cap cannot spend the budget
// belonging to the files after it. A nil filter keeps every row.
type grepRowFilter func(row string) bool

// readGrepRows reads git grep's stdout under three ceilings, so the memory the
// provider holds cannot grow with the size of the repository: at most
// gitGrepMaxCount+1 rows kept by the filter (the lookahead row that tells a
// genuinely truncated result from exactly gitGrepMaxCount matches), at most
// gitGrepMaxLineBytes kept per row, and at most gitGrepMaxReadBytes taken from
// the pipe in total. Bytes past a row's ceiling are still read, so the row
// boundary stays correct, but are never retained.
//
// bounded reports that reading stopped before the end of the output, which
// means reportable rows were dropped and the caller must say so. Empty rows
// are not returned: git writes one result per line, so a blank line is only
// the output's trailing newline.
func readGrepRows(r io.Reader, keep grepRowFilter) (rows []string, bounded bool, err error) {
	br := bufio.NewReaderSize(r, gitGrepReadBufferBytes)
	rows = make([]string, 0, gitGrepMaxCount+1)

	var (
		row       []byte
		rowCut    bool
		readBytes int
	)
	for {
		chunk, readErr := br.ReadSlice('\n')
		readBytes += len(chunk)

		// The terminator is not part of the row, so it is dropped before the
		// ceiling is applied: a row whose content exactly fills the ceiling is
		// complete and must not be marked as shortened.
		text := chunk
		if readErr == nil {
			text = bytes.TrimSuffix(text, []byte("\n"))
			text = bytes.TrimSuffix(text, []byte("\r"))
		}
		if room := gitGrepMaxLineBytes - len(row); room > 0 {
			if len(text) > room {
				row = append(row, text[:room]...)
				rowCut = true
			} else {
				row = append(row, text...)
			}
		} else if len(text) > 0 {
			rowCut = true
		}

		switch {
		case readErr == nil, errors.Is(readErr, io.EOF):
			if line := finishGrepRow(row, rowCut); line != "" && (keep == nil || keep(line)) {
				rows = append(rows, line)
			}
			row, rowCut = row[:0], false
			if errors.Is(readErr, io.EOF) {
				return rows, false, nil
			}
			if len(rows) > gitGrepMaxCount {
				return rows, true, nil
			}
		case errors.Is(readErr, bufio.ErrBufferFull):
			// The row is longer than the read buffer; keep reading it.
		default:
			return rows, false, readErr
		}

		if readBytes >= gitGrepMaxReadBytes {
			// Stopped mid-row: report the head that was kept, marked as cut.
			if len(row) > 0 {
				if line := finishGrepRow(row, true); line != "" && (keep == nil || keep(line)) {
					rows = append(rows, line)
				}
			}
			return rows, true, nil
		}
	}
}

// finishGrepRow trims the row terminator and, for a row that was cut at a byte
// ceiling, drops the partial trailing rune and marks the row as shortened, so
// the model is never shown a cut line as if it were complete.
func finishGrepRow(row []byte, cut bool) string {
	line := strings.TrimRight(string(row), "\r\n")
	if !cut {
		return line
	}
	return strings.ToValidUTF8(line, "") + gitGrepTruncatedMarker
}

// runGitGrep executes git grep under the given deadline and returns the
// bounded stdout rows the filter kept, whether reading stopped short of the
// end of the output, and the command's stderr. stdout is streamed rather than
// buffered: because --max-count caps matches per file, a broad search can emit
// far more than the provider may report, and none of that has to be held in
// memory to be thrown away. Once the reader has its rows the subprocess is
// stopped instead of being allowed to finish writing.
func (p *CodeSearchProvider) runGitGrep(parentCtx context.Context, budget time.Duration, cmdArgs []string, keep grepRowFilter) ([]string, bool, string, error) {
	ctx, cancel := context.WithTimeout(parentCtx, budget)
	defer cancel()

	var (
		rows    []string
		bounded bool
		readErr error
	)
	consume := func(stdout io.Reader) error {
		rows, bounded, readErr = readGrepRows(stdout, keep)
		if readErr != nil {
			return readErr
		}
		if bounded {
			// Everything past the ceilings would be read and dropped, so stop
			// git here: returning an error kills the subprocess.
			return errGrepOutputBounded
		}
		return nil
	}

	if p.FileReader.Runner != nil {
		errStr, err := p.FileReader.Runner.StreamSplit(ctx, p.FileReader.RepoDir, consume, cmdArgs...)
		switch {
		case errors.Is(err, errGrepOutputBounded):
			// Our own stop, not a git failure: the kill's wait status and any
			// partial diagnostic say nothing about the rows in hand.
			return rows, true, "", nil
		case readErr != nil:
			return nil, false, errStr, p.readFailure(readErr)
		case ctx.Err() != nil && err != nil:
			return nil, false, "", ctx.Err()
		case err != nil && !isExitError(err):
			// Not a verdict from git but a failure to run it: its message
			// names the checkout, so it is bounded and redacted here.
			return nil, false, "", p.startFailure(err)
		}
		return rows, false, errStr, err
	}

	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	cmd.Dir = p.FileReader.RepoDir

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, "", p.startFailure(err)
	}
	if err := cmd.Start(); err != nil {
		return nil, false, "", p.startFailure(err)
	}
	if consumeErr := consume(stdout); consumeErr != nil {
		// Reading stopped early, so git may still be writing into a pipe that
		// nobody drains. The kill is what lets cmd.Wait() below return.
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()

	switch {
	case readErr != nil:
		return nil, false, stderr.String(), p.readFailure(readErr)
	case bounded:
		return rows, true, "", nil
	case ctx.Err() != nil && waitErr != nil && cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == -1:
		return nil, false, "", ctx.Err()
	}
	return rows, false, stderr.String(), waitErr
}

func (p *CodeSearchProvider) gitGrep(ctx context.Context, searchText string, caseSensitive bool, usePerlRegexp bool, pathspec []string) (string, error) {
	// Both input guards sit here rather than in Execute: gitGrep is the single
	// point every search passes through before a git process exists.
	if utf8.RuneCountInString(searchText) > gitGrepMaxPatternChars {
		return fmt.Sprintf("Error: search_text must be at most %d characters", gitGrepMaxPatternChars), nil
	}
	if usePerlRegexp {
		if risk := perlPatternRisk(searchText, caseSensitive); risk != "" {
			return "Error: use_perl_regexp pattern rejected: " + risk, nil
		}
	}

	cmdArgs := p.buildGrepArgs(searchText, caseSensitive, usePerlRegexp, false, pathspec)
	if cmdArgs == nil {
		return "Error: ref must not start with '-'", nil
	}

	hasRef := p.FileReader.Ref != ""

	// The path policy runs while stdout is read, not after: a row it withholds
	// is dropped as it arrives and does not count against the result cap, so a
	// credential file with more matches than the cap cannot spend the budget of
	// the files after it. One verdict per path is cached, so a path is checked
	// once however many times it matched.
	verdicts := make(map[string]grepPathVerdict)
	var withheldSecret, withheldIrregular bool
	keep := func(row string) bool {
		switch p.rowVerdict(row, hasRef, verdicts) {
		case grepPathSecret:
			withheldSecret = true
			return false
		case grepPathIrregular:
			withheldIrregular = true
			return false
		}
		return true
	}

	budget := grepBudget(usePerlRegexp)
	rows, bounded, errStr, err := p.runGitGrep(ctx, budget, cmdArgs, keep)

	// Non-git directory: `git grep` exits 128 with "not a git repository".
	// `ocr scan` supports plain directories, so retry in --no-index mode, which
	// searches the working tree directly while still honoring .gitignore.
	// Ref-based search needs a real repo, so it is not retried.
	if err != nil && p.FileReader.Ref == "" && isNotGitRepoError(err, errStr) {
		cmdArgs = p.buildGrepArgs(searchText, caseSensitive, usePerlRegexp, true, pathspec)
		rows, bounded, errStr, err = p.runGitGrep(ctx, budget, cmdArgs, keep)
	}

	exitCode := -1
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return "", fmt.Errorf("git grep timed out; try narrowing file_patterns to a more specific path: %w", err)
		}
		if errors.Is(err, context.Canceled) {
			return "", err
		}
		if len(rows) == 0 {
			if errStr == "" && exitCode == 1 {
				return "No matches found", nil
			}
			return "", fmt.Errorf("git grep failed: %w: %s", err,
				grepFailureClass(trimGitUsage(errStr, exitCode), exitCode))
		}
	}

	// --max-count is per file, so the total is bounded here: the reader stops
	// one row past the cap, and anything beyond gitGrepMaxCount rows -- or
	// past the byte ceiling, which is what bounded reports -- is dropped and
	// flagged in the note below.
	truncated := bounded || len(rows) > gitGrepMaxCount
	if len(rows) > gitGrepMaxCount {
		rows = rows[:gitGrepMaxCount]
	}

	type match struct {
		lineNum int
		content string
	}
	fileMatches := make(map[string][]match)
	var fileOrder []string
	seen := make(map[string]bool)

	for _, line := range rows {
		fname, lineNum, content, parsed := parseGrepRow(line, hasRef)
		if !parsed {
			continue
		}
		if !seen[fname] {
			seen[fname] = true
			fileOrder = append(fileOrder, fname)
		}
		fileMatches[fname] = append(fileMatches[fname], match{lineNum: lineNum, content: content})
	}

	var sb strings.Builder
	if truncated {
		// The note states what was kept. That is the cap whenever the cap is
		// what stopped the read, and the rows in hand when the byte ceiling
		// stopped it first -- saying "first 100" for five rows would be the
		// same false claim the cap itself exists to retire.
		shown := gitGrepMaxCount
		if len(rows) < shown {
			shown = len(rows)
		}
		sb.WriteString(fmt.Sprintf("Note: The results have been truncated. Only showing first %d results.\n", shown))
	}
	sb.WriteString(grepPolicyNotes(withheldSecret, withheldIrregular))

	for _, path := range fileOrder {
		matches := fileMatches[path]
		sb.WriteString(fmt.Sprintf("File: %s\nMatch lines: %d\n", path, len(matches)))
		for _, m := range matches {
			sb.WriteString(fmt.Sprintf("%d|%s\n", m.lineNum, m.content))
		}
		sb.WriteString("\n")
	}

	if err != nil && errStr != "" {
		sb.WriteString(fmt.Sprintf("Warning: %s\n",
			grepFailureClass(trimGitUsage(errStr, exitCode), exitCode)))
	}

	return sb.String(), nil
}

// rowVerdict is the policy decision for one raw result row: the strictest
// verdict of every path the row could be naming. git separates the path, the
// line number and the matched text with colons and a path may itself contain
// one, so `safe:123:dir/.env:1:TOKEN=x` names either `safe` at line 123 or
// `safe:123:dir/.env` at line 1. Reading only the first of those would report
// a credential file on the strength of a reading that happens to be allowed,
// so every candidate is checked and the strictest answer wins. cache carries
// one verdict per distinct path for the life of the search.
func (p *CodeSearchProvider) rowVerdict(row string, hasRef bool, cache map[string]grepPathVerdict) grepPathVerdict {
	verdict := grepPathAllowed
	for _, reading := range grepRowReadings(row, hasRef) {
		path := reading.path
		candidate, decided := cache[path]
		if !decided {
			candidate = p.pathVerdict(path)
			cache[path] = candidate
		}
		switch candidate {
		case grepPathSecret:
			// Nothing outranks the secret denylist; no need to look further.
			return grepPathSecret
		case grepPathIrregular:
			verdict = grepPathIrregular
		}
	}
	return verdict
}

// grepRowReading is one way a raw result row can be read: a path, the line
// number that follows it and the matched text after that.
type grepRowReading struct {
	path    string
	lineNum int
	content string
}

// grepRowReadings returns every way a raw result row can be read, in the order
// the row admits them. It is the single place a row is taken apart: the
// formatter displays the first reading and the path policy checks all of them,
// so the two can never disagree about where a path ends.
//
// A reading ends wherever a line-number field followed by at least one more
// field begins, since that field is where git put the line number. Both the
// path and the content may contain colons, so `safe:9:dir/a.go:1:x` reads
// either as `safe` at line 9 or as `safe:9:dir/a.go` at line 1. A row that is
// not a result at all -- "Binary file x matches" and the like -- yields none.
func grepRowReadings(row string, hasRef bool) []grepRowReading {
	fields := strings.Split(row, ":")
	offset := 0
	if hasRef {
		offset = 1
	}
	var readings []grepRowReading
	for k := offset; k <= len(fields)-3; k++ {
		lineNum, numbered := lineNumberValue(fields[k+1])
		if !numbered {
			continue
		}
		readings = append(readings, grepRowReading{
			path:    strings.Join(fields[offset:k+1], ":"),
			lineNum: lineNum,
			content: strings.Join(fields[k+2:], ":"),
		})
	}
	return readings
}

// grepMaxLineNumberDigits bounds what is read as a line number. git's own line
// numbers are far shorter, so a longer run of digits is matched content rather
// than a line number, and refusing it keeps the value inside an int.
const grepMaxLineNumberDigits = 18

// lineNumberValue reads a field as the line number git writes between the path
// and the matched text, and reports whether it is one. Only digits qualify:
// strconv.Atoi would also accept a leading sign, and taking `-1` for a line
// number would end a path candidate in the wrong place and so hide the path
// that follows it from the policy in rowVerdict.
func lineNumberValue(field string) (int, bool) {
	if field == "" || len(field) > grepMaxLineNumberDigits {
		return 0, false
	}
	value := 0
	for _, r := range field {
		if r < '0' || r > '9' {
			return 0, false
		}
		value = value*10 + int(r-'0')
	}
	return value, true
}

// parseGrepRow reads a raw result row as the path it matched in, the line
// number and the matched text. git writes `<file>:<line>:<content>`, or
// `<ref>:<file>:<line>:<content>` when a ref was searched, and also writes
// lines that are not results at all, such as "Binary file x matches"; parsed
// is false for those.
//
// A row whose path or content contains a colon can be read more than one way
// (see grepRowReadings). The first reading is what is displayed, because a
// path without colons is the ordinary case and reading it any other way would
// mis-split every row whose matched text happens to contain `:<digits>:`. The
// path policy does not rely on this choice: it checks every reading, so a row
// is withheld whenever any reading of it names a path that must not be
// reported.
func parseGrepRow(row string, hasRef bool) (path string, lineNum int, content string, parsed bool) {
	readings := grepRowReadings(row, hasRef)
	if len(readings) == 0 {
		return "", 0, "", false
	}
	first := readings[0]
	return first.path, first.lineNum, first.content, true
}

// grepPolicyNotes is the prefix that tells the model which rows a policy
// removed before the results were assembled. Each note names the policy that
// withheld the rows, never the path it withheld.
func grepPolicyNotes(withheldSecret, withheldIrregular bool) string {
	var sb strings.Builder
	if withheldSecret {
		sb.WriteString(grepSecretWithheldNote)
	}
	if withheldIrregular {
		sb.WriteString(grepIrregularWithheldNote)
	}
	return sb.String()
}

// grepPathVerdict is the policy decision for one matched path.
type grepPathVerdict int

const (
	// grepPathAllowed means the path's rows may be reported to the model.
	grepPathAllowed grepPathVerdict = iota
	// grepPathSecret means the path is on the built-in secret denylist.
	grepPathSecret
	// grepPathIrregular means the path is not a regular file in the worktree.
	grepPathIrregular
)

// pathVerdict decides whether the rows of one matched path may be reported.
// Two policies apply, in order:
//
//   - The built-in secret-path denylist. git grep matches inside a credential
//     file as readily as anywhere else -- tracked, or untracked and not
//     ignored -- and a reported row is sent to the model and persisted in the
//     session record. The denylist is the same one that keeps those paths out
//     of the review scope, so a search cannot reach what a review may not.
//   - Repository containment. Only regular files are reported. git does not
//     read through a symlink, but a link's own content is the path it points
//     at, so a non-regular entry is withheld rather than described. The check
//     reads the worktree and is therefore skipped for a ref search, whose
//     content comes from the object store; a path git named but that cannot be
//     stat'd is reported, since git read its bytes from the repository.
//
// A hard link is an ordinary regular file to both git and the filesystem, so
// bytes it shares with an inode outside the repository stay searchable. That
// limitation is documented with the tool rather than guessed at here: a link
// count is not portable across the platforms this binary targets, and every
// alternative reading of it would withhold legitimate matches.
func (p *CodeSearchProvider) pathVerdict(path string) grepPathVerdict {
	if allowedext.IsSecretPath(path) {
		return grepPathSecret
	}
	if p.FileReader.Ref != "" {
		return grepPathAllowed
	}
	info, err := os.Lstat(filepath.Join(p.FileReader.RepoDir, path))
	if err != nil {
		return grepPathAllowed
	}
	if !info.Mode().IsRegular() {
		return grepPathIrregular
	}
	return grepPathAllowed
}

func trimGitUsage(stderr string, exitCode int) string {
	stderr = strings.TrimSpace(stderr)
	if exitCode == 129 {
		if idx := strings.IndexByte(stderr, '\n'); idx >= 0 {
			stderr = stderr[:idx]
		}
	}
	return strings.TrimSpace(stderr)
}

// gitAbsolutePathPattern matches an absolute path where one can start: at the
// beginning of the text, or after whitespace, a quote or an opening bracket.
// A POSIX path needs a leading slash and at least one more character, and a
// Windows path a drive letter and a separator, so neither a lone slash nor a
// regex escape such as \w is mistaken for one. Repository-relative paths are
// left alone: they carry no host detail and are exactly what the model needs.
var gitAbsolutePathPattern = regexp.MustCompile(`(^|[\s'"(=:\[])((?:[A-Za-z]:[\\/]|/)[^\s'":()\[\]]+)`)

// startFailure reports a failure to run git at all -- a semaphore, pipe or
// exec failure. Its cause is an os/exec error whose message names the checkout
// ("chdir /home/u/repo: no such file or directory"), so the message is bounded
// and redacted before it can reach the model, the session record or the
// terminal. The cause is not wrapped, because only its text carried anything
// and that text is what had to go.
func (p *CodeSearchProvider) startFailure(err error) error {
	if isContextError(err) {
		// The caller's own cancellation, which gitGrep maps itself; it says
		// nothing about git and must keep its identity for errors.Is.
		return err
	}
	if detail := p.sanitizeErrorText(err.Error()); detail != "" {
		return fmt.Errorf("git grep could not be started: %s", detail)
	}
	return errors.New("git grep could not be started")
}

// readFailure reports a failure to read git's output, with the same bounding
// and redaction and for the same reason.
func (p *CodeSearchProvider) readFailure(err error) error {
	if isContextError(err) {
		return err
	}
	if detail := p.sanitizeErrorText(err.Error()); detail != "" {
		return fmt.Errorf("git grep output could not be read: %s", detail)
	}
	return errors.New("git grep output could not be read")
}

// isContextError reports whether the error is the caller's cancellation or
// deadline rather than anything about git.
func isContextError(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// isExitError reports whether the error is git's own non-zero exit, as opposed
// to a failure to run it in the first place.
func isExitError(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr)
}

// grepFailureClass maps a git grep failure to a fixed message. Nothing git
// wrote is repeated: its diagnostics reach the model, the session record and
// the operator's terminal, and they carry both the absolute path of the
// checkout -- `'/etc/hostname' is outside repository at '/home/u/repo'` -- and
// whatever bytes the model put in its pattern, which git echoes back. The
// markers below are read to tell the failures apart and then discarded, and an
// unrecognized failure is reported by its exit status, which says as much as
// can be said without quoting anything.
func grepFailureClass(stderr string, exitCode int) string {
	s := strings.ToLower(stderr)
	switch {
	case strings.Contains(s, "not a git repository"):
		return "the directory is not a git repository"
	case strings.Contains(s, "outside repository"), strings.Contains(s, "outside the directory tree"):
		return "a file_pattern is outside the repository"
	case strings.Contains(s, "unknown revision"), strings.Contains(s, "unable to resolve revision"),
		strings.Contains(s, "ambiguous argument"), strings.Contains(s, "bad revision"):
		return "the requested revision could not be resolved"
	case strings.Contains(s, "-e option"), strings.Contains(s, "pcre"), strings.Contains(s, "regex"),
		strings.Contains(s, "missing terminating"), strings.Contains(s, "unmatched"),
		strings.Contains(s, "quantifier"):
		return "git rejected the search pattern"
	case exitCode == 129, strings.Contains(s, "unknown option"), strings.Contains(s, "usage: git grep"):
		return "git rejected the search options"
	case strings.Contains(s, "did not match any file"), strings.Contains(s, "pathspec"):
		return "a file_pattern did not match any file"
	case exitCode >= 0:
		return fmt.Sprintf("git exited with status %d", exitCode)
	}
	return "git grep could not be completed"
}

// sanitizeErrorText bounds and de-fangs text that is not one of those fixed
// messages but still has to reach the caller -- a failure to start git, whose
// cause names the checkout ("chdir /home/u/repo: no such file or directory"),
// or a failure to read its output. The text is flattened to one line, emptied
// of the control characters that could forge console output, cleared of
// absolute paths, and shortened.
func (p *CodeSearchProvider) sanitizeErrorText(text string) string {
	diag := stripControlRunes(text)
	if diag == "" {
		return ""
	}
	// The checkout path is replaced first and by itself, so that what follows
	// it in a message stays readable as a repository-relative path.
	if dir := strings.TrimRight(p.FileReader.RepoDir, `/\`); dir != "" && filepath.IsAbs(dir) {
		diag = strings.ReplaceAll(diag, dir, "<path>")
	}
	diag = gitAbsolutePathPattern.ReplaceAllString(diag, "${1}<path>")
	return truncateDiagnostic(diag)
}

// stripControlRunes collapses a diagnostic onto a single line: every run of
// whitespace becomes one space, and every other control rune -- an escape
// starting an ANSI or OSC sequence, a carriage return rewriting the line, a
// byte that is not valid UTF-8 -- is dropped rather than passed to a terminal
// or into a JSON tool result.
func stripControlRunes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		switch {
		case r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f':
			if !space && b.Len() > 0 {
				b.WriteByte(' ')
				space = true
			}
		case unicode.IsControl(r), r == utf8.RuneError:
			// Dropped: never repeated to a terminal or to the model.
		default:
			b.WriteRune(r)
			space = false
		}
	}
	return strings.TrimSpace(b.String())
}

// truncateDiagnostic bounds a diagnostic at gitGrepMaxDiagnosticBytes, cutting
// on a rune boundary and marking the result so a shortened message is not read
// as a whole one.
func truncateDiagnostic(s string) string {
	if len(s) <= gitGrepMaxDiagnosticBytes {
		return s
	}
	cut := strings.ToValidUTF8(s[:gitGrepMaxDiagnosticBytes], "")
	return strings.TrimSpace(cut) + gitGrepTruncatedMarker
}

func isNotGitRepoError(err error, stderr string) bool {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 128 &&
		(strings.Contains(stderr, "not a git repository") || strings.Contains(stderr, ".git")) {
		return true
	}
	return false
}
