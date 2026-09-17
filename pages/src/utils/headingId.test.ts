// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractHeadings } from './extractHeadings';
import {
  createHeadingIdResolver,
  extractHeadingAnchors,
  extractHeadingInfo,
  generateHeadingId,
  isFragmentSafeHeadingId,
  legacyHeadingId,
  parseExplicitHeadingId,
} from './headingId';

// Russian on purpose: explicit heading IDs exist for text that cannot produce a
// usable ASCII slug on its own.
const HEADING = 'Что делает навк'; // allow-non-english: fixture heading that cannot produce an ASCII slug

// Non-Latin fixtures, one script each, for the slug and alias rules below.
const KANA_HEADING = 'アンカーアルゴリズム'; // allow-non-english: katakana-only heading, the ja Tools page section that used to get id=""
const CYRILLIC_HEADING = 'Ограничения'; // allow-non-english: the ru "Limits" heading, repeated three times on the Tools page
const HANGUL_HEADING = '제한'; // allow-non-english: the ko "Limits" heading
const MIXED_JA_HEADING = 'タイムアウト（Timeouts）'; // allow-non-english: ja heading whose published anchor is the English term it contains
const MIXED_JA_SLUG = 'タイムアウト-timeouts'; // allow-non-english: the slug the heading above now produces
const NUMBERED_JA_HEADING = '1. ツールを無効化する'; // allow-non-english: the ja Tools page section a {#disable-a-tool} marker pins

describe('explicit heading IDs', () => {
  it('separates a trailing explicit ID from the visible heading text', () => {
    expect(parseExplicitHeadingId(`${HEADING} {#what-the-skill-does}`)).toEqual({
      text: HEADING,
      id: 'what-the-skill-does',
    });
  });

  it('leaves headings without an explicit ID unchanged', () => {
    expect(parseExplicitHeadingId('Configuration')).toEqual({ text: 'Configuration' });
  });

  it('uses the explicit ID in the table of contents without exposing its marker', () => {
    expect(extractHeadings(`## ${HEADING} {#what-the-skill-does}`)).toEqual([
      { id: 'what-the-skill-does', text: HEADING, level: 2 },
    ]);
  });

  it('assigns unique IDs to repeated headings', () => {
    expect(extractHeadings('## Schema\n\n## Schema\n\n### Output\n\n### Output')).toEqual([
      { id: 'schema', text: 'Schema', level: 2 },
      { id: 'schema-2', text: 'Schema', level: 2 },
      { id: 'output', text: 'Output', level: 3 },
      { id: 'output-2', text: 'Output', level: 3 },
    ]);
  });

  it('avoids collisions between generated suffixes and later headings', () => {
    const resolveHeadingId = createHeadingIdResolver();
    expect(resolveHeadingId('schema')).toBe('schema');
    expect(resolveHeadingId('schema-2')).toBe('schema-2');
    expect(resolveHeadingId('schema')).toBe('schema-3');
  });

  it('keeps TOC IDs aligned when hidden heading levels repeat a title', () => {
    expect(extractHeadings('#### Schema\n\n## Schema')).toEqual([
      { id: 'schema-2', text: 'Schema', level: 2 },
    ]);
  });

  it('parses setext headings and tilde-fenced code like the Markdown renderer', () => {
    expect(extractHeadingInfo('Title\n=====\n\n## Schema\n\n~~~\n## Fake\n~~~\n\n## Schema')).toEqual([
      { id: 'title', text: 'Title', level: 1 },
      { id: 'schema', text: 'Schema', level: 2 },
      { id: 'schema-2', text: 'Schema', level: 2 },
    ]);
  });
});

