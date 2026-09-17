// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { Language, TranslationKeys } from './types';
import { en } from './en';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { ru } from './ru';

const translations: Record<Language, TranslationKeys> = { en, zh, ja, ko, ru };

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
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

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }, []);

  const t = useCallback((key: string): string => {
    return translations[language][key as keyof TranslationKeys] ?? key;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export function useTranslation() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  return ctx;
}
