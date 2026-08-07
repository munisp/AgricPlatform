import { beforeEach, vi } from 'vitest';
import { configure } from '@testing-library/react';

// Async queries (waitFor/findBy*) default to a 1s timeout, which CI runners
// and loaded dev machines regularly exceed mid-suite (observed flakes at
// ~1.1s). Raise the global default; individual tests can still override.
configure({ asyncUtilTimeout: 3000 });

/**
 * Global test setup: mock next/navigation (App Router hooks are not
 * available outside a Next.js runtime) and provide a clean storage slate.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn()
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: () => {
    throw new Error('redirect');
  }
}));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