describe('heading IDs outside ASCII and CJK', () => {
  it('slugs a kana-only heading instead of collapsing it to an empty ID', () => {
    expect(generateHeadingId(KANA_HEADING)).toBe(KANA_HEADING);
  });

  it('slugs Cyrillic and Hangul headings from their own text', () => {
    expect(generateHeadingId(CYRILLIC_HEADING)).toBe(CYRILLIC_HEADING.toLowerCase());
    expect(generateHeadingId(HANGUL_HEADING)).toBe(HANGUL_HEADING);
  });

  it('keeps ASCII and CJK slugs exactly as they were', () => {
    expect(generateHeadingId('Customizing tools')).toBe('customizing-tools');
    expect(generateHeadingId('`code_search`')).toBe('codesearch');
    expect(generateHeadingId('1. Disable a tool')).toBe('1-disable-a-tool');
  });

  it('falls back to a resolvable base ID when the text carries no letter or digit', () => {
    expect(generateHeadingId('---')).toBe('section');
    expect(extractHeadings('## ---\n\n## +++')).toEqual([
      { id: 'section', text: '---', level: 2 },
      { id: 'section-2', text: '+++', level: 2 },
    ]);
  });

  it('gives each repeat of a Cyrillic heading its own addressable ID', () => {
    const slug = CYRILLIC_HEADING.toLowerCase();
    const content = `### ${CYRILLIC_HEADING}\n\n### ${CYRILLIC_HEADING}\n\n### ${CYRILLIC_HEADING}`;
    expect(extractHeadings(content).map(({ id }) => id)).toEqual([slug, `${slug}-2`, `${slug}-3`]);
  });

  it('reports which IDs are usable as a fragment and as a CSS selector', () => {
    expect(isFragmentSafeHeadingId('limits')).toBe(true);
    expect(isFragmentSafeHeadingId(CYRILLIC_HEADING.toLowerCase())).toBe(true);
    expect(isFragmentSafeHeadingId('')).toBe(false);
    expect(isFragmentSafeHeadingId('-15')).toBe(false);
    expect(isFragmentSafeHeadingId('1-disable-a-tool')).toBe(false);
  });
});

describe('TOC labels', () => {
  it('keeps underscores so a label names the identifier it targets', () => {
    expect(extractHeadings('## `task_done`\n\n## `file_read_diff`')).toEqual([
      { id: 'taskdone', text: 'task_done', level: 2 },
      { id: 'filereaddiff', text: 'file_read_diff', level: 2 },
    ]);
  });

  it('still unwraps links and drops emphasis delimiters', () => {
    expect(extractHeadings('## See [the rules](../review-rules/) *now*')).toEqual([
      { id: 'see-the-rules-now', text: 'See the rules now', level: 2 },
    ]);
  });

  it('keeps brackets and parentheses that are prose rather than link syntax', () => {
    expect(extractHeadings('## Timeouts (global)\n\n### [WIP] Draft {#draft}')).toEqual([
      { id: 'timeouts-global', text: 'Timeouts (global)', level: 2 },
      { id: 'draft', text: '[WIP] Draft', level: 3 },
    ]);
  });
});

