// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import App, { ScrollManager, resolveDocumentTitle } from './App';
import FeaturesSection from './components/FeaturesSection';
import { LanguageProvider } from './i18n';

/* The docs content index imports every locale's markdown, which the webpack
 * build inlines as raw source and vite cannot parse at all. Standing in for it
 * keeps these tests about routing, titles and scrolling — the slug table under
 * test lives in DocsPage, not in the content. */
vi.mock('./content/docs', () => {
  const titles: Record<string, string> = {
    quickstart: 'QuickStart',
    tools: 'Tools',
    mcp: 'MCP Server',
  };
  return {
    getDocContent: (slug: string) => `Body of the ${slug} document.\n\n## Section\n\nParagraph.\n`,
    getDocTitle: (slug: string) => titles[slug] ?? slug,
    searchDocs: () => [],
  };
});

function installLocalStorageMock() {
  let store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    } as Storage,
  });
}

/* jsdom implements neither IntersectionObserver (the docs heading tracker and
 * the landing page's fade-in sections need it) nor real scrolling. The observer
 * reports its target as visible at once so faded-in sections render, and the
 * scroll spy records every call and moves window.scrollY the way a browser
 * would, which is what the restore logic reads back. */
function installIntersectionObserverStub(): void {
  class ImmediateIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: ReadonlyArray<number> = [];

    constructor(private readonly callback: IntersectionObserverCallback) {}

    observe(target: Element): void {
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }

    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  window.IntersectionObserver = ImmediateIntersectionObserver as unknown as typeof IntersectionObserver;
}

function installScrollSpy(): [number, number][] {
  const calls: [number, number][] = [];
  setScrollY(0);
  window.scrollTo = ((x: number | ScrollToOptions, y?: number) => {
    if (typeof x === 'number' && typeof y === 'number') {
      calls.push([x, y]);
      setScrollY(y);
      /* A browser fires a scroll event for a programmatic scroll too. Without
       * it the spy would hide the very bug this file guards against: a reset
       * aimed at the page being navigated away from is only destructive
       * because the resulting event is recorded as that entry's offset. */
      window.dispatchEvent(new Event('scroll'));
    }
  }) as typeof window.scrollTo;
  return calls;
}

function setScrollY(offset: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: offset });
}

/* Scrolling as a reader does it: the offset moves and the window reports it. */
function scrollReaderTo(offset: number): void {
  setScrollY(offset);
  window.dispatchEvent(new Event('scroll'));
}

/* Reports the live location and drives history from inside the router, so a
 * test can assert the URL a redirect landed on and traverse back the way the
 * browser's own Back button does. */
const HistoryProbe: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div>
      <span data-testid="pathname">{location.pathname}</span>
      <button type="button" onClick={() => navigate('/docs/tools')}>
        open tools
      </button>
      <button type="button" onClick={() => navigate('/docs/mcp')}>
        open mcp
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        go back
      </button>
    </div>
  );
};

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LanguageProvider>
        <App />
        <HistoryProbe />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

