/**
 * Mock of @react-native-community/netinfo for vitest with an __emit helper
 * so tests can simulate connectivity transitions.
 */

export interface NetInfoStateLike {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
  type?: string;
  details?: { isConnectionExpensive?: boolean } | null;
}

type Listener = (state: NetInfoStateLike) => void;
const listeners = new Set<Listener>();
let current: NetInfoStateLike = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
  details: { isConnectionExpensive: false }
};

const NetInfo = {
  addEventListener(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async fetch(): Promise<NetInfoStateLike> {
    return current;
  }
};

export function __emit(state: NetInfoStateLike): void {
  current = state;
  for (const listener of [...listeners]) listener(state);
}

export function __reset(): void {
  listeners.clear();
  current = {
    isConnected: true,
    isInternetReachable: true,
    type: 'wifi',
    details: { isConnectionExpensive: false }
  };
}

export default NetInfo;
