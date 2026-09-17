// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import DOMPurify from 'dompurify';
import { Marked, type Token, type Tokens } from 'marked';

const explicitHeadingIdPattern = /\s+\{#([a-zA-Z0-9][a-zA-Z0-9_.:-]*)\}\s*$/;

/**
 * Base ID for a heading whose text carries no letter, digit or mark at all -
 * for example one made only of emoji or punctuation. The per-document resolver
 * turns repeats into `section-2`, `section-3`, ... so such a heading stays
 * addressable instead of collapsing onto an empty `id=""`.
 */
const fallbackHeadingId = 'section';

/** Split an optional trailing `{#id}` marker from the visible heading text. */
export function parseExplicitHeadingId(text: string): { text: string; id?: string } {
  const match = text.match(explicitHeadingIdPattern);
  if (!match || match.index === undefined) {
    return { text };
  }

  return {
    text: text.slice(0, match.index).trimEnd(),
    id: match[1],
  };
}

/**
 * Reduce heading text to the characters a slug may be built from: strip HTML
 * tags via DOMPurify (a single-pass regex is unreliable and can be bypassed by
 * nested tags; it also decodes HTML entities so the TOC side (raw markdown) and
 * the renderer side (marked HTML output) agree), then drop the Markdown
 * delimiters that must never reach an anchor.
 */
function stripSlugDelimiters(text: string): string {
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
    .replace(/[`*_[\]()]/g, '')
    .trim();
}

/**
 * Shared utility to generate heading IDs from text.
 * Used by both extractHeadings (DocsPage TOC) and MarkdownRenderer (heading renderer)
 * to ensure consistent anchor IDs.
 *
 * Every Unicode letter, digit and combining mark survives, so a Cyrillic, kana
 * or Hangul heading slugs to its own text. Restricting the set to ASCII and CJK
 * ideographs used to collapse such headings to `""`, which left several of them
 * sharing `id=""` while the resolver below renumbered the rest into
 * position-dependent `-2`, `-3`, ... anchors that no deep link could rely on
 * and that `document.querySelector('#-15')` rejects as an invalid selector.
 */
export function generateHeadingId(text: string): string {
  const plain = stripSlugDelimiters(text);
  const slug = plain.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-|-$/g, '');
  return slug || fallbackHeadingId;
}

/**
 * The slug this module produced before Unicode letters were kept: ASCII
 * alphanumerics and CJK ideographs only, and empty when the text has neither.
 * Anchors already published against it (in-repository links and external deep
 * links) keep resolving because `extractHeadingAnchors` re-emits it as a hidden
 * alias whenever it still names something usable.
 */
export function legacyHeadingId(text: string): string {
  return stripSlugDelimiters(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Whether an ID is usable both as a URL fragment and as a bare `#id` CSS
 * selector. An empty ID addresses nothing, and one starting with a digit or `-`
 * (such as the old position-dependent `-15`) makes `querySelector('#-15')`
 * throw.
 *
 * This gates ALIAS emission only, and deliberately not primary IDs. A primary
 * ID is an anchor the documentation already publishes, and some of them do
 * start with a digit because the heading does (`1-disable-a-tool`) - the Korean
 * pages pin exactly those with explicit `{#id}` markers, so re-slugging them
 * would break every link written against them. Nothing resolves a heading
 * through a CSS selector either: the fragment scroll and the TOC scroll both go
 * through `document.getElementById`, which accepts any non-empty ID. An alias
 * is a new anchor with nothing published against it, so it is held to the
 * stricter bar instead of being emitted in a form a selector would reject.
 */
export function isFragmentSafeHeadingId(id: string): boolean {
  return /^[\p{L}_][^\s"#]*$/u.test(id);
}

/**
 * Creates a per-document heading ID resolver that keeps every rendered heading
 * addressable, even when a document repeats the same title (for example,
 * several "Schema" or "Output" sections).
 */
export function createHeadingIdResolver(): (baseId: string) => string {
  const usedIds = new Set<string>();

  return (baseId: string) => {
    if (!usedIds.has(baseId)) {
      usedIds.add(baseId);
      return baseId;
    }

    let suffix = 2;
    let candidate = `${baseId}-${suffix}`;
    while (usedIds.has(candidate)) {
      suffix += 1;
      candidate = `${baseId}-${suffix}`;
    }
    usedIds.add(candidate);
    return candidate;
  };
}

export interface HeadingInfo {
  id: string;
  text: string;
  level: number;
}

/**
 * A heading's primary anchor plus the IDs it also answers to. Aliases exist so
 * that changing how a slug is built does not silently break links that were
 * published against the previous ID, and so that a heading pinned with an
 * explicit `{#id}` marker is still reachable under its localized slug.
 */
export interface HeadingAnchors extends HeadingInfo {
  aliasIds: string[];
}

/**
 * The label a heading contributes to the TOC. Link syntax is unwrapped to its
 * text, then only the code and emphasis delimiters are dropped: `_` is kept so
 * a label reads `task_done` rather than advertising an identifier (`taskdone`)
 * that does not exist. Brackets and parentheses left over from prose rather
 * than link syntax are part of the title and stay (`Timeouts (global)`), which
 * is the one place a label differs from the slug - `generateHeadingId` drops
 * them so no anchor ever carries them.
 */
function normalizeHeadingText(text: string): string {
  return text
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/**
 * Walk the same Markdown token stream used by the renderer so all heading IDs
 * are resolved in exactly the same order, including setext headings and nested
 * tokens inside blockquotes/lists, and report the aliases each heading keeps.
 */
export function extractHeadingAnchors(markdown: string): HeadingAnchors[] {
  const parser = new Marked({ gfm: true, breaks: false });
  const headings: { text: string; level: number; explicitId?: string }[] = [];

  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'heading') {
        const heading = token as Tokens.Heading;
        const { text: headingText, id: explicitId } = parseExplicitHeadingId(heading.text);
        headings.push({ text: normalizeHeadingText(headingText), level: heading.depth, explicitId });
      }
      if ('tokens' in token && Array.isArray(token.tokens)) {
        visit(token.tokens);
      }
    }
  };

  visit(parser.lexer(markdown));

  // One resolver per sequence, so each numbers its own repeats the way it would
  // have numbered them alone: the primary IDs the document exposes, the
  // localized slugs (aliases wherever an explicit `{#id}` marker wins) and the
  // pre-Unicode slugs (aliases that keep already-published links resolving).
  const resolvePrimaryId = createHeadingIdResolver();
  const resolveLocaleId = createHeadingIdResolver();
  const resolveLegacyId = createHeadingIdResolver();
  const resolved = headings.map(({ text, level, explicitId }) => {
    // Slugged once and reused: generateHeadingId sanitizes through DOMPurify,
    // so asking it separately for the primary and the localized sequence would
    // pay for that twice to arrive at the same string.
    const localeSlug = generateHeadingId(text);
    return {
      text,
      level,
      id: resolvePrimaryId(explicitId ?? localeSlug),
      localeId: resolveLocaleId(localeSlug),
      legacyId: resolveLegacyId(explicitId ?? legacyHeadingId(text)),
    };
  });

  // An alias may never shadow a heading's own ID, another heading's ID, or an
  // alias already taken: duplicate IDs in one document make the earlier element
  // win every lookup, which would move a deep link to the wrong section. Walked
  // as a loop rather than mapped, because each heading's aliases depend on what
  // the headings before it claimed - the iteration order carries meaning.
  const primaryIds = new Set(resolved.map(({ id }) => id));
  const takenAliasIds = new Set<string>();
  const anchors: HeadingAnchors[] = [];
  for (const { id, text, level, localeId, legacyId } of resolved) {
    const aliasIds = [...new Set([localeId, legacyId])].filter(
      (alias) =>
        alias !== id &&
        isFragmentSafeHeadingId(alias) &&
        !primaryIds.has(alias) &&
        !takenAliasIds.has(alias),
    );
    for (const alias of aliasIds) {
      takenAliasIds.add(alias);
    }
    anchors.push({ id, text, level, aliasIds });
  }

  return anchors;
}

/**
 * Headings with their primary ID only — the shape the DocsPage TOC consumes.
 */
export function extractHeadingInfo(markdown: string): HeadingInfo[] {
  return extractHeadingAnchors(markdown).map(({ id, text, level }) => ({ id, text, level }));
}
