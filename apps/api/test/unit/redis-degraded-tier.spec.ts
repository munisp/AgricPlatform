import { describe, expect, it } from 'vitest';
import { noteRedisFailure, noteRedisSuccess, redisCircuitOpen } from '../../src/redis/redis-circuit.js';

/**
 * GAP-M04: the Redis degraded tier must surface where a silent fail-open
 * becomes a security incident. The USSD registration counter is the
 * fail-closed subscriber: while the circuit reports Redis down, USSD
 * registration refuses rather than issuing unthrottled accounts.
 */
describe('redis degraded-tier circuit (GAP-M04 / OB-09)', () => {
  it('starts closed (healthy)', () => {
    noteRedisSuccess();
    expect(redisCircuitOpen()).toBe(false);
  });

  it('opens after consecutive failures and closes again on success', () => {
    noteRedisSuccess();
    noteRedisFailure(new Error('ECONNREFUSED'));
    expect(redisCircuitOpen()).toBe(false); // single blip tolerated
    noteRedisFailure(new Error('ECONNREFUSED'));
    noteRedisFailure(new Error('ECONNREFUSED'));
    expect(redisCircuitOpen()).toBe(true);
    noteRedisSuccess();
    expect(redisCircuitOpen()).toBe(false);
  });

  it('a success mid-failure-run resets the failure count', () => {
    noteRedisSuccess();
    noteRedisFailure(new Error('x'));
    noteRedisFailure(new Error('x'));
    noteRedisSuccess();
    noteRedisFailure(new Error('x'));
    noteRedisFailure(new Error('x'));
    expect(redisCircuitOpen()).toBe(false);
  });
});
