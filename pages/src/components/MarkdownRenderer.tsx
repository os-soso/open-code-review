// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Marked, Renderer, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { useTranslation } from '../i18n';
import { useCopyToast } from '../hooks/useCopyToast';
import copyIcon from '../assets/icons/icon-copy.svg';
import { extractHeadingAnchors, generateHeadingId, parseExplicitHeadingId } from '../utils/headingId';
import type { DocSlug } from '../content/docs';

type Mermaid = typeof import('mermaid')['default'];

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          // 'strict' makes mermaid sanitize its own SVG output (DOMPurify internally):
          // safe label HTML like <b>/<span> is kept, scripts/handlers are stripped.
          // This is why we can inject the returned SVG directly below without re-sanitizing.
          securityLevel: 'strict',
          theme: 'dark',
          themeVariables: {
            primaryColor: '#1a1a2e',
            primaryTextColor: 'rgba(255,255,255,0.85)',
            primaryBorderColor: 'rgba(255,255,255,0.2)',
            lineColor: 'rgba(255,255,255,0.4)',
            secondaryColor: '#16213e',
            tertiaryColor: '#0f3460',
            background: '#000000',
            mainBkg: 'rgba(255,255,255,0.04)',
            nodeBorder: 'rgba(255,255,255,0.16)',
            clusterBkg: 'rgba(255,255,255,0.02)',
            titleColor: '#FFFFFF',
            edgeLabelBackground: '#000000',
          },
          flowchart: {
            htmlLabels: true,
            curve: 'basis',
          },
        });
        return mermaid;
      })
      .catch((error) => {
        // Allow a later navigation to retry after a transient chunk-load failure.
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

/** Escape a value that is about to be interpolated into an HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Every documentation slug the SPA serves, as a record so that adding a member
 * to `DocSlug` fails to compile until it is listed here. Markdown links are
 * authored the way a static site nests its pages (`../viewer/`), which the
 * browser resolves against the *current* URL — from `/docs/tools` that yields
 * `/viewer/`, a route the SPA does not have. Rewriting those hrefs to
 * `/docs/<slug>` at render time makes them correct for every activation that
 * does not go through the click handler: cold load, middle-click, "open in new
 * tab", "copy link address", and a crawler reading the markup.
 */
const docSlugs: Record<DocSlug, true> = {
  quickstart: true,
  installation: true,
  configuration: true,
  'cli-reference': true,
  'review-rules': true,
  architecture: true,
  tools: true,
  mcp: true,
  viewer: true,
  telemetry: true,
  'agent-skill': true,
  'claude-code': true,
  cicd: true,
  delegate: true,
  contributing: true,
  faq: true,
};

/** Path segments that name a doc under a different slug (mirrors DocsPage). */
const docSlugAliases: Record<string, DocSlug> = { ci: 'cicd' };

/**
 * Rewrite a relative link to a documentation page into the route that serves
 * it, preserving any fragment. Anything that is not such a link — an absolute
 * URL, a `mailto:`, an app-absolute path, a same-page fragment, or a path whose
 * last segment is not a doc slug (`../#tips-…`, `/images/blog/x.png`) — is
 * returned unchanged so the default renderer handles it exactly as before.
 */
function rewriteDocHref(href: string): string {
  if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href;
  }

  const hashIndex = href.indexOf('#');
  const pathPart = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : href.slice(hashIndex);
  const segments = pathPart.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return href;

  // Lower-cased before the lookup: every slug and route is lower-case, so
  // `../CI.md` or `../Tools/` would otherwise miss the table and be left as a
  // relative href that resolves to a route the SPA does not serve.
  const candidate = lastSegment.replace(/\.md$/i, '').toLowerCase();
  const slug = docSlugAliases[candidate] ?? candidate;
  if (!Object.prototype.hasOwnProperty.call(docSlugs, slug)) return href;

  return `/docs/${slug}${fragment}`;
}

/**
 * How long the copied message stays in the DOM after the toast starts hiding.
 * It outlasts the pill's 0.15s opacity transition so the toast never fades out
 * with an empty body, and still clears the live region afterwards so the next
 * copy is a real content change — which is the only thing a live region speaks.
 */
const TOAST_MESSAGE_LINGER_MS = 250;

/**
 * Widest inline code, in monospace columns, that is kept on a single line.
 *
 * `.docs-markdown code` paints a bordered chip, and the default
 * `box-decoration-break: slice` repaints that border and padding on every line
 * box a wrapped span produces — so a short reference such as
 * `git grep --max-count` reads as two separate chips once the line breaks
 * inside it (it breaks at the hyphen, not only at the spaces, because the rule
 * carries `overflow-wrap: break-word`). Suppressing the wrap is only safe while
 * the chip is narrower than the prose column, otherwise an unbreakable span
 * would push the article sideways, which is why this is a threshold and not a
 * blanket `white-space: nowrap`.
 *
 * 24 is derived from the site's own metrics, measured in the built page: the
 * chip is 13px Menlo at 7.83px per ASCII column plus 6px padding each side and
 * a 1px border, so 24 columns occupy ~202px, and the narrowest prose column the
 * site lays out — a list item at a 375px viewport — is 311px wide. Anything
 * longer keeps wrapping, which is what the 70-character truncation note in the
 * same bullet must continue to do.
 *
 * That arithmetic is tied to the 13px body size, which is why the gate excludes
 * heading code: `docs-heading-code` carries `font-size: inherit`, so the same
 * span renders at 28px in an h1 and 20px in an h2, where 24 columns would be
 * ~430px and ~300px and an unbreakable chip could reach past the column instead
 * of wrapping inside it. Heading code needs no gate of its own — the longest in
 * the documentation today is 14 columns in an h1 and 15 in an h2 (~249px and
 * ~192px as rendered), so heading chips fit the narrow column and do not split.
 */
const INLINE_CODE_NOWRAP_MAX_COLUMNS = 24;

/**
 * Code points that occupy two monospace columns instead of one: an
 * approximation of the East Asian Wide and Fullwidth classes of UAX #11,
 * covering Hangul, the Kana, the CJK ideograph and radical blocks, CJK
 * punctuation and the fullwidth ASCII forms.
 *
 * The documentation is published in five locales, and a localized page can put
 * CJK text inside inline code (a placeholder such as a session id or a task
 * type is written in the page's own language). Those glyphs measure 13.0px
 * against an ASCII column's 7.83px, so counting characters alone would let a
 * span nearly twice as wide as the budget through and reintroduce the
 * horizontal overflow this threshold exists to avoid.
 */
const WIDE_CODE_POINT_PATTERN =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]/u;

