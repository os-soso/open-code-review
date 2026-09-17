// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider, useTranslation } from './context';

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
