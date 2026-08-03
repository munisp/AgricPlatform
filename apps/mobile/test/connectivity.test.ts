/**
 * Connectivity-driven sync tests (audit P1-12): reconnect + foreground
 * triggers flush/pull, metered connections conserve data, failures never
 * break the listener wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  startConnectivitySync,
  type ConnectivityStateLike
} from '../src/sync/connectivity';

interface Harness {
  emitNet: (state: ConnectivityStateLike) => void;
  emitApp: (state: string) => void;
  flushes: number;
  pulls: number;
  stop: () => void;
}

function harness(options: { flushFails?: boolean; pullFails?: boolean } = {}): Harness {
  let netListener: ((state: ConnectivityStateLike) => void) | null = null;
  let appListener: ((state: string) => void) | null = null;
  const state: Harness = {
    flushes: 0,
    pulls: 0,
    emitNet(next) {
      netListener?.(next);
    },
    emitApp(next) {
      appListener?.(next);
    },
    stop: () => undefined
  };
  state.stop = startConnectivitySync({
    addNetInfoListener(listener) {
      netListener = listener;
      return () => {
        netListener = null;
      };
    },
    addAppStateListener(listener) {
      appListener = listener;
      return () => {
        appListener = null;
      };
    },
    async flushOutbox() {
      state.flushes += 1;
      if (options.flushFails) throw new Error('offline still');
    },
    async pullLatest() {
      state.pulls += 1;
      if (options.pullFails) throw new Error('server down');
    }
  });
  return state;
}

const ONLINE = { isConnected: true, details: { isConnectionExpensive: false } };
const ONLINE_METERED = { isConnected: true, details: { isConnectionExpensive: true } };
const OFFLINE = { isConnected: false, details: null };

describe('startConnectivitySync', () => {
  it('flushes the outbox and pulls on reconnect', () => {
    const h = harness();
    h.emitNet(OFFLINE);
    expect(h.flushes).toBe(0);
    h.emitNet(ONLINE);
    expect(h.flushes).toBe(1);
    expect(h.pulls).toBe(1);
  });

  it('does nothing while the device stays offline', () => {
    const h = harness();
    h.emitNet(OFFLINE);
    h.emitNet(OFFLINE);
    expect(h.flushes).toBe(0);
    expect(h.pulls).toBe(0);
  });

  it('flushes but SKIPS the pull on a metered connection (data conservation)', () => {
    const h = harness();
    h.emitNet(ONLINE_METERED);
    expect(h.flushes).toBe(1);
    expect(h.pulls).toBe(0);
  });

  it('runs flush + pull when the app returns to the foreground', () => {
    const h = harness();
    h.emitNet(ONLINE);
    h.emitApp('background');
    expect(h.flushes).toBe(1);
    h.emitApp('active');
    expect(h.flushes).toBe(2);
    expect(h.pulls).toBe(2);
  });

  it('remembers the metered state for foreground syncs', () => {
    const h = harness();
    h.emitNet(ONLINE_METERED); // metered: pull skipped, state remembered
    h.emitApp('active');
    expect(h.flushes).toBe(2);
    expect(h.pulls).toBe(0);
  });

  it('survives sync failures — the listeners stay wired for the next trigger', () => {
    const h = harness({ flushFails: true, pullFails: true });
    h.emitNet(ONLINE);
    h.emitApp('active');
    expect(h.flushes).toBe(2);
    expect(h.pulls).toBe(2);
  });

  it('stops reacting after unsubscribe', () => {
    const h = harness();
    h.stop();
    h.emitNet(ONLINE);
    h.emitApp('active');
    expect(h.flushes).toBe(0);
    expect(h.pulls).toBe(0);
  });
});
