// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { Suspense, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import LandingPage from './components/LandingPage';
import ErrorBoundary from './components/ErrorBoundary';
import { useTransitionedLocation } from './hooks/useTransitionedLocation';
import { useTranslation } from './i18n';
import FeaturesPage from './pages/FeaturesPage';
import FeaturesRoutePage from './pages/FeaturesRoutePage';
import NotFoundPage from './pages/NotFoundPage';

const BenchmarkPage = React.lazy(() => import(/* webpackChunkName: "benchmark-page" */ './pages/BenchmarkPage'));
const QuickStartPage = React.lazy(() => import(/* webpackChunkName: "quickstart-page" */ './pages/QuickStartPage'));
const DocsPage = React.lazy(() => import(/* webpackChunkName: "docs-page" */ './pages/DocsPage'));
const BlogPage = React.lazy(() => import(/* webpackChunkName: "blog-page" */ './pages/BlogPage'));

/* Product name every route's document title ends with. DocsPage keeps its own
 * copy of this string: titling a document needs its frontmatter title, and
 * importing the docs content index here would pull every locale's markdown
 * into the main bundle. */
const SITE_TITLE = 'Open Code Review';

/* Translation key naming each route, used as the leading segment of its title.
 * `/` is absent on purpose — a site root is titled with the product name alone
 * — and so are the docs routes, which DocsPage titles from the document on
 * screen. */
const routeTitleKeys: Record<string, string> = {
  '/features': 'navbar.features',
  '/benchmark': 'navbar.benchmark',
  '/quickstart': 'navbar.quickstart',
  '/blog': 'navbar.blog',
};

/**
 * Resolves the document title for a pathname, or null when the route rendered
 * there titles itself (the docs routes).
 *
 * A pathname matching no route renders NotFoundPage, so it is titled as not
 * found rather than left showing the title of the page the reader came from.
 */
export function resolveDocumentTitle(pathname: string, t: (key: string) => string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/docs' || path.startsWith('/docs/')) return null;
  if (path === '/') return SITE_TITLE;
  const titleKey = routeTitleKeys[path] ?? (path.startsWith('/blog/') ? 'navbar.blog' : 'notFound.title');
  return `${t(titleKey)} — ${SITE_TITLE}`;
}

/* Keeps the browser tab, the bookmark and the shared link naming the page the
 * reader is on: without this every route reported the static title compiled
 * into index.html. */
const DocumentTitle: React.FC<{ pathname: string }> = ({ pathname }) => {
  const { t } = useTranslation();

  useEffect(() => {
    const title = resolveDocumentTitle(pathname, t);
    if (title !== null) {
      document.title = title;
    }
  }, [pathname, t]);

  return null;
};

/* Scroll offsets of the history entries visited in this session, keyed by the
 * router's per-entry key. `history.scrollRestoration` is 'manual' (see
 * index.tsx), so nothing else remembers them: without this map, Back out of a
 * long document threw the reader to the top of the page instead of returning
 * them to where they had read to. Session-scoped by design — after a reload the
 * browser holds no offsets either, and a traversal then starts at the top. */
const scrollOffsets = new Map<string, number>();

/* How many entries the two collections below keep. A browser session holds
 * around fifty history entries, and an offset for an entry no longer in the
 * session can never be restored, so the oldest are dropped rather than kept
 * for the life of the tab. */
const maxTrackedEntries = 50;

/* Records an entry's offset, keeping the collection bounded and ordered oldest
 * first: re-inserting the key moves it to the end, so the entry evicted when
 * the cap is passed is the one longest untouched. */
function rememberOffset(key: string, offset: number): void {
  scrollOffsets.delete(key);
  scrollOffsets.set(key, offset);
  if (scrollOffsets.size > maxTrackedEntries) {
    const oldest = scrollOffsets.keys().next().value;
    if (oldest !== undefined) {
      scrollOffsets.delete(oldest);
    }
  }
}

/* History entries this session has already put on screen. A pushed entry is
 * new to this set, while Back and Forward return to one of its members, which
 * is how a traversal is told from a fresh entry here.
 *
 * The router's own navigation type cannot be used for it: `useNavigationType`
 * reports the new navigation as soon as the URL changes, while the location
 * being rendered deliberately trails it by one React transition (see
 * useTransitionedLocation). Deciding on the two together therefore sees a push
 * against the entry still on screen — resetting, and then recording, the
 * offset of the page the reader is leaving, which is what lost the reading
 * position. Deciding on the displayed entry alone cannot drift that way.
 *
 * Bounded like the offsets, and by the same argument: an entry whose offset has
 * been dropped would be restored to the top anyway. */
const visitedKeys = new Set<string>();

/* Marks an entry as displayed and reports whether it already was. */
function markVisited(key: string): boolean {
  const seen = visitedKeys.has(key);
  visitedKeys.delete(key);
  visitedKeys.add(key);
  if (visitedKeys.size > maxTrackedEntries) {
    const oldest = visitedKeys.values().next().value;
    if (oldest !== undefined) {
      visitedKeys.delete(oldest);
    }
  }
  return seen;
}

