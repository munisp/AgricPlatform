'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LanguageCode } from '@agric-platform/shared';
import { en } from './dictionaries/en';
import { ha } from './dictionaries/ha';
import { yo } from './dictionaries/yo';
import { ig } from './dictionaries/ig';
import type { Dictionary } from './dictionaries/en';
import type { DeepPartial, DotKeys } from './types';

export type { DeepPartial } from './types';

export type TranslationKey = DotKeys<Dictionary>;

/**
 * Locale persistence lives in its own key (`agric.locale`) — the session
 * provider owns user identity; locale is device-level UI state.
 */
const LOCALE_KEY = 'agric.locale';

const dictionaries: Record<LanguageCode, DeepPartial<Dictionary>> = { en, ha, yo, ig };

/** BCP-47 tag for <html lang> — 'en' keeps the SSR'd 'en-NG'. */
const HTML_LANG: Record<LanguageCode, string> = {
  en: 'en-NG',
  ha: 'ha',
  yo: 'yo',
  ig: 'ig'
};

function lookup(source: unknown, path: string[]): string | undefined {
  let node = source;
  for (const part of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function resolve(locale: LanguageCode, key: TranslationKey): string {
  const path = key.split('.');
  return lookup(dictionaries[locale], path) ?? lookup(en, path) ?? key;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

function readStoredLocale(): LanguageCode {
  try {
    const raw = window.localStorage.getItem(LOCALE_KEY);
    if (raw === 'en' || raw === 'ha' || raw === 'yo' || raw === 'ig') return raw;
  } catch {
    // Storage unavailable — default locale.
  }
  return 'en';
}

interface I18nValue {
  locale: LanguageCode;
  setLocale: (locale: LanguageCode) => void;
  /** True after the stored locale has been read from localStorage. */
  hydrated: boolean;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LanguageCode>('en');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage after first render (same pattern as
  // lib/app-state.tsx — avoids SSR/client markup mismatch).
  useEffect(() => {
    setLocaleState(readStoredLocale());
    setHydrated(true);
  }, []);

  // Keep <html lang> in sync with the active locale.
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[locale];
  }, [locale]);

  const setLocale = useCallback((next: LanguageCode) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_KEY, next);
    } catch {
      // Storage full or unavailable — the switch still applies in memory.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      interpolate(resolve(locale, key), vars),
    [locale]
  );

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, hydrated, t }),
    [locale, setLocale, hydrated, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useT must be used within <I18nProvider>');
  }
  return ctx;
}

/**
 * Client island for translated strings inside SERVER components (pages),
 * where hooks cannot be called: <PageHeader title={<T k="dashboard.title" />} />.
 */
export function T({ k, vars }: { k: TranslationKey; vars?: Record<string, string | number> }) {
  return <>{useT().t(k, vars)}</>;
}