/**
 * Width of an inline code span in monospace columns.
 *
 * Iterated with `for…of` so a surrogate pair counts as the one glyph it
 * renders as, and measured on the codespan token's `text`, which marked hands
 * over decoded — the HTML escaping to `&amp;`/`&lt;` happens in the renderer
 * afterwards, so no entity can inflate the count.
 */
function measureCodeColumns(text: string): number {
  let columns = 0;
  for (const character of text) {
    columns += WIDE_CODE_POINT_PATTERN.test(character) ? 2 : 1;
  }
  return columns;
}

/**
 * The attributes the overflow measurement owns on a `.table-scroll` wrapper.
 * They are cleared together, so a wrapper that has stopped scrolling cannot
 * keep a focus stop, a role, or a label pointing at a heading — a stale name on
 * an inert element is what the keyboard reader trips over.
 */
const SCROLL_REGION_ATTRIBUTES = ['tabindex', 'role', 'aria-labelledby', 'aria-label'] as const;

/**
 * Slack allowed between `scrollWidth` and `clientWidth` before a container
 * counts as scrollable. Both are integers rounded from a fractional layout, so
 * a table that exactly fills its column can report a 1px difference; taking
 * that for overflow would reinstate the inert focus stop.
 */
const SCROLL_OVERFLOW_TOLERANCE_PX = 1;

/** Set an attribute to `value`, or remove it entirely when `value` is null. */
function setAttributeOrRemove(element: Element, name: string, value: string | null): void {
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}

/**
 * How many headings an `aria-labelledby` may chain. Two: the subsection the
 * table sits in, and the section that subsection belongs to.
 *
 * One alone is not enough on these pages. A tool reference repeats the same
 * `### Schema` under every `## <tool name>`, so naming a table after its
 * nearest heading produces three regions all called "Schema" on /docs/tools —
 * named, but indistinguishable to someone tabbing through them. A third level
 * would only add the page title every name already implies.
 */
const SECTION_LABEL_HEADING_LIMIT = 2;

