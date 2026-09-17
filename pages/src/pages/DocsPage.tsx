// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import LandingPage from '../components/LandingPage';
import MarkdownRenderer from '../components/MarkdownRenderer';
import NotFoundPage from './NotFoundPage';
import { SearchTrigger } from '../components/SearchTrigger';
import { DOCS_TOOLBAR_HEIGHT, DocsDrawerBackdrop, DocsDrawerBar, DocsDrawerToggleSpec, docsDrawerPanelStyle, useDocsDrawer } from '../components/DocsDrawer';
import { useResponsive } from '../hooks/useResponsive';
import { useCommandSearch, useSearchKeyboardNav } from '../hooks/useCommandSearch';
import { getDocContent, getDocTitle, DocSlug, searchDocs } from '../content/docs';
import { extractHeadings } from '../utils/extractHeadings';
import docContentsIcon from '../assets/icons/doc-contents.svg';
import searchIcon from '../assets/icons/icon-search.svg';
import '../styles/docs-markdown.css';

// marked percent-encodes non-ASCII hrefs; heading ids are raw text from
// generateHeadingId, so fragments must be decoded before lookup.
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// Markdown renders a frame or more after navigation, so a fragment's heading
// may not exist yet. Retry across a few frames; the returned canceller stops a
// stale chain when navigation moves on.
function scrollToFragmentWhenReady(id: string): () => void {
  let frame = 0;
  let cancelled = false;
  const tryScroll = (attempts: number) => {
    if (cancelled) return;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (attempts < 10) {
      frame = requestAnimationFrame(() => tryScroll(attempts + 1));
    }
  };
  frame = requestAnimationFrame(() => tryScroll(0));
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

/* ─── Sidebar tree data ─── */
interface SidebarItem {
  id: string;
  labelKey: string;
  slug?: DocSlug;
  children?: SidebarItem[];
}

interface SidebarGroup {
  groupLabelKey: string;
  items: SidebarItem[];
}

const sidebarTree: SidebarGroup[] = [
  {
    groupLabelKey: 'docs.sidebar.gettingStarted',
    items: [
      { id: 'sb-quickstart', labelKey: 'docs.sidebar.quickstart', slug: 'quickstart' },
      { id: 'sb-installation', labelKey: 'docs.sidebar.installation', slug: 'installation' },
      { id: 'sb-configuration', labelKey: 'docs.sidebar.configuration', slug: 'configuration' },
    ],
  },
  {
    groupLabelKey: 'docs.sidebar.userGuide',
    items: [
      { id: 'sb-cli', labelKey: 'docs.sidebar.cliReference', slug: 'cli-reference' },
      { id: 'sb-rules', labelKey: 'docs.sidebar.reviewRules', slug: 'review-rules' },
      { id: 'sb-arch', labelKey: 'docs.sidebar.architecture', slug: 'architecture' },
      { id: 'sb-tools', labelKey: 'docs.sidebar.tools', slug: 'tools' },
      { id: 'sb-mcp', labelKey: 'docs.sidebar.mcp', slug: 'mcp' },
      { id: 'sb-viewer', labelKey: 'docs.sidebar.viewer', slug: 'viewer' },
      { id: 'sb-telemetry', labelKey: 'docs.sidebar.telemetry', slug: 'telemetry' },
      {
        id: 'sb-integrations',
        labelKey: 'docs.sidebar.integrations',
        children: [
          { id: 'sb-agent-skill', labelKey: 'docs.sidebar.agentSkill', slug: 'agent-skill' },
          { id: 'sb-claude-code', labelKey: 'docs.sidebar.claudeCode', slug: 'claude-code' },
          { id: 'sb-delegate', labelKey: 'docs.sidebar.delegate', slug: 'delegate' },
          { id: 'sb-cicd', labelKey: 'docs.sidebar.cicd', slug: 'cicd' },
        ],
      },
      { id: 'sb-contributing', labelKey: 'docs.sidebar.contributing', slug: 'contributing' },
      { id: 'sb-faq', labelKey: 'docs.sidebar.faq', slug: 'faq' },
    ],
  },
];

/* ─── Chevron icon for expandable items ───
 * Purely decorative: the expander button that owns it carries the accessible
 * name and the aria-expanded state, so the glyph is hidden from assistive
 * technology and kept out of the tab order (focusable="false" matters for the
 * SVG element in legacy engines that make it focusable by default). */
const ChevronIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
    <path d="M7.5 5L12.5 10L7.5 15" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ─── Sidebar row geometry ───
 * The interactive properties (background, label colour) live in the
 * `.docs-sidebar-row` rules in styles/index.css: an inline declaration always
 * beats a stylesheet rule, so anything that must change on :hover / :active /
 * :focus-visible cannot be declared here. Geometry never changes with state,
 * so it stays inline alongside the rest of this page's styling.
 * minHeight 44 gives every row a WCAG 2.5.5-sized hit area (it was a fixed
 * 36px before) while the 6px radius and the 22px label line-height are kept. */
const sidebarRowStyle: React.CSSProperties = {
  minHeight: 44,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  borderRadius: 6,
  padding: '10px 12px',
  cursor: 'pointer',
  transition: 'background 0.15s',
};

/* Child rows repeat the parent geometry with the 28px indent of the tree. */
const sidebarChildRowStyle: React.CSSProperties = {
  ...sidebarRowStyle,
  padding: '10px 12px 10px 28px',
};

/* The expander is a <button>, which needs the two resets a <div> did not:
 * full row width and no border. Font properties are inherited through
 * Tailwind's preflight, and the label span sets its own typography. */
const sidebarExpanderStyle: React.CSSProperties = {
  ...sidebarRowStyle,
  width: '100%',
  border: 'none',
  textAlign: 'left',
};

/* ─── Prev/next pager geometry ───
 * The hit area was 21px tall; the 12px vertical padding takes it past 44 and
 * the 10px horizontal padding is cancelled by a matching negative margin, so
 * the pager grows outwards and its label stays exactly where it was. The
 * background that reacts to :hover / :active is in `.docs-pager`, which is
 * also why the declared transition is `background` and no longer `opacity`
 * (the resting opacity is 1 and had nothing to animate towards). */
const pagerStyle: React.CSSProperties = {
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 44,
  padding: '12px 10px',
  margin: '0 -10px',
  transition: 'background 0.15s',
};

/* A modified or non-primary click on a sidebar anchor must keep its native
 * meaning — open in a new tab/window, download, or the context-menu actions
 * that depend on a real href — so only a plain primary click is intercepted
 * and turned into SPA navigation. */
function isPlainLeftClick(e: React.MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/* ─── Flat ordered list of all doc slugs for prev/next navigation ─── */
function buildFlatDocList(): { slug: DocSlug; labelKey: string }[] {
  const list: { slug: DocSlug; labelKey: string }[] = [];
  for (const group of sidebarTree) {
    for (const item of group.items) {
      if (item.slug) {
        list.push({ slug: item.slug, labelKey: item.labelKey });
      }
      if (item.children) {
        for (const child of item.children) {
          if (child.slug) {
            list.push({ slug: child.slug, labelKey: child.labelKey });
          }
        }
      }
    }
  }
  return list;
}

const flatDocList = buildFlatDocList();
const validSlugs = new Set<DocSlug>(flatDocList.map(d => d.slug));

// Id of the page-title heading. It names the <main> landmark and gives the
// title an anchor of its own; the suffix keeps it clear of the heading ids
// generated from markdown text, which are slugs of the heading's own words.
const DOC_TITLE_ID = 'docs-page-title';

/* Dev-time invariant: every sidebar slug maps to exactly one URL, so duplicates
 * (two menu entries sharing a slug) would silently collide. Fail loudly in dev. */
if (process.env.NODE_ENV !== 'production' && validSlugs.size !== flatDocList.length) {
  const slugs = flatDocList.map(d => d.slug);
  const dupes = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
  throw new Error(
    `[docs] Duplicate sidebar slug(s) detected: ${dupes.join(', ')} — each doc must have a unique slug for routing.`
  );
}

/* ─── Right-hand TOC geometry ───
 * The page header is a 72px fixed navbar, and activating a TOC entry parks its
 * heading 90px from the top of the viewport. The scroll-spy's activation line
 * sits just below that landing: a heading counts as reached once its top has
 * crossed TOC_ACTIVATION_LINE, so the heading a TOC activation lands is the
 * active one instead of the following section, which used to win because the
 * observer band was 80px..40% of the viewport and the callback kept the last
 * intersecting heading it saw. */
const NAVBAR_HEIGHT = 72;
const TOC_SCROLL_OFFSET = 90;
const TOC_ACTIVATION_LINE = 96;
/* Clearance kept between a keyboard-focused TOC entry and the fixed navbar. */
const TOC_FOCUS_CLEARANCE = 8;
/* History-state key holding the scroll position a TOC activation jumped from. */
const TOC_RETURN_SCROLL_KEY = 'tocReturnScrollY';
/* Breathing room kept around the active entry inside the TOC's scroll box. */
const TOC_ENTRY_MARGIN = 24;
/* Quiet period after the last scroll event that counts as scrolling having
 * stopped. Used to release an activation's pin when the reader interrupted its
 * scroll by some means that raises no input event of its own — dragging the
 * scrollbar, or a programmatic scroll from elsewhere on the page. */
const TOC_PIN_SETTLE_MS = 150;

/** Rendered markdown headings, in document order — the TOC's 1:1 counterpart. */
function headingElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.docs-markdown h2, .docs-markdown h3'));
}

/**
 * Resolve the heading a TOC entry points at. The id is the primary key, but a
 * heading whose text yields no slug carries id "" and document.getElementById("")
 * is always null, which made those entries inert. extractHeadings keeps the same
 * order and level filter as the renderer, so the entry's position identifies the
 * heading whenever its id cannot.
 */
function resolveHeadingElement(
  id: string,
  index: number,
  rendered?: HTMLElement[]
): HTMLElement | null {
  if (id) {
    const byId = document.getElementById(id);
    if (byId) return byId;
  }
  /* Callers resolving a whole list pass the rendered headings in, so the
   * positional fallback does not re-query the document once per heading. */
  return (rendered ?? headingElements())[index] ?? null;
}

/**
 * Whether a focus event came from the keyboard, as :focus-visible reports it. An
 * engine that does not know the selector is treated as keyboard focus, which
 * only means an entry is revealed more often than strictly necessary.
 */
function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/* ─── Search palette element ids ───
 * The input, the results listbox and each option reference one another through
 * aria-controls / aria-activedescendant / id, so the ids must be shared
 * constants instead of literals repeated at three call sites. Exactly one
 * DocsPage (and therefore one palette) is mounted at a time, so fixed ids
 * cannot collide. */
const SEARCH_INPUT_ID = 'docs-search-input';
const SEARCH_LISTBOX_ID = 'docs-search-results';
const SEARCH_OPTION_ID_PREFIX = 'docs-search-option-';

/* Focusable descendants of the palette, in DOM order, used by its Tab trap.
 * A module constant because the selector is static, not state. */
const SEARCH_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/* Product name every document title ends with. Kept here rather than imported
 * from App so the lazily loaded docs chunk does not depend on the app shell. */
const SITE_TITLE = 'Open Code Review';

const DocsPage: React.FC = () => {
  const { slug: slugParam } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { hash, search } = useLocation();
  /* Active doc slug is derived from the URL param. `/docs` with no param opens
   * QuickStart, and a slug that names a real doc serves it. The other two cases
   * are answered below, before the page renders: a slug differing only in case
   * is redirected to its canonical URL, and an unknown slug renders the site's
   * not-found view. Serving QuickStart for both — which is what the bare
   * fallback used to do — returned a healthy-looking page under the requested
   * URL, hiding typos and wrong-case links behind the wrong document. */
  const requestedSlug = slugParam ?? '';
  const isKnownSlug = validSlugs.has(requestedSlug as DocSlug);
  const canonicalSlug = requestedSlug.toLowerCase();
  const needsCanonicalRedirect = !isKnownSlug && validSlugs.has(canonicalSlug as DocSlug);
  const isUnknownSlug = requestedSlug !== '' && !isKnownSlug && !needsCanonicalRedirect;
  const activeSlug: DocSlug = isKnownSlug ? (requestedSlug as DocSlug) : 'quickstart';
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({ 'sb-integrations': true });
  /* The active TOC entry is tracked by position rather than by heading id: ids
   * are not guaranteed unique when a heading's text yields an empty slug, and an
   * empty id used to collide with the initial state and paint an entry active
   * before the reader had gone anywhere. null means "not resolved yet". */
  const [activeHeadingIndex, setActiveHeadingIndex] = useState<number | null>(null);
  /* Entry a TOC activation is scrolling to. The scroll-spy defers to it until
   * the scroll arrives or the reader scrolls on their own, so the entry the
   * reader activated is the one that stays highlighted. */
  const pinnedHeadingIndex = useRef<number | null>(null);
  /* Where an activation's scroll came to rest when the end of the document
   * clamped it short of the activation line. The scroll-spy cannot resolve to
   * that entry, so its pin outlives a settled scroll — but only for as long as
   * the reader stays on the position the clamp landed them on. */
  const pinnedClampTarget = useRef<number | null>(null);
  const tocRef = useRef<HTMLElement | null>(null);
  /* Cancels an in-flight click-triggered scroll when a newer one starts */
  const cancelPendingScroll = useRef<(() => void) | null>(null);
  const { t, language } = useTranslation();
  const { isMobile, isTablet, isDesktop } = useResponsive();
  const {
    searchOpen, setSearchOpen,
    searchQuery, setSearchQuery,
    searchSelectedIdx, setSearchSelectedIdx,
    searchInputRef,
    searchResults,
  } = useCommandSearch(searchDocs, language);
  /* HTMLElement, not HTMLDivElement: the content column is a <main> landmark. */
  const contentRef = React.useRef<HTMLElement>(null);
  const [skipLinkFocused, setSkipLinkFocused] = useState(false);

  /* ─── Responsive layout shell ───
   * A 264px tree rail plus a 220px TOC rail plus the article's 96px padding
   * leave only 188px of prose at 768px — less than the 335px the same text gets
   * at 375px — so the rails are shed one band at a time and reached from a
   * fixed sub-toolbar instead (see components/DocsDrawer.tsx):
   *   mobile  (<768)      : both rails are off-canvas panels
   *   tablet  (768-1024)  : tree rail mounted, TOC off-canvas
   *   desktop (>1024)     : both rails mounted, no toolbar */
  const breakpointBand = isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop';
  const navHeight = isMobile ? 56 : 72;           // Navbar renders 56 below 768, 72 above
  const showRailToolbar = !isDesktop;
  const sidebarIsDrawer = isMobile;
  const tocIsDrawer = !isDesktop;

  const fontFamily = 'PingFang SC, -apple-system, BlinkMacSystemFont, sans-serif';

  /* Get markdown content for current doc */
  const docContent = useMemo(() => getDocContent(activeSlug, language), [activeSlug, language]);
  const docTitle = useMemo(() => getDocTitle(activeSlug, language), [activeSlug, language]);
  const headings = useMemo(() => extractHeadings(docContent), [docContent]);

  /* One toggle per rail that is currently off-canvas: the tree only when it is
   * a drawer (at tablet it stays a mounted rail), the TOC only when the doc has
   * headings to list. */
  const drawerToggles = useMemo<DocsDrawerToggleSpec[]>(() => {
    const toggles: DocsDrawerToggleSpec[] = [];
    if (sidebarIsDrawer) {
      toggles.push({ panel: 'sidebar', label: t('docs.nav.menuLabel'), controls: 'docs-sidebar-nav' });
    }
    if (tocIsDrawer && headings.length > 0) {
      toggles.push({ panel: 'toc', label: t('docs.toc'), controls: 'docs-toc-nav' });
    }
    return toggles;
  }, [sidebarIsDrawer, tocIsDrawer, headings.length, t]);

  /* The toolbar only occupies space when it has something to show, so a doc
   * without headings at tablet width does not reserve an empty 52px band. */
  const railToolbarVisible = showRailToolbar && drawerToggles.length > 0;
  /* Height of the fixed chrome above the article: navbar, plus the sub-toolbar
   * when it is shown. Panels start below it and the mounted rails stick to it. */
  const chromeHeight = navHeight + (railToolbarVisible ? DOCS_TOOLBAR_HEIGHT : 0);
  /* The TOC geometry follows the live chrome: the landing offset and the
   * scroll-spy's activation line keep their 18px and 24px clearance below
   * whatever is fixed at the top, so a heading a TOC jump lands on is still the
   * one the spy resolves to when the sub-toolbar is showing. */
  const tocScrollOffset = chromeHeight + (TOC_SCROLL_OFFSET - NAVBAR_HEIGHT);
  const tocActivationLine = chromeHeight + (TOC_ACTIVATION_LINE - NAVBAR_HEIGHT);

  /* Navigating, crossing a breakpoint or opening the command palette all
   * dismiss an open panel. */
  const { openPanel, toggle: toggleDrawerPanel, close: closeDrawerPanel, panelRef } = useDocsDrawer({
    enabled: showRailToolbar,
    dismissKey: `${breakpointBand}|${activeSlug}|${searchOpen ? 'search-open' : 'search-closed'}`,
  });

  /* Skip link target: move focus (not just the scroll position) into <main>, so
   * the next Tab lands inside the article instead of back in the chrome. The
   * scroll is offset by the fixed chrome, because focus() alone parks the
   * article's first heading underneath the navbar and the sub-toolbar. */
  const skipToContent = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = contentRef.current ?? document.getElementById('docs-content');
    if (!target) return;
    target.focus({ preventScroll: true });
    const top = target.getBoundingClientRect().top + window.scrollY - chromeHeight;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  }, [chromeHeight]);

  /* Name the tab after the document on screen. The route-level title in App
   * cannot do it: which document is open, and what it is called in the current
   * locale, is known only here. A redirecting render is skipped so the title
   * never flickers through the doc the canonical URL is about to replace. */
  useEffect(() => {
    if (needsCanonicalRedirect) return;
    document.title = isUnknownSlug
      ? `${t('notFound.title')} — ${SITE_TITLE}`
      : `${docTitle} — ${SITE_TITLE}`;
  }, [docTitle, isUnknownSlug, needsCanonicalRedirect, t]);

  /* Scroll direct links after their markdown heading has rendered */
  useEffect(() => {
    const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!fragment) return;
    return scrollToFragmentWhenReady(decodeFragment(fragment));
  }, [hash, docContent]);

  /* A heading position from the previous document means nothing in the new
   * document's TOC, so drop the active entry (and any pending activation) as
   * soon as the content changes; the scroll-spy below resolves it again. */
  useEffect(() => {
    pinnedHeadingIndex.current = null;
    setActiveHeadingIndex(null);
  }, [headings]);

  /* Track the active heading.
   * The active entry is the last heading whose top has crossed the activation
   * line below the navbar; when none has, the reader is still above the first
   * heading and the first entry is the active one. An IntersectionObserver wakes
   * the computation as headings enter and leave the top of the viewport, and
   * scroll/resize listeners cover what it cannot report: a resize moves every
   * heading without producing a crossing, which used to leave the highlight
   * stuck on whichever heading was current before the viewport changed. */
  useEffect(() => {
    if (headings.length === 0) return;
    /* A redirecting or not-found render mounts no article, so there is nothing
     * to spy on — and the fallback document's headings would otherwise be
     * reported as a TOC/heading mismatch against an empty page. */
    if (needsCanonicalRedirect || isUnknownSlug) return;
    const rendered = headingElements();
    /* The positional fallback for an id-less heading is only sound while the
     * extracted headings and the rendered ones line up one for one. They share
     * the same source and level filter, so a mismatch means the renderer and
     * the extractor have diverged — say so in dev rather than resolving an
     * entry to the wrong heading in silence. */
    if (process.env.NODE_ENV !== 'production' && rendered.length !== headings.length) {
      console.warn(
        `[docs] TOC/heading mismatch: ${headings.length} extracted vs ${rendered.length} rendered — ` +
          'positional fallback for id-less headings may resolve to the wrong heading.'
      );
    }
    const els = headings.map((h, i) => resolveHeadingElement(h.id, i, rendered));
    const firstIndex = els.findIndex(el => el !== null);
    if (firstIndex === -1) return;

    let frame = 0;
    const computeActive = () => {
      let reached: number | null = null;
      for (let i = 0; i < els.length; i += 1) {
        const el = els[i];
        if (!el) continue;
        /* Headings are in document order, so the first one still below the line
         * ends the search. */
        if (el.getBoundingClientRect().top > tocActivationLine) break;
        reached = i;
      }
      const next = reached ?? firstIndex;
      const pinned = pinnedHeadingIndex.current;
      if (pinned !== null) {
        /* Keep the activated entry highlighted while its scroll is in flight,
         * and hand tracking back once the scroll has arrived on it. */
        if (next === pinned) pinnedHeadingIndex.current = null;
        return;
      }
      setActiveHeadingIndex(next);
    };
    /* A reader who scrolls, swipes or navigates by key has taken over from the
     * activation that pinned an entry. Enter and Space are excluded because
     * they are how a focused entry is activated in the first place. */
    const releasePin = () => {
      pinnedHeadingIndex.current = null;
      pinnedClampTarget.current = null;
    };
    let settle = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(computeActive);
      /* A pin is meant to last only until its activation's scroll arrives, and
       * computeActive clears it there. A reader can end that scroll somewhere
       * else by dragging the scrollbar, and another part of the page can scroll
       * programmatically; neither raises an input event, so a pin that outlived
       * a settled scroll is released here too rather than freezing the
       * highlight until the reader happens to use the wheel or a key.
       * An activation the document's end clamped is the one case where the
       * highlight legitimately cannot follow the line — its heading never
       * reaches it — so that pin is kept while the reader remains where the
       * clamp left them, and dropped as soon as they move off it. */
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (pinnedHeadingIndex.current === null) return;
        const clampTarget = pinnedClampTarget.current;
        if (clampTarget !== null && Math.abs(window.scrollY - clampTarget) <= 1) return;
        releasePin();
        computeActive();
      }, TOC_PIN_SETTLE_MS);
    };
    const releasePinOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') return;
      releasePin();
    };

    const observer = new IntersectionObserver(schedule, {
      rootMargin: `-${chromeHeight}px 0px 0px 0px`,
      threshold: 0,
    });
    els.forEach(el => {
      if (el) observer.observe(el);
    });
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('wheel', releasePin, { passive: true });
    window.addEventListener('touchmove', releasePin, { passive: true });
    window.addEventListener('keydown', releasePinOnKey);
    computeActive();

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('wheel', releasePin);
      window.removeEventListener('touchmove', releasePin);
      window.removeEventListener('keydown', releasePinOnKey);
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [headings, chromeHeight, tocActivationLine, needsCanonicalRedirect, isUnknownSlug]);

  /* Keep the active entry inside the TOC's own scroll box. The column holds more
   * entries than it can show on a long document, so the highlighted entry could
   * sit below its fold with nothing to tell the reader where they are. Only the
   * column scrolls here — never the page. */
  useEffect(() => {
    const container = tocRef.current;
    if (!container || activeHeadingIndex === null) return;
    /* A reader moving through the entries by keyboard owns the column's scroll:
     * revealing the active entry here would carry the focused one — and its
     * focus indicator — out of the column's view, which is the WCAG 2.4.11
     * failure the focus handling below exists to prevent. The entry they are
     * on is already visible, so there is nothing to reveal either. The test is
     * for keyboard focus specifically: a pointer activation also leaves DOM
     * focus on the entry, and that reader still expects the column to follow
     * along as they scroll on. */
    const focused = document.activeElement;
    if (focused && container.contains(focused) && isKeyboardFocus(focused)) return;
    const entry = container.querySelector<HTMLElement>('[aria-current="location"]');
    if (!entry) return;
    const entryTop = entry.offsetTop;
    const entryBottom = entryTop + entry.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (entryTop < viewTop + TOC_ENTRY_MARGIN) {
      container.scrollTop = Math.max(0, entryTop - TOC_ENTRY_MARGIN);
    } else if (entryBottom > viewBottom - TOC_ENTRY_MARGIN) {
      container.scrollTop = entryBottom - container.clientHeight + TOC_ENTRY_MARGIN;
    }
  }, [activeHeadingIndex]);

  /* Going BACK over a TOC activation must return the reader to where they were
   * rather than leaving them at the heading they jumped to: the router sets
   * history.scrollRestoration to 'manual', so the browser restores nothing by
   * itself. The position was recorded on the entry being left; it is applied
   * only when that entry carries no fragment of its own, because a fragment
   * landing belongs to the fragment effect rather than here. */
  useEffect(() => {
    const restoreScrollOnPop = () => {
      if (window.location.hash) return;
      const state = window.history.state as Record<string, unknown> | null;
      const returnScrollY = state?.[TOC_RETURN_SCROLL_KEY];
      if (typeof returnScrollY !== 'number') return;
      pinnedHeadingIndex.current = null;
      window.scrollTo({ top: returnScrollY, behavior: 'auto' });
    };
    window.addEventListener('popstate', restoreScrollOnPop);
    return () => window.removeEventListener('popstate', restoreScrollOnPop);
  }, []);

  /* Prev/Next navigation */
  const { prevDoc, nextDoc } = useMemo(() => {
    const idx = flatDocList.findIndex(d => d.slug === activeSlug);
    return {
      prevDoc: idx > 0 ? flatDocList[idx - 1] : null,
      nextDoc: idx < flatDocList.length - 1 ? flatDocList[idx + 1] : null,
    };
  }, [activeSlug]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const navigateToDoc = useCallback((slug: DocSlug) => {
    // Scroll position belongs to the route-change scroll manager in App: a new
    // history entry starts at the top of the page, and Back or Forward returns
    // the reader to the offset they left. Resetting it here as well would be
    // redundant on the way in and wrong on the way back.
    navigate(`/docs/${slug}`);
  }, [navigate]);

  /* Intercept clicks on internal doc links and convert to SPA navigation */
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    // Skip external links
    if (href.startsWith('http://') || href.startsWith('https://')) return;
    // Skip pure anchors (same-page scroll)
    if (href.startsWith('#')) {
      e.preventDefault();
      const id = decodeFragment(href.slice(1));
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Parse relative paths to extract slug
    // Patterns: ../slug/, slug/, ../../slug/, ../slug/#anchor
    const pathOnly = href.split('#')[0].replace(/\/+$/, ''); // remove trailing slash & anchor
    const segments = pathOnly.split('/').filter(s => s !== '' && s !== '.' && s !== '..');
    const lastSegment = segments[segments.length - 1];
    if (!lastSegment) return;
    // Map path segment to DocSlug (ci -> cicd)
    const slugMap: Record<string, DocSlug> = { 'ci': 'cicd' };
    const slug = (slugMap[lastSegment] || lastSegment) as DocSlug;
    // Verify it's a valid doc slug
    if (validSlugs.has(slug)) {
      e.preventDefault();
      navigateToDoc(slug);
      // Handle anchor scroll after navigation with reliable retry
      const anchor2raw = href.split('#')[1];
      const anchor2 = anchor2raw ? decodeFragment(anchor2raw) : undefined;
      if (anchor2) {
        cancelPendingScroll.current?.();
        cancelPendingScroll.current = scrollToFragmentWhenReady(anchor2);
      }
    }
  }, [navigateToDoc]);

  /**
   * Activate a TOC entry: scroll its heading clear of the fixed navbar, mark the
   * entry active straight away, and put the heading's fragment in the address
   * bar so the section can be copied, shared and bookmarked, and so BACK undoes
   * the jump instead of leaving the documentation page.
   *
   * The fragment is written with history.pushState rather than a router
   * navigation on purpose: a router navigation would re-run the fragment effect,
   * whose scrollIntoView knows nothing about the navbar offset applied here and
   * would drop the heading back under the navbar.
   */
  const scrollToHeading = useCallback((id: string, index: number) => {
    const el = resolveHeadingElement(id, index);
    if (!el) return;
    /* Where the reader is now, before the jump, so BACK can return them here. */
    const returnScrollY = window.scrollY;
    /* Offset by the whole fixed chrome, not by a constant: the original 90 cleared
     * the 72px navbar with 18px to spare, but the sub-toolbar sits below the
     * navbar at mobile and tablet widths, so a TOC jump measured from 90 parks the
     * target heading underneath it. */
    const top = el.getBoundingClientRect().top + returnScrollY - tocScrollOffset;
    /* Either end of the document can clamp the jump and leave the heading short
     * of the activation line — clicking the last entry cannot scroll past the
     * document's end. The scroll-spy then has no way to resolve to this entry,
     * so its pin has to outlast the scroll rather than expire with it. */
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const target = Math.min(Math.max(0, top), maxScroll);
    pinnedHeadingIndex.current = index;
    pinnedClampTarget.current = target !== top ? target : null;
    setActiveHeadingIndex(index);
    window.scrollTo({ top: target, behavior: 'smooth' });
    /* A heading with no slug has no addressable fragment; it still scrolls. */
    if (!id) return;
    const fragment = `#${encodeURIComponent(id)}`;
    if (window.location.hash === fragment) return;
    /* Record the reader's position on the entry being left, then add the new
     * one. The router's history index is carried forward so its own pop
     * bookkeeping stays consistent with the entry this adds, and any position
     * recorded by an earlier activation is dropped from what the new entry
     * carries — it belongs to the entry that is being left, not to this one. */
    const carried: Record<string, unknown> = { ...(window.history.state ?? {}) };
    delete carried[TOC_RETURN_SCROLL_KEY];
    window.history.replaceState({ ...carried, [TOC_RETURN_SCROLL_KEY]: returnScrollY }, '');
    const nextState =
      typeof carried.idx === 'number' ? { ...carried, idx: carried.idx + 1 } : carried;
    window.history.pushState(nextState, '', fragment);
  }, [tocScrollOffset]);

  /**
   * WCAG 2.4.11: near the end of the document the sticky TOC column is pushed up
   * by the bottom of its containing block, which can leave a keyboard-focused
   * entry — and its focus ring — entirely inside the fixed navbar's band. Nudge
   * the page just far enough to bring the focused entry back below the navbar.
   * Pointer focus is left alone, since a click scrolls the page by itself.
   */
  const handleEntryFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const el = event.currentTarget;
    if (!isKeyboardFocus(el)) return;
    const minTop = chromeHeight + TOC_FOCUS_CLEARANCE;
    const { top } = el.getBoundingClientRect();
    if (top >= minTop) return;
    window.scrollBy({ top: top - minTop, behavior: 'auto' });
  }, [chromeHeight]);

  /* Auto-expand parent when a child is active */
  useEffect(() => {
    for (const group of sidebarTree) {
      for (const item of group.items) {
        if (item.children && item.children.some(c => c.slug === activeSlug)) {
          setExpandedItems(prev => ({ ...prev, [item.id]: true }));
        }
      }
    }
  }, [activeSlug]);

  /* Handle search result selection */
  const handleSearchSelect = useCallback((slug: DocSlug) => {
    navigateToDoc(slug);
    setSearchOpen(false);
  }, [navigateToDoc, setSearchOpen]);

  /* Keyboard navigation in search modal */
  const handleSearchKeyDown = useSearchKeyboardNav(
    searchResults, searchSelectedIdx, setSearchSelectedIdx, handleSearchSelect,
  );

  /* ─── Search palette modal focus management ───
   * The palette is a modal dialog (role="dialog" aria-modal="true"), so focus
   * must stay inside it while it is open and must return to the control that
   * opened it when it closes — otherwise a keyboard user is silently dropped at
   * the top of the document. */
  const searchPanelRef = useRef<HTMLDivElement>(null);
  /* Element that held focus when the palette opened: the sidebar trigger, or
   * whatever was focused when ⌘K/Ctrl+K fired. */
  const searchOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (searchOpen) {
      const active = document.activeElement;
      /* document.body is the "nothing was focused" case; restoring focus to it
       * later would be a no-op that still blurs, so record nothing instead. */
      searchOpenerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
      return;
    }
    const opener = searchOpenerRef.current;
    searchOpenerRef.current = null;
    /* The opener can have unmounted while the palette was open (selecting a
     * result re-renders the sidebar), and a detached node cannot take focus. */
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      opener.focus();
    }
  }, [searchOpen]);

  /* Active option's id, for the input's aria-activedescendant. Undefined when
   * there is no option to point at: aria-activedescendant naming a missing
   * element is worse than its absence. */
  const searchActiveOptionId =
    searchSelectedIdx >= 0 && searchSelectedIdx < searchResults.length
      ? `${SEARCH_OPTION_ID_PREFIX}${searchSelectedIdx}`
      : undefined;

  /* Tab trap for the palette. Only Tab is acted on: ArrowUp/ArrowDown/Enter
   * belong to the input's own handler and Escape to useCommandSearch, so every
   * other key must pass through untouched. */
  const handleSearchPanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const panel = searchPanelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(SEARCH_FOCUSABLE_SELECTOR));
    /* Nothing focusable (the palette renders only its input before a query is
     * typed, but a future empty state must not throw): leave Tab to the browser. */
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const insidePanel = active instanceof HTMLElement && panel.contains(active);
    if (e.shiftKey) {
      /* Shift+Tab from the first element — or from outside the palette — wraps
       * to the last, so focus never lands on the page behind the dialog. */
      if (!insidePanel || active === first) {
        e.preventDefault();
        last.focus();
      }
      return;
    }
    if (!insidePanel || active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  /* A slug that differs from a real one only in case (/docs/TOOLS) is sent to
   * its canonical URL, replacing the history entry so Back still leaves the
   * docs rather than bouncing off the redirect. Query and fragment travel with
   * it, so a shared deep link keeps working. */
  if (needsCanonicalRedirect) {
    return <Navigate to={`/docs/${canonicalSlug}${search}${hash}`} replace />;
  }

  /* An unknown slug renders the site's not-found view at the requested URL —
   * the same view the catch-all route renders, so a mistyped docs link is as
   * recognisable as any other dead URL. */
  if (isUnknownSlug) {
    return (
      <LandingPage>
        <NotFoundPage />
      </LandingPage>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000000',
        paddingTop: chromeHeight,
        fontFamily,
        /* Read by docs-markdown.css as the headings' scroll-margin-top, so a
           native fragment landing clears the same chrome a TOC jump does. */
        ['--docs-heading-offset' as string]: `${tocScrollOffset}px`,
      } as React.CSSProperties}
    >
      {/* Skip link: first element in DOM order, so it is the first Tab stop.
          Off-screen until focused, and keyboard-only by construction. */}
      <a
        href="#docs-content"
        onClick={skipToContent}
        onFocus={() => setSkipLinkFocused(true)}
        onBlur={() => setSkipLinkFocused(false)}
        style={skipLinkFocused ? {
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: 300,
          padding: '10px 16px',
          borderRadius: 8,
          background: '#0a0a0a',
          border: '1px solid rgba(43,222,94,0.4)',
          outline: '2px solid #2BDE5E',
          outlineOffset: 2,
          color: '#2BDE5E',
          fontSize: 14,
          fontFamily,
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        } : {
          position: 'fixed',
          top: 8,
          left: 8,
          width: 1,
          height: 1,
          padding: 0,
          border: 'none',
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
          color: 'transparent',
          textDecoration: 'none',
        }}
      >
        {t('docs.skipToContent')}
      </a>
      <Navbar />
      {/* Sub-toolbar carrying the off-canvas rail toggles below 1024px */}
      {railToolbarVisible && (
        <DocsDrawerBar
          top={navHeight}
          toggles={drawerToggles}
          openPanel={openPanel}
          onToggle={toggleDrawerPanel}
          fontFamily={fontFamily}
        />
      )}
      {openPanel !== null && <DocsDrawerBackdrop top={chromeHeight} onClose={closeDrawerPanel} />}
      {/* Main layout: left sidebar + content + right TOC */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'flex-start', maxWidth: 1440, margin: '0 auto', minHeight: `calc(100vh - ${chromeHeight}px)` }}>

        {/* ─── Left sidebar: tree navigation ───
            Always mounted: below 768px it becomes an off-canvas panel rather
            than disappearing, so the docs tree and its search trigger stay
            reachable on a phone. The two modes get separate style objects
            because a sticky rail and a fixed panel share no geometry. */}
        <nav
          id="docs-sidebar-nav"
          aria-label={t('docs.nav.ariaLabel')}
          aria-hidden={sidebarIsDrawer && openPanel !== 'sidebar' ? true : undefined}
          tabIndex={sidebarIsDrawer ? -1 : undefined}
          ref={sidebarIsDrawer && openPanel === 'sidebar' ? panelRef : undefined}
          style={sidebarIsDrawer ? docsDrawerPanelStyle('left', chromeHeight, openPanel === 'sidebar') : {
            position: 'sticky',
            top: chromeHeight,
            width: 264,
            flexShrink: 0,
            height: `calc(100vh - ${chromeHeight}px)`,
            overflowY: 'auto',
            paddingTop: 40,
            paddingBottom: 40,
            paddingRight: 12,
            paddingLeft: 24,
            borderRight: 'none',
          }}
        >
            {/* Search trigger button */}
            <SearchTrigger
              placeholder={t('docs.search.placeholder')}
              onClick={() => setSearchOpen(true)}
              style={{ width: '100%', justifyContent: 'space-between', marginBottom: 20 }}
            />

            {sidebarTree.map((group, gi) => (
              <div key={gi} style={{ display: 'flex', flexDirection: 'column', marginBottom: 16 }}>
                {/* Group header */}
                <div style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px 12px 12px',
                }}>
                  <span style={{ flexShrink: 0, fontSize: 14, fontWeight: 600, color: '#ffffff', fontFamily, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    {t(group.groupLabelKey)}
                  </span>
                </div>
                {/* Group items */}
                {group.items.map((item) => {
                  const isActive = item.slug != null && item.slug === activeSlug;
                  const hasChildren = item.children && item.children.length > 0;
                  const isExpanded = expandedItems[item.id] ?? false;
                  return (
                    <React.Fragment key={item.id}>
                      {item.slug ? (
                        /* A doc entry is a real link: it is reachable by Tab,
                         * activated by Enter, and its href makes middle-click,
                         * ctrl/cmd-click, "open in new tab" and "copy link
                         * address" work like any other link on the web. The
                         * plain primary click is still handled in-app so the
                         * SPA keeps its client-side navigation. */
                        <a
                          className="docs-sidebar-row"
                          href={`/docs/${item.slug}`}
                          aria-current={isActive ? 'page' : undefined}
                          data-active={isActive ? 'true' : undefined}
                          onClick={(e) => {
                            if (!isPlainLeftClick(e)) return;
                            e.preventDefault();
                            navigateToDoc(item.slug!);
                          }}
                          style={sidebarRowStyle}
                        >
                          <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 8 }}>
                            <span className="docs-sidebar-row-label" style={{
                              flexShrink: 0,
                              fontSize: 14,
                              fontFamily,
                              fontWeight: isActive ? 500 : 400,
                              lineHeight: '22px',
                              transition: 'color 0.2s',
                            }}>
                              {t(item.labelKey)}
                            </span>
                          </div>
                        </a>
                      ) : (
                        /* Every slug-less entry in sidebarTree is a group with
                         * children (buildFlatDocList only collects slugs), so
                         * the whole row is the expander: one button, one
                         * accessible name, aria-expanded for the children it
                         * mounts and unmounts, and native Enter/Space. */
                        <button
                          type="button"
                          className="docs-sidebar-row"
                          aria-expanded={isExpanded}
                          onClick={() => toggleExpand(item.id)}
                          style={sidebarExpanderStyle}
                        >
                          <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 8 }}>
                            <span className="docs-sidebar-row-label" style={{
                              flexShrink: 0,
                              fontSize: 14,
                              fontFamily,
                              fontWeight: 400,
                              lineHeight: '22px',
                              transition: 'color 0.2s',
                            }}>
                              {t(item.labelKey)}
                            </span>
                          </div>
                          {hasChildren && <ChevronIcon expanded={isExpanded} />}
                        </button>
                      )}
                      {/* Children (sub-items) */}
                      {hasChildren && isExpanded && item.children!.map((child) => {
                        const childActive = child.slug != null && child.slug === activeSlug;
                        /* Children are leaf doc entries by construction; one
                         * without a slug would have no URL to link to and no
                         * children to expand, so there is nothing to render. */
                        if (!child.slug) return null;
                        return (
                          <a
                            key={child.id}
                            className="docs-sidebar-row"
                            href={`/docs/${child.slug}`}
                            aria-current={childActive ? 'page' : undefined}
                            data-active={childActive ? 'true' : undefined}
                            onClick={(e) => {
                              if (!isPlainLeftClick(e)) return;
                              e.preventDefault();
                              navigateToDoc(child.slug!);
                            }}
                            style={sidebarChildRowStyle}
                          >
                            <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 8 }}>
                              <span className="docs-sidebar-row-label" style={{
                                flexShrink: 0,
                                fontSize: 14,
                                fontFamily,
                                fontWeight: childActive ? 500 : 400,
                                lineHeight: '22px',
                                transition: 'color 0.2s',
                              }}>
                                {t(child.labelKey)}
                              </span>
                            </div>
                          </a>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            ))}
          </nav>

        {/* ─── Main content area ─── */}
        {/* The landmark takes its accessible name from the page title below, so
            assistive technology announces "Tools, main" rather than an unnamed
            region; the title carries an id of its own so it is addressable as
            an in-page anchor, which the markdown headings below it already are. */}
        <main id="docs-content" aria-labelledby={DOC_TITLE_ID} tabIndex={-1} ref={contentRef} onClick={handleContentClick} style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0, outline: 'none', padding: isMobile ? '32px 20px 80px' : '40px 48px 80px' }}>
          {/* Doc title */}
          <h1 id={DOC_TITLE_ID} style={{ fontSize: 28, fontWeight: 700, color: '#FFFFFF', margin: '0 0 32px 0', lineHeight: '36px', fontFamily }}>
            {docTitle}
          </h1>
          {/* Rendered markdown content */}
          <MarkdownRenderer content={docContent} />

          {/* ─── Prev / Next pagination ─── */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 56,
          }}>
            {prevDoc ? (
              <button
                className="docs-pager"
                onClick={() => navigateToDoc(prevDoc.slug)}
                style={pagerStyle}
              >
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }}>‹</span>
                <span style={{ fontSize: 14, fontFamily, color: 'rgba(255,255,255,0.7)', fontWeight: 400 }}>
                  {t(prevDoc.labelKey)}
                </span>
              </button>
            ) : <span />}
            {nextDoc ? (
              <button
                className="docs-pager"
                onClick={() => navigateToDoc(nextDoc.slug)}
                style={pagerStyle}
              >
                <span style={{ fontSize: 14, fontFamily, color: 'rgba(255,255,255,0.7)', fontWeight: 400 }}>
                  {t(nextDoc.labelKey)}
                </span>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }}>›</span>
              </button>
            ) : <span />}
          </div>
        </main>

        {/* ─── Right sidebar: page TOC ───
            A labelled nav landmark holding a list of in-page links: assistive
            technology can jump to it, announce how many sections it holds and
            announce which one the reader is in (aria-current), and the entries
            behave like the links they are — copyable, middle-clickable and
            openable in a new tab.
            Mounted as a rail only above 1024px: at 768px a second fixed rail
            leaves the prose column narrower than on a phone, so below desktop
            the TOC becomes an off-canvas panel while every entry stays in the
            DOM. Tapping an entry closes the panel — the handler sits on the
            <nav>, leaving the entry links untouched. */}
        {headings.length > 0 && (
          <nav
            id="docs-toc-nav"
            className="docs-toc"
            aria-label={t('docs.toc.ariaLabel')}
            aria-hidden={tocIsDrawer && openPanel !== 'toc' ? true : undefined}
            tabIndex={tocIsDrawer ? -1 : undefined}
            ref={(node) => {
              /* The column is both the scroll box the active entry is kept
                 inside of and, while it is an open panel, the drawer's focus
                 target — one element, two owners. */
              tocRef.current = node;
              if (tocIsDrawer && openPanel === 'toc') panelRef(node);
            }}
            onClick={tocIsDrawer && openPanel === 'toc' ? closeDrawerPanel : undefined}
            style={tocIsDrawer ? docsDrawerPanelStyle('right', chromeHeight, openPanel === 'toc') : {
              position: 'sticky',
              top: chromeHeight,
              width: 220,
              flexShrink: 0,
              height: `calc(100vh - ${chromeHeight}px)`,
              overflowY: 'auto',
              overflowX: 'hidden',
              paddingLeft: 20,
              paddingRight: 24,
              paddingTop: 40,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <img src={docContentsIcon} alt="" style={{ width: 20, height: 20 }} />
              <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.05em', position: 'relative', top: 1 }}>
                {t('docs.toc')}
              </span>
            </div>
            <ul className="docs-toc__list" role="list">
              {headings.map((h, i) => {
                const isActive = i === activeHeadingIndex;
                /* Hover, press and focus treatments live in index.css: they are
                   real CSS states, which an inline style cannot express. */
                const entryProps = {
                  className: `docs-toc__link${h.level === 3 ? ' docs-toc__link--sub' : ''}`,
                  'aria-current': isActive ? ('location' as const) : undefined,
                  onFocus: handleEntryFocus,
                  children: h.text,
                };
                return (
                  <li key={i} className="docs-toc__item">
                    {h.id ? (
                      <a
                        {...entryProps}
                        href={`#${encodeURIComponent(h.id)}`}
                        onClick={(event) => {
                          /* A modified or non-primary click is the reader asking
                             the browser to open the link its own way — in a new
                             tab or window — which is half the point of these
                             being links, so leave those alone. */
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          ) {
                            return;
                          }
                          /* The default jump ignores the navbar offset, so the
                             scroll and the fragment are handled here instead. */
                          event.preventDefault();
                          scrollToHeading(h.id, i);
                        }}
                        onKeyDown={(event) => {
                          /* These entries were buttons, where Space activated
                             them; keep that working now that they are links. */
                          if (event.key === ' ') {
                            event.preventDefault();
                            scrollToHeading(h.id, i);
                          }
                        }}
                      />
                    ) : (
                      /* A heading whose text yields no slug has no fragment to
                         link to, so its entry stays a button — still focusable
                         and still able to scroll, rather than a broken link. */
                      <button
                        {...entryProps}
                        type="button"
                        onClick={() => scrollToHeading(h.id, i)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
      <Footer />

      {/* Search Modal */}
      {searchOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 9999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            paddingTop: 120,
          }}
          onClick={() => setSearchOpen(false)}
        >
          {/* The card — not the backdrop — is the dialog: aria-modal="true" tells
              assistive technology that content outside it is inert, which is why
              the page shell is not separately aria-hidden. */}
          <div
            ref={searchPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('docs.search.dialogLabel')}
            style={{
              width: 560,
              maxWidth: '90vw',
              background: '#141414',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
            }}
            onClick={e => e.stopPropagation()}
            onKeyDown={handleSearchPanelKeyDown}
          >
            {/* Search input */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px' }}>
              <img src={searchIcon} alt="" style={{ width: 16, height: 16, flexShrink: 0, opacity: 0.6 }} />
              {/* The palette has no visible heading, so the input carries its own
                  accessible name. aria-controls/aria-activedescendant are set only
                  while the listbox and the active option actually exist. No
                  role="combobox": aria-activedescendant is valid on a textbox and
                  aria-controls is an ARIA global, so the pattern is complete
                  without pulling in ARIA 1.2's combobox requirements. */}
              <input
                ref={searchInputRef}
                id={SEARCH_INPUT_ID}
                name="docs-search"
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('docs.search.placeholder')}
                aria-label={t('docs.search.inputLabel')}
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls={searchResults.length > 0 ? SEARCH_LISTBOX_ID : undefined}
                aria-activedescendant={searchActiveOptionId}
                /* No inline `outline: none` here: it would suppress the
                 * site-wide :focus-visible ring authored in styles/index.css
                 * (an inline declaration always wins), leaving this Tab stop
                 * with no visible focus indicator. */
                style={{
                  flex: 1,
                  marginLeft: 12,
                  background: 'transparent',
                  border: 'none',
                  color: '#ffffff',
                  fontSize: 14,
                  fontFamily,
                }}
              />
            </div>
            {/* Results */}
            <div style={{ maxHeight: 400, overflowY: 'auto', padding: searchQuery ? '8px 0' : '0' }}>
              {/* Empty state: 0.6 alpha composites to rgb(161,161,161) on the
                  #141414 panel = 7.13:1; 0.4 was 3.83:1 (WCAG 1.4.3 AA needs 4.5:1). */}
              {searchQuery && searchResults.length === 0 && (
                <div role="status" style={{ padding: '24px 16px', textAlign: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
                  {t('docs.search.noResults')}
                </div>
              )}
              {/* The listbox is rendered only when it has options: that keeps the
                  input's aria-controls from ever naming a missing element and
                  avoids an empty listbox being exposed. The wrapper carries no
                  style, so the rows lay out exactly as before. */}
              {searchResults.length > 0 && (
                <div id={SEARCH_LISTBOX_ID} role="listbox" aria-label={t('docs.search.resultsLabel')}>
                  {searchResults.map((result, idx) => (
                    <button
                      key={result.slug}
                      id={`${SEARCH_OPTION_ID_PREFIX}${idx}`}
                      role="option"
                      aria-selected={idx === searchSelectedIdx}
                      onClick={() => handleSearchSelect(result.slug)}
                      /* As with the input above, the inline `outline: none` this
                       * button used to carry is gone so the authored
                       * :focus-visible ring can reach it. */
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '10px 16px',
                        background: idx === searchSelectedIdx ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={() => setSearchSelectedIdx(idx)}
                    >
                      <div style={{ color: '#ffffff', fontSize: 14, fontWeight: 500, fontFamily, marginBottom: 4 }}>
                        {result.title}
                      </div>
                      {/* Snippet must clear 4.5:1 on BOTH row backgrounds: 0.6 alpha
                          gives 7.13:1 on the #141414 panel and 6.36:1 on the
                          selected row's composited rgb(39,39,39); 0.4 gave 3.83/3.65:1. */}
                      <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontFamily, lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {result.snippet}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Footer hints */}
            {searchResults.length > 0 && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 16px',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                fontSize: 12,
                // Same defect as the snippet above: 0.35 alpha was 3.22:1 on the
                // #141414 panel; 0.6 is 7.13:1. The <kbd> chips keep their own
                // high-contrast colours (black on 0.85 white).
                color: 'rgba(255,255,255,0.6)',
                fontFamily,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <kbd style={{ background: 'rgba(255,255,255,0.85)', borderRadius: 3, padding: '0px 3px', fontSize: 9, color: '#000000' }}>↑</kbd>
                    <kbd style={{ background: 'rgba(255,255,255,0.85)', borderRadius: 3, padding: '0px 3px', fontSize: 9, color: '#000000' }}>↓</kbd>
                    {t('docs.search.hint.select')}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <kbd style={{ background: 'rgba(255,255,255,0.85)', borderRadius: 3, padding: '0px 3px', fontSize: 9, color: '#000000' }}>↵</kbd>
                    {t('docs.search.hint.open')}
                  </span>
                </div>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <kbd style={{ background: 'rgba(255,255,255,0.85)', borderRadius: 3, padding: '0px 3px', fontSize: 9, color: '#000000' }}>esc</kbd>
                  {t('docs.search.hint.close')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DocsPage;
