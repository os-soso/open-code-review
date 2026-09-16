// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package allowedext

import (
	_ "embed"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bmatcuk/doublestar/v4"
)

// Secret paths are kept apart from default_exclude_patterns.json on purpose:
// the default exclude list holds review noise that an include rule is allowed
// to bring back, while these paths must not enter the review scope at all, so
// no include rule can admit them. Matching follows the same glob and case rules
// as IsExcludedPath (see the package comment in allowed_ext.go for the syntax),
// with one addition: the path is normalized first, because this list is also
// consulted for paths that arrive from outside the diff pipeline — a model's
// `file_path` tool argument, for instance — where the spelling is not ours.

//go:embed default_secret_patterns.json
var secretData []byte

var (
	secretPatterns []string // raw patterns from JSON, lowercased by initSecret
	secretOnce     sync.Once
)

func initSecret() {
	if err := json.Unmarshal(secretData, &secretPatterns); err != nil {
		panic("allowedext: failed to parse default_secret_patterns.json: " + err.Error())
	}
	for i, p := range secretPatterns {
		secretPatterns[i] = strings.ToLower(p)
	}
}

// IsSecretPath returns true when the given file path matches any built-in
// secret pattern — credential files such as .env, id_rsa or .netrc that should
// never be sent to a model as part of a review. The check is case-insensitive
// and purely path-based; file contents are never inspected.
//
// The verdict does not depend on how the path is spelled: `./.env`,
// `src/../.env`, `/repo/.env` and `.ssh\id_rsa` are all secret paths, because
// the path is normalized before matching. That matters wherever the caller is
// not the diff pipeline — the file_read tool passes a model-supplied path
// straight in, and a denylist that a different separator or a redundant "."
// segment could sidestep would not be a control at all.
//
// A path that is not a secret is not thereby reviewable: it still has to pass
// the extension allowlist and the default exclude patterns.
func IsSecretPath(path string) bool {
	secretOnce.Do(initSecret)
	normalized := normalizeSecretPath(path)
	for _, pattern := range secretPatterns {
		if matched, _ := doublestar.Match(pattern, normalized); matched {
			return true
		}
	}
	return false
}

// normalizeSecretPath rewrites a path into the shape the patterns are written
// in: lowercase (the patterns are lowercased by initSecret), forward slashes,
// and no redundant or "." / ".." segments.
//
// Backslashes are read as separators rather than kept verbatim, matching what
// file_find does with its query (internal/tool/file_find.go). doublestar
// treats a backslash as an escape character, so without this step `.ssh\id_rsa`
// — the native spelling of that path on Windows — would not match `**/.ssh/**`.
// The cost is that a file whose name genuinely contains a backslash, which only
// a non-Windows filesystem can hold, is judged by its slash reading; denying an
// oddly named file is the safe direction for a credential denylist.
func normalizeSecretPath(path string) string {
	slashed := strings.ReplaceAll(strings.ToLower(path), "\\", "/")
	return filepath.ToSlash(filepath.Clean(slashed))
}
