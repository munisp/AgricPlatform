import { describe, expect, it } from 'vitest';
import { PartnerRateService } from './partner-rate.service.js';

describe('PartnerRateService (per-client token bucket)', () => {
  it('allows up to the per-minute limit (full-bucket burst)', () => {
    const rate = new PartnerRateService();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      expect(rate.consume('client-a', 5, now)).not.toBeNull();
    }
    expect(rate.consume('client-a', 5, now)).toBeNull();
  });

  it('refills tokens over time', () => {
    const rate = new PartnerRateService();
    const start = Date.now();
    expect(rate.consume('client-b', 2, start)).not.toBeNull();
    expect(rate.consume('client-b', 2, start)).not.toBeNull();
    expect(rate.consume('client-b', 2, start)).toBeNull();
    // 30s later at 2/min -> exactly one token refilled.
    expect(rate.consume('client-b', 2, start + 30_000)).not.toBeNull();
    expect(rate.consume('client-b', 2, start + 30_000)).toBeNull();
  });

  it('tracks buckets independently per client', () => {
    const rate = new PartnerRateService();
    const now = Date.now();
    expect(rate.consume('client-c', 1, now)).not.toBeNull();
    expect(rate.consume('client-c', 1, now)).toBeNull();
    expect(rate.consume('client-d', 1, now)).not.toBeNull();
  });

  it('never refills beyond capacity', () => {
    const rate = new PartnerRateService();
    const start = Date.now();
    expect(rate.consume('client-e', 3, start)).not.toBeNull();
    // Long idle period: bucket caps at 3, not more.
    const later = start + 3_600_000;
    expect(rate.consume('client-e', 3, later)).not.toBeNull();
    expect(rate.consume('client-e', 3, later)).not.toBeNull();
    expect(rate.consume('client-e', 3, later)).not.toBeNull();
    expect(rate.consume('client-e', 3, later)).toBeNull();
  });

  it('reset clears all buckets', () => {
    const rate = new PartnerRateService();
    const now = Date.now();
    expect(rate.consume('client-f', 1, now)).not.toBeNull();
    expect(rate.consume('client-f', 1, now)).toBeNull();
    rate.reset();
    expect(rate.consume('client-f', 1, now)).not.toBeNull();
  });
});