/**
 * IDs of the headings that title the section a table sits in, outermost first,
 * or an empty list when the table precedes every heading on the page.
 *
 * A scroll container that is a Tab stop needs an accessible name, and the
 * headings above the table are the names the reader just passed — they need no
 * new translation key, and every heading this renderer emits carries an ID.
 * `aria-labelledby` takes a list of IDs and concatenates their text, so
 * "code_search Schema" is assembled by reference rather than by building a
 * string this component would have to punctuate for five languages.
 *
 * The walk goes backwards through previous siblings and then climbs to the
 * parent to continue there, because marked's output is flat only in the common
 * case: the table's immediate predecessor is usually a `<p>` or a `<pre>`, and
 * the heading is several siblings back. A heading only counts when it is
 * shallower than the last one taken — a flat document has no ancestors to
 * climb, so heading depth is what identifies the enclosing section, and the
 * same depth test keeps an earlier sibling subsection out of the name. `root`
 * bounds the climb so the search can never name a docs table after a heading
 * belonging to the page chrome.
 */
function findSectionHeadingIds(wrapper: Element, root: Element): string[] {
  const headingIds: string[] = [];
  let takenDepth = Number.POSITIVE_INFINITY;
  for (let node: Element | null = wrapper; node !== null && node !== root; node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
      if (!/^H[1-6]$/.test(sibling.tagName) || sibling.id === '') continue;
      const depth = Number(sibling.tagName.slice(1));
      if (depth >= takenDepth) continue;
      headingIds.unshift(sibling.id);
      takenDepth = depth;
      if (headingIds.length === SECTION_LABEL_HEADING_LIMIT) return headingIds;
    }
  }
  return headingIds;
}

/**
 * Text of the wrapped table's caption, or null when it has none. The fallback
 * name for a table that no heading precedes: a caption is authored copy in the
 * page's own language, so it reads as well as a heading would.
 */
function findTableCaptionText(wrapper: Element): string | null {
  const caption = wrapper.querySelector('caption')?.textContent?.trim() ?? '';
  return caption === '' ? null : caption;
}

interface MarkdownRendererProps {
  content: string;
}

/**
 * Renders markdown content with dark theme styling matching the existing DocsPage design.
 * Uses `marked` to parse markdown into HTML, then renders with styled container.
 * Mermaid diagrams are rendered client-side after mount.
 */
