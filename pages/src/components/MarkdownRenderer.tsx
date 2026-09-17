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
    // Two attributes are added here, both absent from the default output:
    // - lang="en": inline code in a localized page is English (identifiers,
    //   CLI flags, log lines), so it is marked up per WCAG 2.1 SC 3.1.2
    //   (Language of Parts) — without it a screen reader voices English with
    //   the page language's pronunciation rules.
    // - font-size: inherit inside a heading: the stylesheet sizes inline code
    //   for body text, which would render a section title (a tool name is a
    //   whole heading) smaller than its own subsections.
    renderer.codespan = function (token: Tokens.Codespan) {
      const codeHtml = Renderer.prototype.codespan.call(this, token);
      const attributes = [
        language === 'en' ? '' : ' lang="en"',
        renderingHeading ? ' class="docs-heading-code" style="font-size:inherit"' : '',
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
    // tabindex makes the off-screen columns reachable by keyboard; the visual
    // styles live in docs-markdown.css.
    //
    // Call the default renderer through the call-time `this`: marked copies
    // these overrides onto a renderer of its own and assigns `parser` only to
    // that one, so a pre-bound copy of the default would run without a parser.
    const renderDefaultTable = renderer.table;
    renderer.table = function (token) {
      return `<div class="table-scroll" tabindex="0">${renderDefaultTable.call(this, token)}</div>\n`;
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
