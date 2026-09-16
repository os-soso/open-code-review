// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package tool

import (
	"context"
	"errors"
	"fmt"
	"strings"

	allowedext "github.com/alibaba/open-code-review/internal/config/allowlist"
)

const fileReadMaxLines = 500

// FileReadProvider reads file content at a given path and optional line range.
type FileReadProvider struct {
	FileReader *FileReader
}

func NewFileRead(fr *FileReader) *FileReadProvider { return &FileReadProvider{FileReader: fr} }

func (p *FileReadProvider) Tool() Tool { return FileRead }

// secretPathRefusal is the answer the model gets for a credential path. It
// names the policy instead of the file so that the model stops asking, and it
// carries no line of the file: the whole point of the refusal is that nothing
// from a credential file reaches the conversation or the recorded session.
// The path is quoted with %q, which escapes anything unprintable the model
// may have put in it.
func secretPathRefusal(filePath string) string {
	return fmt.Sprintf("Error: file_path %q is blocked by the built-in secret-path policy. "+
		"Credential files (.env, .netrc, .npmrc, .pypirc, .dockercfg, .ssh material and private keys) "+
		"are never readable through this tool. Review the code that consumes the credential instead.", filePath)
}

// ignoredPathRefusal is the answer the model gets for a path the repository
// ignores and does not track. Like the credential refusal it carries no line
// of the file, and it says why the path is out of bounds so that the model
// looks for the tracked code instead of retrying the same name.
func ignoredPathRefusal(filePath string) string {
	return fmt.Sprintf("Error: file_path %q is ignored by this repository and is not tracked, "+
		"so it is outside the content under review and cannot be read. Ignored paths are where a "+
		"project keeps its own credentials and local state. Read the tracked code instead.", filePath)
}

func (p *FileReadProvider) Execute(ctx context.Context, args map[string]any) (string, error) {
	filePath, _ := args["file_path"].(string)
	if filePath == "" {
		return "Error: file_path is required", nil
	}
	// The path is model-controlled, so the credential denylist is applied to
	// it here, at the tool boundary, before any line range is even parsed.
	// FileReader enforces the same policy on every read it performs; this
	// check is what turns the refusal into an answer the model can act on
	// rather than a tool failure.
	if allowedext.IsSecretPath(filePath) {
		return secretPathRefusal(filePath), nil
	}

	startLine, hasStart := args["start_line"].(float64)
	endLine, hasEnd := args["end_line"].(float64)
	if !hasStart || startLine <= 0 {
		startLine = 1
	}
	if !hasEnd || endLine <= 0 {
		endLine = 0
	}

	maxLines := fileReadMaxLines
	if endLine > 0 {
		requested := int(endLine) - int(startLine) + 1
		if requested <= 0 {
			return "", fmt.Errorf("invalid line range: start_line %d is greater than end_line %d", int(startLine), int(endLine))
		}
		if requested < maxLines {
			maxLines = requested
		}
	}

	lines, totalLines, err := p.FileReader.ReadLines(ctx, filePath, int(startLine), maxLines)
	// The reader refuses a path on policy grounds — a name that resolved onto
	// a credential file, which the check above cannot see, or one the
	// repository ignores. Neither is a missing file, so neither may be
	// reported as one.
	if errors.Is(err, ErrSecretPath) {
		return secretPathRefusal(filePath), nil
	}
	if errors.Is(err, ErrIgnoredPath) {
		return ignoredPathRefusal(filePath), nil
	}
	if err != nil {
		return "", fmt.Errorf("file %q not found: %w", filePath, err)
	}

	if totalLines > 0 && int(startLine)-1 >= totalLines {
		return "", fmt.Errorf("file %q has only %d lines, requested range %d-%d", filePath, totalLines, int(startLine), int(endLine))
	}

	effectiveEnd := totalLines
	if endLine > 0 && int(endLine) < effectiveEnd {
		effectiveEnd = int(endLine)
	}
	fullRange := effectiveEnd - (int(startLine) - 1)
	truncated := fullRange > fileReadMaxLines

	displayEnd := int(startLine) - 1 + len(lines)

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("File: %s (Total lines: %d)\n", filePath, totalLines))
	sb.WriteString(fmt.Sprintf("IS_TRUNCATED: %t\n", truncated))
	sb.WriteString(fmt.Sprintf("LINE_RANGE: %d-%d\n", int(startLine), displayEnd))
	for i, line := range lines {
		sb.WriteString(fmt.Sprintf("%d|%s\n", int(startLine)+i, line))
	}
	if truncated {
		sb.WriteString(fmt.Sprintf("\nNote: Results truncated to %d lines. Please narrow your line range.\n", fileReadMaxLines))
	}
	return sb.String(), nil
}
