import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServiceWorkerRegister } from '@/components/sw-register';

/**
 * Component tests for the production-only service worker registration and
 * its message-gated update banner. The serviceWorker API is mocked on
 * navigator; NODE_ENV is stubbed per-test because the component must never
 * register outside production builds.
 */

type ServiceWorkerDouble = {
  register: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  controller: object | null;
};

function stubServiceWorker(api: Partial<ServiceWorkerDouble>) {
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: {
      register: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      controller: null,
      ...api
    },
    configurable: true
  });
}

function deleteServiceWorker() {
  // Reflect.deleteProperty works with the configurable stub from above.
  Reflect.deleteProperty(window.navigator, 'serviceWorker');
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  deleteServiceWorker();
});

describe('ServiceWorkerRegister', () => {
  it('renders nothing and does not register when serviceWorker is unsupported', () => {
    vi.stubEnv('NODE_ENV', 'production');
    deleteServiceWorker();
    const { container } = render(<ServiceWorkerRegister />);
    expect(container.firstChild).toBeNull();
  });

  it('never registers outside production builds', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const register = vi.fn();
    stubServiceWorker({ register });
    render(<ServiceWorkerRegister />);
    expect(register).not.toHaveBeenCalled();
  });

  it('registers /sw.js in production and stays silent when no update waits', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const register = vi.fn().mockResolvedValue({
      waiting: null,
      addEventListener: vi.fn()
    });
    stubServiceWorker({ register });
    const { container } = render(<ServiceWorkerRegister />);
    await waitFor(() => expect(register).toHaveBeenCalledWith('/sw.js'));
    expect(container.firstChild).toBeNull();
  });

  it('survives a rejected registration without breaking the shell', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const register = vi.fn().mockRejectedValue(new Error('no sw'));
    stubServiceWorker({ register });
    const { container } = render(<ServiceWorkerRegister />);
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('announces a waiting update via role=status and posts SKIP_WAITING on confirm', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const waitingWorker = { postMessage: vi.fn() };
    const register = vi.fn().mockResolvedValue({
      waiting: waitingWorker,
      addEventListener: vi.fn()
    });
    stubServiceWorker({ register });
    render(<ServiceWorkerRegister />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Update available.');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });
});
