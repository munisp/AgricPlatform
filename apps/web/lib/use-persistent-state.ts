'use client';

import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * localStorage-backed state hook. Gives offline-friendly persistence for
 * forms, drafts and preferences in this reference build (IndexedDB-like
 * durability without a dependency).
 */
export function usePersistentState<T>(
  key: string,
  initial: T
): readonly [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) {
        setValue(JSON.parse(raw) as T);
      }
    } catch {
      // ignore corrupt payloads
    }
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(keyRef.current, JSON.stringify(value));
    } catch {
      // storage unavailable — degrade silently
    }
  }, [value, hydrated]);

  return [value, setValue, hydrated] as const;
}
