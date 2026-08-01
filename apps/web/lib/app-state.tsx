'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserRole } from '@agric-platform/shared';

export interface QueuedSubmission {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  status: 'queued';
}

interface AppStateValue {
  hydrated: boolean;
  role: UserRole;
  setRole: (role: UserRole) => void;
  queue: QueuedSubmission[];
  enqueue: (kind: string, label: string) => QueuedSubmission;
  clearQueue: () => void;
}

const ROLE_KEY = 'agric.role';
const QUEUE_KEY = 'agric.queue';

const AppStateContext = createContext<AppStateValue | null>(null);

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — the reference build degrades silently.
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>('farmer');
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const storedRole = readJson<UserRole>(ROLE_KEY);
    if (storedRole) setRoleState(storedRole);
    const storedQueue = readJson<QueuedSubmission[]>(QUEUE_KEY);
    if (Array.isArray(storedQueue)) setQueue(storedQueue);
    setHydrated(true);
  }, []);

  const setRole = useCallback((next: UserRole) => {
    setRoleState(next);
    writeJson(ROLE_KEY, next);
  }, []);

  const enqueue = useCallback((kind: string, label: string) => {
    const submission: QueuedSubmission = {
      id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      label,
      createdAt: new Date().toISOString(),
      status: 'queued'
    };
    setQueue((current) => {
      const next = [...current, submission];
      writeJson(QUEUE_KEY, next);
      return next;
    });
    return submission;
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
    writeJson(QUEUE_KEY, []);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({ hydrated, role, setRole, queue, enqueue, clearQueue }),
    [hydrated, role, setRole, queue, enqueue, clearQueue]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState must be used within <AppProvider>');
  }
  return ctx;
}
