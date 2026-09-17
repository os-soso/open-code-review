// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Language, TranslationKeys } from './types';
import { en } from './en';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';

const translations: Record<Language, TranslationKeys> = { en, zh, ja, ko, ru };

/**
 * Listener run immediately before the UI language changes, with the language
 * about to be applied and the one still on screen.
 */
export type BeforeLanguageChangeListener = (next: Language, previous: Language) => void;

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  /**
   * Registers `listener` to run synchronously immediately BEFORE a language
   * change is applied, and returns the function that unregisters it.
   *
   * A surface whose layout is translated needs a measurement of the page as the
   * reader currently sees it in order to reconcile itself afterwards — the
   * documentation page records which section the reader is in, because the
   * translated article is a different length and a carried-over scroll offset
   * would land them somewhere else. That measurement cannot be taken after the
   * fact: by the time a re-render is committed the old layout is gone. It
   * cannot be taken at the control either, because the language controls live
   * in the navbar and the footer while the content that moves lives on the
   * page, so the change is announced here instead.
   *
   * Listeners are notified only when the language actually changes; re-selecting
   * the current one moves nothing on screen and so reconciles nothing.
   */
  onBeforeLanguageChange: (listener: BeforeLanguageChangeListener) => () => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = 'ocr-lang';

const SUPPORTED_LANGUAGES: Language[] = ['en', 'zh', 'ja', 'ko', 'ru'];

// Resolves a language tag to one of SUPPORTED_LANGUAGES, or null when the tag
// names a language the site does not translate. Only the primary subtag is
// matched, case-insensitively: tags arrive carrying region and script subtags
// ('zh-CN', 'zh-Hans-CN') from navigator.languages and, for a stored
// preference, from whatever a legacy build or a hand edit left behind. Both
// resolution paths below go through here, so the same tag can never resolve to
// Chinese from the browser and to the 'en' fallback from storage.
function normalizeLanguageTag(tag: string): Language | null {
  const code = tag.toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.includes(code as Language) ? (code as Language) : null;
}

function detectBrowserLanguage(): Language | null {
  try {
    for (const lang of navigator.languages ?? [navigator.language]) {
      const code = normalizeLanguageTag(lang);
      if (code) return code;
    }
  } catch {}
  return null;
}

function getInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const code = normalizeLanguageTag(stored);
      if (code) return code;
    }
  } catch {}
  return detectBrowserLanguage() ?? 'en';
}

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);
  /* The language on screen, readable from setLanguage without making that
   * callback depend on — and be re-created by — the state it sets. Every
   * consumer holding the callback keeps one identity for the app's lifetime. */
  const languageRef = useRef<Language>(language);
  /* A Set, so registering twice cannot notify twice and unregistering is exact.
   * Held in a ref because a subscription is not rendered. */
  const beforeChangeListeners = useRef<Set<BeforeLanguageChangeListener>>(new Set());

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const onBeforeLanguageChange = useCallback((listener: BeforeLanguageChangeListener) => {
    const listeners = beforeChangeListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    const previous = languageRef.current;
    if (lang !== previous) {
      /* Iterated over a copy: a listener is free to unsubscribe itself (or
       * another) while reacting, which would otherwise mutate the live Set. */
      for (const listener of Array.from(beforeChangeListeners.current)) {
        try {
          listener(lang, previous);
        } catch (error) {
          /* A listener only prepares for the change. One that throws must not
           * keep the language from changing, nor swallow its siblings' turn, so
           * it is contained here — and reported unconditionally, as
           * ErrorBoundary reports what it catches: a listener that stops
           * working takes a correction with it (the documentation page would
           * quietly go back to dropping the reader into another section), and a
           * failure nobody can see in production is a failure nobody fixes. */
          console.error('[i18n] onBeforeLanguageChange listener failed', error);
        }
      }
    }
    languageRef.current = lang;
    setLanguageState(lang);
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }, []);

  const t = useCallback((key: string): string => {
    return translations[language][key as keyof TranslationKeys] ?? key;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, onBeforeLanguageChange, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export function useTranslation() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  return ctx;
}
