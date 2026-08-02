'use client';

import { LANGUAGE_CODES } from '@agric-platform/shared';
import type { LanguageCode } from '@agric-platform/shared';
import { useT } from '@/lib/i18n';

/** Endonyms — always shown in their own language, never translated. */
const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English',
  ha: 'Hausa',
  yo: 'Yoruba',
  ig: 'Igbo'
};

/**
 * Language picker for nav + footer. The label lists "language" in all four
 * supported languages so a speaker of any of them can find the control.
 * ha/yo/ig dictionaries are empty scaffolds today — switching proves the
 * plumbing (locale persists, <html lang> updates, en fallback resolves).
 */
export function LocaleSwitcher({ id }: { id: string }) {
  const { locale, setLocale, hydrated } = useT();
  return (
    <span className="locale-switcher">
      <label className="small" htmlFor={id}>
        Language / Harshe / Èdè / Asụsụ
      </label>
      <select
        id={id}
        value={locale}
        disabled={!hydrated}
        onChange={(event) => setLocale(event.target.value as LanguageCode)}
      >
        {LANGUAGE_CODES.map((code) => (
          <option key={code} value={code}>
            {LANGUAGE_NAMES[code]}
          </option>
        ))}
      </select>
    </span>
  );
}
