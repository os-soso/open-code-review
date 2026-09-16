// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package pathutil

import (
	"os"
	"path/filepath"
	"strings"
)

// CanonicalPath returns an absolute path with symlinks resolved.
func CanonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// WithinBase reports whether target is base itself or contained under base.
func WithinBase(base, target string) bool {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		rel = ".."
	}
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
		return true
	}

	return sameFileWithinBase(base, target)
}

// RelWithinBase reports whether target is base itself or contained under base
// and, when it is, also returns target's base-relative form (".", for base
// itself). It is the shape rooted file access needs: os.Root accepts only a
// name relative to the root handle, never an absolute path, and refuses any
// name whose components leave the root.
//
// Containment is decided lexically, on the assumption that both arguments are
// already absolute and cleaned (filepath.Join produces that), so — unlike
// WithinBase — the answer never depends on a filesystem lookup and cannot
// change between the moment it is computed and the moment the name is used.
// The returned name keeps the platform's separator, because its only consumer
// is the filesystem.
func RelWithinBase(base, target string) (string, bool) {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return "", false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	return rel, true
}

func sameFileWithinBase(base, target string) bool {
	if !filepath.IsAbs(base) || !filepath.IsAbs(target) {
		return false
	}
	baseInfo, err := os.Stat(base)
	if err != nil {
		return false
	}
	for cur := target; ; {
		info, err := os.Stat(cur)
		if err == nil && os.SameFile(baseInfo, info) {
			return true
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return false
		}
		cur = parent
	}
}
