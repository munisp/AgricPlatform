import { describe, expect, it } from 'vitest';
import {
  circuitBreakerState,
  classifyDriverError,
  DriverHealthTracker
} from './driver-health.js';
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from './http.js';

describe('circuitBreakerState (platform breaker vocabulary)', () => {
  it('is closed below the failure threshold', () => {
    expect(circuitBreakerState(0, 3, 0)).toBe('closed');
    expect(circuitBreakerState(2, 3, 0)).toBe('closed');
  });

  it('is open at/above the threshold while the cooldown holds', () => {
    const now = 1_000_000;
    expect(circuitBreakerState(3, 3, now + 30_000, now)).toBe('open');
  });

  it('is half-open once the cooldown expires (next call is the probe)', () => {
    const now = 1_000_000;
    expect(circuitBreakerState(3, 3, now + 30_000, now + 30_001)).toBe('half-open');
  });
});

describe('classifyDriverError', () => {
  it('classifies the shared provider error taxonomy', () => {
    expect(classifyDriverError(new ProviderRequestError('x', 'timeout'))).toBe('timeout');
    expect(classifyDriverError(new ProviderRequestError('x', 'network'))).toBe('network');
    expect(classifyDriverError(new ProviderHttpError('x', 502, ''))).toBe('http-5xx');
    expect(classifyDriverError(new ProviderHttpError('x', 404, ''))).toBe('http-4xx');
    expect(classifyDriverError(new ProviderConfigError('x', ['Y']))).toBe('config');
    expect(classifyDriverError(new Error('boom'))).toBe('internal');
    expect(classifyDriverError('string failure')).toBe('internal');
  });
});

describe('DriverHealthTracker', () => {
  it('records last success / last error and the failing flag', () => {
    const tracker = new DriverHealthTracker();
    expect(tracker.lastErrorClass).toBeNull();
    expect(tracker.lastSuccessAt).toBeNull();
    expect(tracker.failing).toBe(false);

    tracker.recordSuccess(2000);
    expect(tracker.lastSuccessAt).toBe(new Date(2000).toISOString());
    expect(tracker.failing).toBe(false);

    tracker.recordError(new ProviderRequestError('x', 'timeout'), 3000);
    expect(tracker.lastErrorClass).toBe('timeout');
    expect(tracker.lastErrorAt).toBe(new Date(3000).toISOString());
    expect(tracker.failing).toBe(true);

    // A later success clears the failing flag but keeps the history.
    tracker.recordSuccess(4000);
    expect(tracker.failing).toBe(false);
    expect(tracker.lastErrorClass).toBe('timeout');
    expect(tracker.lastSuccessAt).toBe(new Date(4000).toISOString());
  });
});