describe('heading alias IDs', () => {
  it('keeps the pre-Unicode slug as an alias so published anchors still resolve', () => {
    expect(legacyHeadingId(MIXED_JA_HEADING)).toBe('timeouts');
    expect(legacyHeadingId(CYRILLIC_HEADING)).toBe('');
    expect(extractHeadingAnchors(`### ${MIXED_JA_HEADING}`)).toEqual([
      { id: MIXED_JA_SLUG, text: MIXED_JA_HEADING, level: 3, aliasIds: ['timeouts'] },
    ]);
  });

  it('keeps the localized slug as an alias when an explicit marker owns the ID', () => {
    expect(extractHeadingAnchors(`### ${CYRILLIC_HEADING} {#limits}`)).toEqual([
      {
        id: 'limits',
        text: CYRILLIC_HEADING,
        level: 3,
        aliasIds: [CYRILLIC_HEADING.toLowerCase()],
      },
    ]);
  });

  it('numbers repeated aliases independently of the primary IDs', () => {
    const slug = CYRILLIC_HEADING.toLowerCase();
    const content = `### ${CYRILLIC_HEADING} {#limits}\n\n### ${CYRILLIC_HEADING} {#limits}`;
    expect(extractHeadingAnchors(content).map(({ id, aliasIds }) => [id, aliasIds])).toEqual([
      ['limits', [slug]],
      ['limits-2', [`${slug}-2`]],
    ]);
  });

  it('emits no alias when the slug is unchanged', () => {
    expect(extractHeadingAnchors('## Limits\n\n## Schema')).toEqual([
      { id: 'limits', text: 'Limits', level: 2, aliasIds: [] },
      { id: 'schema', text: 'Schema', level: 2, aliasIds: [] },
    ]);
  });

  it('publishes no alias for a numbered heading whose own slug starts with a digit', () => {
    // A heading numbered in its title slugs to `1-disable-a-tool`, which
    // `document.querySelector` rejects as a selector, so the marker owns the ID
    // and that slug is not re-published as an alias in any locale - emitting it
    // would put the invalid ID back on the page as a span.
    expect(extractHeadingAnchors('### 1. Disable a tool {#disable-a-tool}')).toEqual([
      { id: 'disable-a-tool', text: '1. Disable a tool', level: 3, aliasIds: [] },
    ]);
    expect(extractHeadingAnchors(`### ${NUMBERED_JA_HEADING} {#disable-a-tool}`)).toEqual([
      { id: 'disable-a-tool', text: NUMBERED_JA_HEADING, level: 3, aliasIds: [] },
    ]);
  });

  it('never lets an alias shadow a heading that owns that ID', () => {
    const slug = CYRILLIC_HEADING.toLowerCase();
    const content = `## ${CYRILLIC_HEADING} {#limits}\n\n## ${CYRILLIC_HEADING}`;
    expect(extractHeadingAnchors(content).map(({ id, aliasIds }) => [id, aliasIds])).toEqual([
      ['limits', []],
      [slug, [`${slug}-2`]],
    ]);
  });
});

// The Tools page is the only documentation page whose headings are pinned with
// `{#id}` markers in every locale, so it is where an ID that no CSS selector
// accepts reaches a reader first: `{#1-disable-a-tool}` and
// `{#2-re-describe-a-tool}` shipped once, and `document.querySelector` rejected
// both. The two cases below therefore run the production extractor over the
// shipped Markdown rather than over a fixture, which is what lets them catch a
// marker typed straight into the content files.
const TOOLS_PAGE_LOCALES = ['en', 'zh', 'ja', 'ko', 'ru'] as const;

// Resolved from this file rather than from process.cwd(), so the suite does not
// depend on where vitest was invoked from (as in index.html.test.ts).
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Drop the YAML front matter DocsPage strips before rendering (`stripFrontmatter`
 * in content/docs/index.ts). Left in place, its closing `---` turns the block
 * above into a setext heading, which would contribute an ID no reader can see.
 */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('---', 3);
  return end === -1 ? markdown : markdown.slice(end + 3).trim();
}

/** Every ID a locale's Tools page puts in the document: headings and aliases. */
function toolsPageHeadingIds(locale: string): string[] {
  const file = join(here, '..', 'content', 'docs', locale, 'tools.md');
  return extractHeadingAnchors(stripFrontmatter(readFileSync(file, 'utf8'))).flatMap(
    ({ id, aliasIds }) => [id, ...aliasIds],
  );
}

describe('shipped Tools page heading IDs', () => {
  it('leaves no heading or alias ID that a bare `#id` CSS selector would reject', () => {
    const rejected = TOOLS_PAGE_LOCALES.flatMap((locale) =>
      toolsPageHeadingIds(locale)
        .filter((id) => !isFragmentSafeHeadingId(id))
        .map((id) => `${locale}/tools.md: ${id}`),
    );
    expect(rejected).toEqual([]);
  });

  it('gives the two numbered "Customizing tools" sections one ID across all five locales', () => {
    const customizingSectionIds = Object.fromEntries(
      TOOLS_PAGE_LOCALES.map((locale) => [
        locale,
        toolsPageHeadingIds(locale).filter((id) => /disable-a-tool|re-describe-a-tool/.test(id)),
      ]),
    );
    const pinned = ['disable-a-tool', 're-describe-a-tool'];
    expect(customizingSectionIds).toEqual({ en: pinned, zh: pinned, ja: pinned, ko: pinned, ru: pinned });
  });
});
