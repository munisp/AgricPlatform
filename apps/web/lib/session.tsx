'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserRole } from '@agric-platform/shared';
import { setAuthProvider } from '@/lib/api/client';

/**
 * Session context: the single source of truth for "who is using the app".
 *
 * Production identity is an OIDC bearer token (stored here after sign-in;
 * the API verifies it against the realm JWKS). In development, when no token
 * is present, the API accepts an `x-user-id` header — the dev role preview
 * selector below switches between the seeded development users for that.
 */
export interface SessionIdentity {
  userId: string;
  displayName: string;
  role: UserRole;
  token?: string;
  /** True when the identity comes from the development role preview. */
  isDevPreview: boolean;
}

interface SessionContextValue extends SessionIdentity {
  hydrated: boolean;
  /** Sign in with a registered account (token-based). */
  signIn: (identity: { userId: string; displayName: string; role: UserRole; token?: string }) => void;
  signOut: () => void;
  /**
   * DEVELOPMENT AFFORDANCE — preview the platform as another role by
   * switching to that role's seeded dev user (drives the `x-user-id`
   * header). Disabled for token-based sessions; never shipped to production
   * behaviour because the API ignores `x-user-id` when NODE_ENV=production.
   */
  previewRole: (role: UserRole) => void;
}

/**
 * Seeded development users (apps/api/src/database/seed-data.ts), one per
 * role, used by the dev role preview. Not secrets — dev fixtures only.
 */
export const DEV_PREVIEW_USERS: Record<UserRole, { userId: string; displayName: string }> = {
  farmer: { userId: 'user-adamu', displayName: 'Adamu Bello' },
  student: { userId: 'user-aisha', displayName: 'Aisha Yusuf' },
  buyer: { userId: 'user-buyer', displayName: 'Lagos Foods Ltd' },
  supplier: { userId: 'user-hassan', displayName: 'Hassan Abdullahi' },
  chapter_lead: { userId: 'user-lead-kaduna', displayName: 'Kaduna Chapter Lead' },
  partner: { userId: 'user-partner', displayName: 'Agri Partner Foundation' },
  admin: { userId: 'user-admin', displayName: 'NYFN Platform Admin' },
  vet: { userId: 'user-vet', displayName: 'Field Veterinarian' },
  lender: { userId: 'user-lender', displayName: 'Livestock Credit Cooperative' },
  insurer: { userId: 'user-insurer', displayName: 'Sahel Livestock Insurance' },
  regulator: { userId: 'user-regulator', displayName: 'State Vet Regulator' },
  donor: { userId: 'user-donor', displayName: 'Rural Livelihoods Donor Programme' }
};

const SESSION_KEY = 'agric.session';

const DEFAULT_SESSION: SessionIdentity = {
  ...DEV_PREVIEW_USERS.farmer,
  role: 'farmer',
  isDevPreview: true
};

const SessionContext = createContext<SessionContextValue | null>(null);

function readStoredSession(): SessionIdentity | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionIdentity;
    if (typeof parsed.userId === 'string' && typeof parsed.role === 'string') {
      return { ...parsed, isDevPreview: parsed.isDevPreview ?? !parsed.token };
    }
  } catch {
    // Corrupt or unavailable storage — fall back to the default dev identity.
  }
  return null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionIdentity>(DEFAULT_SESSION);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readStoredSession();
    if (stored) setSession(stored);
    setHydrated(true);
  }, []);

  // Wire the API client's auth header hook to the live session. Bearer token
  // wins; otherwise the dev x-user-id header is sent (no token is invented).
  useEffect(() => {
    setAuthProvider(() =>
      session.token
        ? { token: session.token, userId: session.userId }
        : { userId: session.userId }
    );
  }, [session.token, session.userId]);

  const persist = useCallback((next: SessionIdentity) => {
    setSession(next);
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable — session lives in memory only.
    }
  }, []);

  const signIn = useCallback<SessionContextValue['signIn']>(
    (identity) => {
      persist({ ...identity, isDevPreview: !identity.token });
    },
    [persist]
  );

  const signOut = useCallback(() => {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
    setSession(DEFAULT_SESSION);
  }, []);

  const previewRole = useCallback(
    (role: UserRole) => {
      // Token-based sessions keep their real identity; role preview is a
      // development-only affordance over the seeded dev users.
      if (session.token) {
        persist({ ...session, role });
        return;
      }
      persist({ ...DEV_PREVIEW_USERS[role], role, isDevPreview: true });
    },
    [persist, session]
  );

  const value = useMemo<SessionContextValue>(
    () => ({ ...session, hydrated, signIn, signOut, previewRole }),
    [session, hydrated, signIn, signOut, previewRole]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within <SessionProvider>');
  }
  return ctx;
}
