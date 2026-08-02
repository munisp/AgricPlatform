'use client';

import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * IndexedDB form-draft persistence (Appendix F Phase-1): autosave-on-
 * keystroke + restore-on-reload for long forms so a dropped connection or
 * closed browser never loses typed work. Drafts are device-local only and
 * cleared by the form on successful submit.
 *
 * Dexie is used directly (no dexie-react-hooks dependency); when IndexedDB
 * is unavailable (very old browsers, privacy modes) the hook degrades to
 * localStorage so the guarantee still holds.
 */

export interface DraftRecord<T = unknown> {
  /** Form-scoped key, e.g. 'registration', 'listing-create'. */
  id: string;
  data: T;
  updatedAt: number;
}

class DraftsDatabase extends Dexie {
  drafts!: EntityTable<DraftRecord, 'id'>;

  constructor() {
    super('agric-drafts');
    this.version(1).stores({ drafts: 'id' });
  }
}

let db: DraftsDatabase | null = null;

/** True when IndexedDB looks usable in this environment. */
function indexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

export function getDraftsDb(): DraftsDatabase | null {
  if (!indexedDbAvailable()) return null;
  if (!db) db = new DraftsDatabase();
  return db;
}

const LS_PREFIX = 'agric.draft.';

async function readDraft<T>(id: string): Promise<DraftRecord<T> | undefined> {
  const database = getDraftsDb();
  if (database) {
    return (await database.drafts.get(id)) as DraftRecord<T> | undefined;
  }
  try {
    const raw = window.localStorage.getItem(`${LS_PREFIX}${id}`);
    return raw ? (JSON.parse(raw) as DraftRecord<T>) : undefined;
  } catch {
    return undefined;
  }
}

async function writeDraft<T>(id: string, data: T): Promise<void> {
  const record: DraftRecord<T> = { id, data, updatedAt: Date.now() };
  const database = getDraftsDb();
  if (database) {
    await database.drafts.put(record as DraftRecord);
    return;
  }
  try {
    window.localStorage.setItem(`${LS_PREFIX}${id}`, JSON.stringify(record));
  } catch {
    // Storage full/unavailable — the draft is lost but the form still works.
  }
}

async function deleteDraft(id: string): Promise<void> {
  const database = getDraftsDb();
  if (database) {
    await database.drafts.delete(id);
    return;
  }
  try {
    window.localStorage.removeItem(`${LS_PREFIX}${id}`);
  } catch {
    // ignore
  }
}

export interface UseFormDraftResult<T> {
  draft: T;
  setDraft: Dispatch<SetStateAction<T>>;
  /** True once the stored draft (if any) has been loaded. */
  hydrated: boolean;
  /** True when a non-empty stored draft was restored on mount. */
  restored: boolean;
  /** Remove the stored draft (call after a successful submit). */
  clearDraft: () => void;
}

const SAVE_DEBOUNCE_MS = 300;

/**
 * Draft-state hook: restores any stored draft on mount, autosaves every
 * change (debounced), and exposes `clearDraft` for post-submit cleanup.
 * `isEmpty` decides whether the initial value counts as "no draft" — the
 * restored indicator only shows for drafts with real content.
 */
export function useFormDraft<T>(
  id: string,
  initial: T,
  isEmpty?: (value: T) => boolean
): UseFormDraftResult<T> {
  const [draft, setDraft] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After clearDraft(), skip persisting while the draft is still the exact
  // initial object; typing again produces a new object and resumes autosave.
  const skipSaveForRef = useRef<T | null>(null);
  const initialRef = useRef(initial);
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  // Restore on mount.
  useEffect(() => {
    let cancelled = false;
    void readDraft<T>(id)
      .then((record) => {
        if (cancelled || !record) return;
        const empty = isEmptyRef.current;
        if (empty && empty(record.data)) return;
        setDraft(record.data);
        setRestored(true);
      })
      .catch(() => {
        // A corrupt store must never break the form.
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Autosave on change (after the restore pass so we never clobber the
  // stored draft with the initial value).
  useEffect(() => {
    if (!hydrated) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (skipSaveForRef.current === draft) return;
      void writeDraft(id, draft).catch(() => {
        // Persistence failure degrades to an in-memory draft.
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft, hydrated, id]);

  const clearDraft = useCallback(() => {
    skipSaveForRef.current = initialRef.current;
    setDraft(initialRef.current);
    setRestored(false);
    void deleteDraft(id).catch(() => {
      // ignore — worst case a stale draft is restored next visit
    });
  }, [id]);

  return { draft, setDraft, hydrated, restored, clearDraft };
}