/* How long a restore keeps retrying while the route it is restoring grows. A
 * document's markdown, and a diagram rendered from it, paint after the route
 * commits — and a scroll past the current document height is clamped — so a
 * single call can land short of a deep offset. Generous enough to cover a
 * diagram or a slow paint, short enough that a page which will never be that
 * tall stops being scrolled almost immediately. */
const scrollRestoreTimeoutMs = 1500;

/**
 * Scrolls the window to `top`, retrying across frames until it lands there or
 * the restore window closes.
 *
 * Stops as soon as something else moves the window — the reader scrolling, or a
 * fragment scroll — so a restore never fights the person reading. The returned
 * canceller drops a chain that a newer navigation has superseded.
 */
function scrollToOffset(top: number): () => void {
  const deadline = Date.now() + scrollRestoreTimeoutMs;
  let frame = 0;
  let cancelled = false;
  let lastApplied = -1;
  const attempt = () => {
    if (cancelled) return;
    if (lastApplied >= 0 && window.scrollY !== lastApplied) return;
    window.scrollTo(0, top);
    lastApplied = window.scrollY;
    if (Math.abs(window.scrollY - top) > 1 && Date.now() < deadline) {
      frame = requestAnimationFrame(attempt);
    }
  };
  attempt();
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

/* Rendered by App for the location on screen; the tests drive it directly with
 * synthetic entry keys, which is the only way to exercise a re-render that
 * keeps the same entry. */
export const ScrollManager: React.FC<{ locationKey: string; hash: string }> = ({ locationKey, hash }) => {
  /* Remember where the entry on screen is scrolled to, so a later Back or
   * Forward can return the reader there. Recording from the scroll event, not
   * from the route change, keeps the offset the reader actually left: by the
   * time the next route commits, the incoming layout may already have clamped
   * the window to a shorter document. */
  useEffect(() => {
    const record = () => {
      rememberOffset(locationKey, window.scrollY);
    };
    window.addEventListener('scroll', record, { passive: true });
    return () => window.removeEventListener('scroll', record);
  }, [locationKey]);

  useEffect(() => {
    const isTraversal = markVisited(locationKey);

    /* A fragment owns its own scrolling: DocsPage waits for the target heading
     * to render and scrolls to it, for a deep link and for Back or Forward
     * across two fragments alike. Moving the offset here would fight it. */
    if (hash) return;

    const savedOffset = isTraversal ? scrollOffsets.get(locationKey) : undefined;
    if (savedOffset !== undefined) {
      return scrollToOffset(savedOffset);
    }
    /* A new entry — and a traversal to one this session recorded no offset for
     * — starts at the top of the page. */
    window.scrollTo(0, 0);
  }, [locationKey, hash]);

  return null;
};

const RouteErrorFallback: React.FC<{ reset: () => void }> = ({ reset }) => {
  const { t } = useTranslation();

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          padding: 24,
          background: '#141414',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 12,
          color: '#ffffff',
          textAlign: 'center',
        }}
      >
        <p style={{ margin: '0 0 16px', fontSize: 16 }}>{t('error.pageLoadFailed')}</p>
        <button
          type="button"
          onClick={reset}
          style={{
            border: 0,
            borderRadius: 6,
            padding: '10px 18px',
            background: '#ffffff',
            color: '#000000',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t('error.reload')}
        </button>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  // Route changes are applied inside a React transition so the previous page
  // stays visible while a lazy route's chunk downloads. The plain black
  // Suspense fallback is then only reachable on first paint, which removes
  // the black flash on in-app navigation without losing the intentional
  // dark background on initial load.
  const displayLocation = useTransitionedLocation();

  return (
    <>
      <DocumentTitle pathname={displayLocation.pathname} />
      <ScrollManager locationKey={displayLocation.key} hash={displayLocation.hash} />
      <ErrorBoundary reloadOnChunkError fallback={(_error, reset) => <RouteErrorFallback reset={reset} />}>
        <Suspense fallback={<div style={{ minHeight: '100vh', background: '#000000' }} />}>
          {/* A new top-level route needs an entry in routeTitleKeys above, or
              resolveDocumentTitle falls through and titles it as not found. */}
          <Routes location={displayLocation}>
            <Route path="/" element={<LandingPage><FeaturesPage /></LandingPage>} />
            <Route path="/features" element={<LandingPage><FeaturesRoutePage /></LandingPage>} />
            <Route path="/benchmark" element={<LandingPage><BenchmarkPage /></LandingPage>} />
            <Route path="/quickstart" element={<LandingPage><QuickStartPage /></LandingPage>} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/docs/:slug" element={<DocsPage />} />
            <Route path="/blog" element={<BlogPage />} />
            <Route path="/blog/:slug" element={<BlogPage />} />
            <Route path="*" element={<LandingPage><NotFoundPage /></LandingPage>} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </>
  );
};

export default App;