const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { t, language } = useTranslation();
  const { toastVisible, handleCopy } = useCopyToast();
  // Resolved in render rather than inside the effect below so that a locale
  // switch changes an effect dependency and re-labels the mounted copy buttons.
  const copyLabel = t('docs.copyCode');
  const copiedMessage = t('quickstart.copied');
  // The toast pill doubles as the polite live region for the copy result, so its
  // text is mounted only around an actual copy: a permanently present message
  // would never be announced, because assistive technology reads live regions
  // on content change only.
  const [toastMessage, setToastMessage] = useState('');

  const html = useMemo(() => {
    // Custom renderer to generate heading IDs matching the TOC extraction logic
    const renderer = new Renderer();
    const headingAnchors = extractHeadingAnchors(content);
    let headingIndex = 0;
    let renderingHeading = false;
    renderer.image = function ({ href, title, text }: { href: string; title?: string | null; text: string }) {
      const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
      return `<img src="${escapeHtmlAttribute(href)}" alt="${escapeHtmlAttribute(text)}"${titleAttr} />`;
    };
    renderer.heading = function ({ tokens, text, depth }: Tokens.Heading) {
      const { text: headingText, id: explicitId } = parseExplicitHeadingId(text);
      const anchors = headingAnchors[headingIndex++];
      const id = anchors?.id ?? explicitId ?? generateHeadingId(headingText);
      // Parse the inline Markdown so a backticked identifier becomes a <code>
      // child instead of reaching the reader as literal backtick characters.
      // The flag lets the codespan renderer below tell heading code from body
      // code. A single boolean is enough because parseInline is synchronous and
      // a heading cannot nest another heading, so this call can never re-enter
      // itself; the finally clears it even if inline parsing throws.
      renderingHeading = true;
      let inlineHtml: string;
      try {
        inlineHtml = this.parser.parseInline(tokens);
      } finally {
        renderingHeading = false;
      }
      // The trailing `{#id}` marker is metadata, not prose: it survives inline
      // parsing verbatim (marked escapes none of `{`, `#`, `}`), so strip it
      // from the rendered HTML the same way it is stripped from the TOC label.
      const bodyHtml = parseExplicitHeadingId(inlineHtml).text;
      // Empty, non-focusable alias targets keep anchors that were published
      // against a previous ID — or against this heading's localized slug when
      // an explicit `{#id}` marker owns the ID — resolving to this heading.
      const aliasAnchors = (anchors?.aliasIds ?? [])
        .map((alias) => `<span class="docs-heading-alias" id="${escapeHtmlAttribute(alias)}"></span>`)
        .join('');
      return `<h${depth} id="${escapeHtmlAttribute(id)}">${aliasAnchors}${bodyHtml}</h${depth}>\n`;
    };
    // Relative documentation links must address the SPA route that serves the
    // page, not a path resolved against the URL the reader happens to be on.
    // Delegating to the default keeps marked's URL cleaning, title handling and
    // escaping identical for both the rewritten and the untouched cases.
    renderer.link = function (token: Tokens.Link) {
      const href = rewriteDocHref(token.href);
      return Renderer.prototype.link.call(this, href === token.href ? token : { ...token, href });
    };
    // Three attributes are added here, all absent from the default output:
    // - lang="en": inline code in a localized page is English (identifiers,
    //   CLI flags, log lines), so it is marked up per WCAG 2.1 SC 3.1.2
    //   (Language of Parts) — without it a screen reader voices English with
    //   the page language's pronunciation rules.
    // - font-size: inherit inside a heading: the stylesheet sizes inline code
    //   for body text, which would render a section title (a tool name is a
    //   whole heading) smaller than its own subsections.
    // - class="code-nowrap" on a body chip that fits the prose column: the
    //   paired stylesheet rule holds it on one line, so the bordered chip is
    //   painted once instead of once per line box (see
    //   INLINE_CODE_NOWRAP_MAX_COLUMNS for the budget, why a longer span must
    //   keep wrapping, and why heading code is outside the gate).
    renderer.codespan = function (token: Tokens.Codespan) {
      const codeHtml = Renderer.prototype.codespan.call(this, token);
      // Built as one merged class attribute rather than two: two `class=`
      // attributes on one tag would leave the second silently ignored by the
      // HTML parser. The two names are mutually exclusive today, since the
      // nowrap budget is a body-text measurement, but the composition keeps a
      // future third class from reintroducing that bug.
      const classNames = [
        renderingHeading ? 'docs-heading-code' : '',
        !renderingHeading && measureCodeColumns(token.text) <= INLINE_CODE_NOWRAP_MAX_COLUMNS ? 'code-nowrap' : '',
      ].filter((className) => className !== '');
      const attributes = [
        language === 'en' ? '' : ' lang="en"',
        classNames.length === 0 ? '' : ` class="${classNames.join(' ')}"`,
        renderingHeading ? ' style="font-size:inherit"' : '',
      ].join('');
      // Anchored, so the rewrite can only ever touch the opening tag the
      // default renderer just produced and never a `<code>` sequence that came
      // out of the escaped content itself.
      return attributes === '' ? codeHtml : codeHtml.replace(/^<code>/, `<code${attributes}>`);
    };
    // Strip trailing newlines from code blocks to avoid empty line at bottom
    renderer.code = function ({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }) {
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      const content = escaped ? trimmed : trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const langClass = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langClass}>${content}</code></pre>\n`;
    };
    // A table cannot be laid out narrower than its own min-content width, so a
    // wide one overflows the article column and, with nothing to contain it,
    // widens the whole document. Wrap each table in a scroll container — the
    // treatment fenced code blocks already get — rather than making the table
    // itself a scroll container, which would cost its native table semantics.
    // The visual styles live in docs-markdown.css.
    //
    // The wrapper is emitted inert: no tabindex, no role and no aria-*.
    // Whether it scrolls is a measured property of the laid-out page — the same
    // table fits the column at 1280px and overflows at 375px — so a tabindex
    // baked into the markup would plant an unnamed, role-less focus stop
    // mid-article on every width where there is nothing to scroll. The effect
    // below measures each wrapper and adds the keyboard affordance only where
    // it does something.
    //
    // Call the default renderer through the call-time `this`: marked copies
    // these overrides onto a renderer of its own and assigns `parser` only to
    // that one, so a pre-bound copy of the default would run without a parser.
    const renderDefaultTable = renderer.table;
    renderer.table = function (token) {
      return `<div class="table-scroll">${renderDefaultTable.call(this, token)}</div>\n`;
    };
    const instance = new Marked({ gfm: true, breaks: false, renderer });
    return DOMPurify.sanitize(instance.parse(content) as string);
  }, [content, language]);

  // Render mermaid diagrams and add copy buttons to code blocks after DOM update
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    // Add copy buttons to all pre > code blocks (except mermaid)
    const preBlocks = containerRef.current.querySelectorAll('pre');
    preBlocks.forEach((pre) => {
      const codeEl = pre.querySelector('code');
      if (!codeEl || codeEl.classList.contains('language-mermaid')) return;

      const existingBtn = pre.querySelector('.code-copy-btn');
      if (existingBtn) {
        // Already added: only re-label it, so a locale switch re-translates the
        // accessible name without discarding the control or its click listener.
        existingBtn.setAttribute('aria-label', copyLabel);
        return;
      }

      // Create copy button; visual styles live in docs-markdown.css.
      // A real <button> is used so the control joins the tab order and activates
      // on Enter/Space natively (no keydown handler needed), and the icon is
      // marked decorative (alt="") so the accessible name is the localized
      // aria-label rather than the untranslated image alt text.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy-btn';
      btn.setAttribute('aria-label', copyLabel);
      btn.innerHTML = `<img src="${copyIcon}" alt="" style="width:16px;height:16px;" />`;
      btn.addEventListener('click', () => {
        const text = codeEl.textContent || '';
        handleCopy(text);
      });
      pre.appendChild(btn);
    });

    // Render mermaid diagrams
    const mermaidBlocks = containerRef.current.querySelectorAll('code.language-mermaid');
    if (mermaidBlocks.length === 0) return;

    const renderMermaidBlocks = async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;

        for (const block of Array.from(mermaidBlocks)) {
          const pre = block.parentElement;
          if (!pre) continue;
          const code = block.textContent || '';
          try {
            const id = `mermaid-diagram-${crypto.randomUUID()}`;
            const { svg } = await mermaid.render(id, code);
            if (cancelled) return;
            // Replace the <pre> with rendered SVG. The SVG is produced by mermaid with
            // securityLevel:'strict' (configured in loadMermaid), which already sanitizes
            // its output. Re-running DOMPurify over the whole SVG breaks it (namespaces,
            // inline <style>, foreignObject labels), so we inject mermaid's trusted output.
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid-rendered';
            // codeql[js/xss-through-dom] -- svg is derived from user-controlled mermaid code, but mermaid
            // renders it with securityLevel:'strict' (see loadMermaid), which sanitizes the output via
            // DOMPurify (scripts/handlers stripped). The trust boundary relies on that setting staying 'strict'.
            wrapper.innerHTML = svg;
            pre.replaceWith(wrapper);
          } catch (e) {
            if (cancelled) return;
            // If rendering fails, show the code block normally
            (block as HTMLElement).style.display = 'block';
            console.warn('[Mermaid] render failed:', e);
          }
        }
      } catch (e) {
        if (cancelled) return;
        for (const block of Array.from(mermaidBlocks)) {
          (block as HTMLElement).style.display = 'block';
        }
        console.warn('[Mermaid] failed to load:', e);
      }
    };

    void renderMermaidBlocks();

    return () => { cancelled = true; };
    // handleCopy is a stable useCallback([]) from useCopyToast, so listing it
    // cannot re-trigger this effect; copyLabel changes only on a locale switch.
  }, [html, copyLabel, handleCopy]);

  // Give a table's scroll container its keyboard affordance only where the
  // container actually scrolls, which is a property of the laid-out page and
  // not of the markup: the same table fits the article column at 1280px and
  // overflows it at 375px. A wrapper that overflows becomes a Tab stop — its
  // off-screen columns are unreachable by keyboard otherwise — and is named
  // after the section it belongs to so the stop announces something; a wrapper
  // that does not overflow surrenders every one of those attributes.
  //
  // A layout effect, so the measurement lands in the same paint as the content:
  // with a passive effect the reader would get one painted frame in which a
  // table that scrolls is unreachable by keyboard, and pressing Tab inside it
  // would be a race against the effect queue.
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const wrappers = Array.from(root.querySelectorAll<HTMLElement>('.table-scroll'));
    if (wrappers.length === 0) return;

    const measure = () => {
      wrappers.forEach((wrapper) => {
        if (wrapper.scrollWidth - wrapper.clientWidth <= SCROLL_OVERFLOW_TOLERANCE_PX) {
          // Taking tabindex off the element that currently holds focus would
          // drop the reader to <body> on a mere resize, so a focused wrapper
          // keeps what it has; the focusout listener below re-measures it the
          // moment focus moves on, which is when releasing it is free.
          if (document.activeElement === wrapper) return;
          SCROLL_REGION_ATTRIBUTES.forEach((attribute) => wrapper.removeAttribute(attribute));
          return;
        }
        wrapper.setAttribute('tabindex', '0');
        const headingIds = findSectionHeadingIds(wrapper, root);
        const labelledBy = headingIds.length === 0 ? null : headingIds.join(' ');
        const captionText = labelledBy === null ? findTableCaptionText(wrapper) : null;
        setAttributeOrRemove(wrapper, 'aria-labelledby', labelledBy);
        setAttributeOrRemove(wrapper, 'aria-label', captionText);
        // An unnamed region is not exposed as a region at all, so a wrapper
        // neither a heading nor a caption can name keeps the Tab stop it needs
        // and no role, rather than a role that announces nothing.
        setAttributeOrRemove(wrapper, 'role', labelledBy === null && captionText === null ? null : 'region');
      });
    };

    // Only a wrapper losing focus can settle the deferral above, so the
    // listener ignores the rest of the article's focus traffic: bound to the
    // whole container it would re-measure every wrapper on each of the dozen
    // Tab presses it takes to cross a page of code blocks, for nothing.
    const releaseOnFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains('table-scroll')) measure();
    };

    measure();
    // Deliberately synchronous rather than batched into the next frame: the
    // browser coalesces resize to one event per animation frame already, the
    // measurement reads a layout the resize paint has to compute regardless,
    // and deferring it would leave one painted frame in which a table that now
    // scrolls has no keyboard affordance — the very gap the layout effect exists
    // to close.
    window.addEventListener('resize', measure);
    root.addEventListener('focusout', releaseOnFocusOut);
    // A width change with no window resize behind it — the docs sub-toolbar
    // collapsing, a web font arriving, a mermaid diagram replacing a <pre>
    // above the table — reaches us only through an observer. The callback sets
    // attributes and never geometry, so the observation cannot feed itself.
    // jsdom has no ResizeObserver, hence the capability check the rest of the
    // codebase uses as well.
    const observer = 'ResizeObserver' in window ? new ResizeObserver(measure) : null;
    if (observer) {
      wrappers.forEach((wrapper) => {
        observer.observe(wrapper);
        const table = wrapper.querySelector('table');
        if (table) observer.observe(table);
      });
    }

    return () => {
      window.removeEventListener('resize', measure);
      root.removeEventListener('focusout', releaseOnFocusOut);
      observer?.disconnect();
    };
    // Keyed on the rendered HTML: a navigation or a locale switch replaces the
    // container's contents, which resets every wrapper to the inert markup and
    // needs a fresh measurement of fresh elements.
  }, [html]);

  // Drive the live region: fill it while the toast is shown, then empty it once
  // the fade-out has finished. The default aria-relevant ("additions text")
  // means the later removal is not spoken, so only the copy itself announces.
  // A layout effect keeps the message and the opacity change in the same paint,
  // so the pill never appears — or fades out — with an empty body and its box
  // stays one invariant rect for the whole time it is visible.
  useLayoutEffect(() => {
    if (toastVisible) {
      setToastMessage(copiedMessage);
      return;
    }
    const timer = setTimeout(() => setToastMessage(''), TOAST_MESSAGE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [toastVisible, copiedMessage]);

  return (
    <>
      <div
        ref={containerRef}
        className="docs-markdown"
        dangerouslySetInnerHTML={{ __html: html }}
        style={{ width: '100%' }}
      />
      {ReactDOM.createPortal(
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 88,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'rgba(255,255,255,0.85)',
            padding: '5px 8px 5px 10px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            pointerEvents: 'none',
            opacity: toastVisible ? 1 : 0,
            transition: 'opacity 0.15s ease',
            zIndex: 9999,
            backdropFilter: 'blur(8px)',
          }}
        >
          {toastMessage}
        </div>,
        document.body
      )}
    </>
  );
};

export default MarkdownRenderer;
