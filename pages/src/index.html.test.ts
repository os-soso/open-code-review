// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// The critical-CSS block in index.html is the whole fix for the initial white
// flash: every rule in src/styles/index.css ships inside the deferred JS chunks,
// so anything not inlined here has no effect until the last chunk executes.
// Nothing else in the build depends on the block, which makes it easy to delete
// by accident during an unrelated <head> edit — hence these assertions.
// The other half of the suite is the head's freedom from third-party hosts: two
// CDN stylesheets were once linked here and rendered nothing, so the page failed
// and logged console errors wherever egress to them was unavailable. Nothing in
// the build fails when a <link> to a CDN is added, so these cases do.
// Resolved from this file rather than process.cwd() so the test does not depend
// on where vitest was invoked from. Deliberately not `new URL('../index.html',
// import.meta.url)`: Vite rewrites that exact pattern into an asset URL, which
// is no longer a file:// path by the time it reaches fileURLToPath.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const indexCss = readFileSync(join(here, 'styles', 'index.css'), 'utf8');

// Comments explain this block and name the tags they discuss, so structural
// assertions must not see them — otherwise a tag mentioned in prose reads as a
// tag in the document. Split on comment boundaries and keep only non-comment
// segments (avoids CodeQL's incomplete-multi-character-sanitization rule).
const markup = html.split(/<!--[\s\S]*?-->/).join('');

const inlineStyle = markup.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

// Every <link> the document declares, comments excluded. The head deliberately
// carries no third-party sheet any more, so the cases below assert over this
// list rather than over a prose mention of a tag.
const links = markup.match(/<link\b[^>]*>/g) ?? [];

/** background-color / color out of a `body { ... }` block. */
function bodyColors(css: string): { bg?: string; fg?: string } {
  const block = css.match(/(^|\s)body\s*{([^}]*)}/)?.[2] ?? '';
  return {
    bg: block.match(/background-color:\s*(#[0-9a-fA-F]{3,8})/)?.[1]?.toLowerCase(),
    // (?<!-) so `background-color` does not match as `color`.
    fg: block.match(/(?<!-)\bcolor:\s*(#[0-9a-fA-F]{3,8})/)?.[1]?.toLowerCase(),
  };
}

describe('index.html critical CSS and external dependencies', () => {
  const cases: { name: string; assert: () => void }[] = [
    {
      name: 'inlines a <style> block',
      assert: () => expect(inlineStyle.trim()).not.toBe(''),
    },
    {
      name: 'paints the dark background on html and body',
      // html too, not just body: it is the element the browser has already
      // resolved when the first paint happens.
      assert: () => expect(inlineStyle).toMatch(/html,\s*body\s*{[^}]*background-color:\s*#000000/),
    },
    {
      // The colours are duplicated from index.css by necessity — index.css is not
      // available at first paint. Asserting they still match is the only thing
      // stopping a later edit to index.css from reintroducing a visible shift.
      name: 'keeps the inline colours in sync with index.css',
      assert: () => {
        const css = bodyColors(indexCss);
        expect(css.bg).toBeDefined();
        expect(css.fg).toBeDefined();
        expect(bodyColors(inlineStyle)).toEqual(css);
      },
    },
    {
      // This head used to link a Google Fonts sheet (Inter + JetBrains Mono)
      // and cdnjs Font Awesome. No element on any route resolved to either
      // family and none carried a Font Awesome class, so all they produced was
      // two cross-origin round-trips per route — and, wherever those hosts are
      // unreachable, two failed requests and two console errors on a page that
      // is otherwise completely silent. Anything the site really needs belongs
      // in the bundle, so no <link> may point off-origin.
      name: 'links no stylesheet or asset from a third-party host',
      assert: () => expect(links.filter((link) => /href="(?:https?:)?\/\//.test(link))).toEqual([]),
    },
    {
      // Belt to the braces above: catches the retired hosts wherever they might
      // reappear, including inside a <noscript> copy or an @import.
      name: 'names none of the retired font and icon CDNs',
      assert: () => {
        for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']) {
          expect(markup).not.toContain(host);
        }
      },
    },
    {
      // A connection hint only repays its DNS and TLS cost for a host the page
      // goes on to use; with no third-party host left, one would warm a
      // connection nothing ever opens.
      name: 'carries no connection hint to a host it does not use',
      assert: () =>
        expect(links.filter((link) => /rel="(?:preconnect|dns-prefetch)"/.test(link))).toEqual([]),
    },
    {
      name: 'shows the boot indicator only while #root is empty',
      // :empty is what makes React's first render remove it, with no JS cleanup.
      assert: () => expect(inlineStyle).toMatch(/#root:empty::(after|before)/),
    },
    {
      name: 'stops the indicator animating under prefers-reduced-motion',
      assert: () => {
        expect(inlineStyle).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        const reduced = inlineStyle.slice(
          inlineStyle.indexOf('prefers-reduced-motion')
        );
        expect(reduced).toMatch(/animation:\s*none/);
      },
    },
    {
      // Critical CSS that loses the race to an external sheet is not critical
      // CSS. It cannot lose a race that does not exist: this block is the only
      // stylesheet the document declares, and the <noscript> copies that used
      // to be render-blocking by design are gone with the sheets they mirrored.
      name: 'is the only stylesheet the document declares',
      assert: () => {
        expect(markup).toMatch(/<style>/);
        expect(markup).not.toMatch(/rel="stylesheet"/);
        expect(markup).not.toContain('<noscript>');
      },
    },
  ];

  for (const c of cases) {
    it(c.name, c.assert);
  }
});
