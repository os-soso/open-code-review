// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { LanguageProvider, useTranslation } from './context';
import type { BeforeLanguageChangeListener } from './context';
import type { Language } from './types';

// The provider resolves the UI locale once, while mounting, from the `ocr-lang`
// localStorage key — so each case seeds storage and then mounts a fresh
// provider, which is what a full page load does in the browser.
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

const LanguageProbe: React.FC = () => {
  const { language, setLanguage } = useTranslation();
  return (
    <div>
      <span data-testid="language">{language}</span>
      <button type="button" onClick={() => setLanguage('ko')}>
        switch to ko
      </button>
    </div>
  );
};

// Returns the locale the provider resolved for the given stored value; pass
// null to leave storage empty and exercise the browser-detection fallback.
function mountWithStoredLanguage(stored: string | null): string {
  if (stored !== null) {
    window.localStorage.setItem('ocr-lang', stored);
  }
  render(
    <LanguageProvider>
      <LanguageProbe />
    </LanguageProvider>,
  );
  return screen.getByTestId('language').textContent ?? '';
}

describe('LanguageProvider initial language', () => {
  beforeEach(() => {
    installLocalStorageMock();
    window.localStorage.clear();
    document.documentElement.lang = '';
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('resolves a stored tag carrying a region subtag to its language', () => {
    expect(mountWithStoredLanguage('zh-CN')).toBe('zh');
    expect(document.documentElement.lang).toBe('zh');
  });

  it('resolves a stored tag carrying script and region subtags to its language', () => {
    expect(mountWithStoredLanguage('zh-Hans-CN')).toBe('zh');
  });

  it('resolves a stored tag whatever its case', () => {
    expect(mountWithStoredLanguage('ZH')).toBe('zh');
  });

  it('keeps a stored value that is already a supported language code', () => {
    expect(mountWithStoredLanguage('ru')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('falls back to English for a language the site does not translate', () => {
    expect(mountWithStoredLanguage('zz-ZZ')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('falls back to English for an empty stored value', () => {
    expect(mountWithStoredLanguage('')).toBe('en');
  });

  it('falls back to English for a stored value that is not a language tag', () => {
    // A hostile or corrupt value must resolve like any other unsupported tag,
    // and must reach the lang attribute only as the resolved fallback.
    expect(mountWithStoredLanguage('<script>alert(1)</script>')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('detects the browser language by primary subtag when nothing is stored', () => {
    // jsdom reports navigator.languages as ['en-US', 'en'], so this also pins
    // that detection keeps matching on the primary subtag.
    expect(mountWithStoredLanguage(null)).toBe('en');
  });

  it('persists a switched language and resolves it on the next mount', () => {
    expect(mountWithStoredLanguage(null)).toBe('en');

    fireEvent.click(screen.getByRole('button', { name: 'switch to ko' }));
    expect(screen.getByTestId('language').textContent).toBe('ko');
    expect(window.localStorage.getItem('ocr-lang')).toBe('ko');

    cleanup();
    render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('language').textContent).toBe('ko');
  });
});

// What a before-change listener is for: the documentation page measures which
// section the reader is in immediately before the article is swapped for its
// translation, because the translated article is a different length and a
// carried-over scroll offset drops the reader into a different section. That
// measurement is only possible while the old layout is still on screen, so
// these cases pin what a listener can observe — the language about to be
// applied, the one it replaces, and a DOM that has not changed yet — along with
// the guarantees the page depends on: no notification when nothing changes, an
// exact unsubscribe, and one listener's failure kept off the others.
interface RecordedSwap {
  next: string;
  previous: string;
  /** Language the committed DOM still showed while the listener ran. */
  renderedDuringCall: string | null;
}

// Captures the provider's imperative surface, so a case can subscribe,
// unsubscribe and switch in whatever order it needs to exercise.
interface ProviderApi {
  setLanguage: (lang: Language) => void;
  onBeforeLanguageChange: (listener: BeforeLanguageChangeListener) => () => void;
}

describe('LanguageProvider onBeforeLanguageChange', () => {
  let api: ProviderApi | null = null;

  const ApiProbe: React.FC = () => {
    const { language, setLanguage, onBeforeLanguageChange } = useTranslation();
    // Captured from an effect rather than during render: both functions are
    // stable for the provider's lifetime, and a render must stay side-effect
    // free. render() flushes effects, so the surface is ready on return.
    React.useEffect(() => {
      api = { setLanguage, onBeforeLanguageChange };
    }, [setLanguage, onBeforeLanguageChange]);
    return <span data-testid="language">{language}</span>;
  };

  // Mounts the provider in English and returns the surface under test.
  function mountProvider(): ProviderApi {
    window.localStorage.setItem('ocr-lang', 'en');
    render(
      <LanguageProvider>
        <ApiProbe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('language').textContent).toBe('en');
    if (!api) throw new Error('provider did not expose its surface');
    return api;
  }

  // A listener that records what it could see each time it ran.
  function recordingListener(swaps: RecordedSwap[]): BeforeLanguageChangeListener {
    return (next, previous) => {
      swaps.push({
        next,
        previous,
        renderedDuringCall: screen.getByTestId('language').textContent,
      });
    };
  }

  beforeEach(() => {
    installLocalStorageMock();
    window.localStorage.clear();
    api = null;
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('runs a listener before the change, with the old language still rendered', () => {
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    provider.onBeforeLanguageChange(recordingListener(swaps));

    act(() => provider.setLanguage('zh'));

    expect(swaps).toEqual([{ next: 'zh', previous: 'en', renderedDuringCall: 'en' }]);
    // ...and the change itself still lands.
    expect(screen.getByTestId('language').textContent).toBe('zh');
    expect(window.localStorage.getItem('ocr-lang')).toBe('zh');
  });

  it('reports the language it replaces on every subsequent change', () => {
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    provider.onBeforeLanguageChange(recordingListener(swaps));

    act(() => provider.setLanguage('zh'));
    act(() => provider.setLanguage('ja'));
    act(() => provider.setLanguage('en'));

    expect(swaps).toEqual([
      { next: 'zh', previous: 'en', renderedDuringCall: 'en' },
      { next: 'ja', previous: 'zh', renderedDuringCall: 'zh' },
      { next: 'en', previous: 'ja', renderedDuringCall: 'ja' },
    ]);
    expect(screen.getByTestId('language').textContent).toBe('en');
  });

  it('does not run a listener when the selected language is already current', () => {
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    provider.onBeforeLanguageChange(recordingListener(swaps));

    act(() => provider.setLanguage('en'));

    expect(swaps).toEqual([]);
    expect(screen.getByTestId('language').textContent).toBe('en');
  });

  it('stops notifying a listener once it has unsubscribed', () => {
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    const unsubscribe = provider.onBeforeLanguageChange(recordingListener(swaps));

    act(() => provider.setLanguage('zh'));
    unsubscribe();
    act(() => provider.setLanguage('ja'));

    expect(swaps.map(swap => swap.next)).toEqual(['zh']);
    expect(screen.getByTestId('language').textContent).toBe('ja');
  });

  it('notifies a listener once however often it was registered', () => {
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    const listener = recordingListener(swaps);
    provider.onBeforeLanguageChange(listener);
    provider.onBeforeLanguageChange(listener);

    act(() => provider.setLanguage('ko'));

    expect(swaps).toHaveLength(1);
  });

  it('applies the change and notifies the other listeners when one throws', () => {
    // The provider reports the failure in development rather than silently; the
    // spy also keeps the expected noise out of the test output.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    provider.onBeforeLanguageChange(() => {
      throw new Error('measurement failed');
    });
    provider.onBeforeLanguageChange(recordingListener(swaps));

    act(() => provider.setLanguage('ru'));

    expect(swaps).toEqual([{ next: 'ru', previous: 'en', renderedDuringCall: 'en' }]);
    expect(screen.getByTestId('language').textContent).toBe('ru');
    expect(window.localStorage.getItem('ocr-lang')).toBe('ru');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('lets a listener unsubscribe itself while it is running', () => {
    const provider = mountProvider();
    const swaps: RecordedSwap[] = [];
    const record = recordingListener(swaps);
    const unsubscribe = provider.onBeforeLanguageChange((next, previous) => {
      record(next, previous);
      unsubscribe();
    });

    act(() => provider.setLanguage('zh'));
    act(() => provider.setLanguage('ja'));

    expect(swaps.map(swap => swap.next)).toEqual(['zh']);
    expect(screen.getByTestId('language').textContent).toBe('ja');
  });
});