describe('App', () => {
  let scrollCalls: [number, number][];

  beforeEach(() => {
    installLocalStorageMock();
    window.localStorage.clear();
    installIntersectionObserverStub();
    scrollCalls = installScrollSpy();
    document.title = 'Open Code Review';
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders the not-found page for an unmatched URL', () => {
    renderApp('/ewe.html');

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to Home' })).toBeTruthy();
    expect(document.title).toBe('Page not found — Open Code Review');
  });

  it('renders the not-found page for an unknown docs slug instead of QuickStart', async () => {
    renderApp('/docs/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'QuickStart' })).toBeNull();
    expect(screen.getByTestId('pathname').textContent).toBe('/docs/does-not-exist');
    expect(document.title).toBe('Page not found — Open Code Review');
  });

  it('redirects a wrong-case docs slug to its canonical URL', async () => {
    renderApp('/docs/TOOLS');

    expect(await screen.findByRole('heading', { name: 'Tools', level: 1 })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/docs/tools'));
    expect(document.title).toBe('Tools — Open Code Review');
  });

  it('opens QuickStart for the bare /docs route', async () => {
    renderApp('/docs');

    expect(await screen.findByRole('heading', { name: 'QuickStart', level: 1 })).toBeTruthy();
    expect(document.title).toBe('QuickStart — Open Code Review');
  });

  it('titles a docs route after the document on screen', async () => {
    renderApp('/docs/tools');

    expect(await screen.findByRole('heading', { name: 'Tools', level: 1 })).toBeTruthy();
    expect(document.title).toBe('Tools — Open Code Review');
  });

  it('gives /features a single h1 and its own title', () => {
    renderApp('/features');

    const topHeadings = screen.getAllByRole('heading', { level: 1 });
    expect(topHeadings).toHaveLength(1);
    expect(topHeadings[0].textContent).toBe('An Agent System Purpose-Built for Code Review');
    expect(document.title).toBe('Features — Open Code Review');
  });

  it('keeps the shared features section at h2 where a page already has an h1', () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <FeaturesSection />
        </LanguageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'An Agent System Purpose-Built for Code Review',
    );
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('resolves a title for every route and leaves the docs routes to DocsPage', () => {
    const t = (key: string) =>
      ({
        'navbar.features': 'Features',
        'navbar.benchmark': 'Benchmark',
        'navbar.quickstart': 'Quick Start',
        'navbar.blog': 'Blog',
        'notFound.title': 'Page not found',
      })[key] ?? key;

    expect(resolveDocumentTitle('/', t)).toBe('Open Code Review');
    expect(resolveDocumentTitle('/features', t)).toBe('Features — Open Code Review');
    expect(resolveDocumentTitle('/features/', t)).toBe('Features — Open Code Review');
    expect(resolveDocumentTitle('/benchmark', t)).toBe('Benchmark — Open Code Review');
    expect(resolveDocumentTitle('/quickstart', t)).toBe('Quick Start — Open Code Review');
    expect(resolveDocumentTitle('/blog', t)).toBe('Blog — Open Code Review');
    expect(resolveDocumentTitle('/blog/first-post', t)).toBe('Blog — Open Code Review');
    expect(resolveDocumentTitle('/nothing-here', t)).toBe('Page not found — Open Code Review');
    expect(resolveDocumentTitle('/docs', t)).toBeNull();
    expect(resolveDocumentTitle('/docs/tools', t)).toBeNull();
  });

  /* Driven directly rather than through a click, because the defect these
   * assertions guard needed a re-render that keeps the entry on screen: the
   * reset used to be re-evaluated whenever the router reported a new
   * navigation, which happens one transition before the new entry is rendered,
   * so it fired against the outgoing page and recorded that page's offset as
   * 0. A navigation driven through the router commits both at once and hides
   * it. */
  it('never scrolls a re-render of the entry already on screen', () => {
    const { rerender } = render(<ScrollManager locationKey="entry-stable" hash="" />);
    expect(scrollCalls).toEqual([[0, 0]]);

    scrollReaderTo(4321);
    rerender(<ScrollManager locationKey="entry-stable" hash="" />);

    expect(scrollCalls).toEqual([[0, 0]]);
    expect(window.scrollY).toBe(4321);
  });

  it('restores an entry it has displayed before and tops one it has not', () => {
    const { rerender } = render(<ScrollManager locationKey="entry-read" hash="" />);
    scrollReaderTo(6120);

    rerender(<ScrollManager locationKey="entry-next" hash="" />);
    expect(scrollCalls.at(-1)).toEqual([0, 0]);
    expect(window.scrollY).toBe(0);

    rerender(<ScrollManager locationKey="entry-read" hash="" />);
    expect(scrollCalls.at(-1)).toEqual([0, 6120]);
    expect(window.scrollY).toBe(6120);
  });

  it('forgets the oldest entries instead of growing for the life of the tab', () => {
    const { rerender } = render(<ScrollManager locationKey="entry-oldest" hash="" />);
    scrollReaderTo(2500);

    /* One more entry than the tracker keeps, so the first one is evicted while
     * the most recent stays. Each entry is scrolled so it has an offset worth
     * restoring. */
    for (let i = 0; i < 50; i += 1) {
      rerender(<ScrollManager locationKey={`entry-filler-${i}`} hash="" />);
      scrollReaderTo(100 + i);
    }

    /* Leaving for a fresh entry and coming back: the recent entry still has its
     * offset, the one pushed out of the tracker starts at the top. */
    rerender(<ScrollManager locationKey="entry-elsewhere" hash="" />);
    rerender(<ScrollManager locationKey="entry-filler-49" hash="" />);
    expect(scrollCalls.at(-1)).toEqual([0, 149]);

    rerender(<ScrollManager locationKey="entry-oldest" hash="" />);
    expect(scrollCalls.at(-1)).toEqual([0, 0]);
    expect(window.scrollY).toBe(0);
  });

  it('leaves a location carrying a fragment to the page that owns it', () => {
    const { rerender } = render(<ScrollManager locationKey="entry-doc" hash="#limits-3" />);
    expect(scrollCalls).toEqual([]);

    scrollReaderTo(7244);
    rerender(<ScrollManager locationKey="entry-other-doc" hash="#limits" />);

    expect(scrollCalls).toEqual([]);
    expect(window.scrollY).toBe(7244);
  });

  it('restores the reading position on Back and starts a new page at the top', async () => {
    /* Starts on QuickStart so the offset under test belongs to a pushed entry:
     * the very first entry is shared by every test in this file. */
    renderApp('/docs/quickstart');
    expect(await screen.findByRole('heading', { name: 'QuickStart', level: 1 })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'open tools' }));
    expect(await screen.findByRole('heading', { name: 'Tools', level: 1 })).toBeTruthy();
    await waitFor(() => expect(scrollCalls.at(-1)).toEqual([0, 0]));

    scrollReaderTo(8143);

    fireEvent.click(screen.getByRole('button', { name: 'open mcp' }));
    expect(await screen.findByRole('heading', { name: 'MCP Server', level: 1 })).toBeTruthy();
    await waitFor(() => expect(scrollCalls.at(-1)).toEqual([0, 0]));
    expect(window.scrollY).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'go back' }));
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/docs/tools'));
    await waitFor(() => expect(scrollCalls.at(-1)).toEqual([0, 8143]));
    expect(window.scrollY).toBe(8143);
    expect(screen.getByRole('heading', { name: 'Tools', level: 1 })).toBeTruthy();
  });
});
