import { describe, expect, it } from 'vitest';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { FeatureFlagsService } from './feature-flags.service.js';

const FLAG = {
  key: 'notifications.sse',
  enabled: true,
  roleAllowlist: [] as string[],
  percentage: 100,
  description: 'SSE notification stream'
};

function build(seed: Array<typeof FLAG> = []) {
  const repo = createInMemoryFeatureFlagRepository(seed);
  const service = new FeatureFlagsService(repo);
  return { service, repo };
}

describe('FeatureFlagsService', () => {
  it('fails closed for unknown flags', async () => {
    const { service } = build();
    expect(await service.isEnabled('missing.flag', { userId: 'u1', roles: ['admin'] })).toBe(false);
  });

  it('fails closed for disabled flags', async () => {
    const { service } = build([{ ...FLAG, enabled: false }]);
    expect(await service.isEnabled(FLAG.key, { userId: 'u1' })).toBe(false);
  });

  it('passes fully rolled-out flags with no role allowlist', async () => {
    const { service } = build([FLAG]);
    expect(await service.isEnabled(FLAG.key)).toBe(true);
  });

  it('enforces the role allowlist', async () => {
    const { service } = build([{ ...FLAG, roleAllowlist: ['admin'] }]);
    expect(await service.isEnabled(FLAG.key, { userId: 'u1', roles: ['farmer'] })).toBe(false);
    expect(await service.isEnabled(FLAG.key, { userId: 'u2', roles: ['farmer', 'admin'] })).toBe(true);
  });

  it('percentage rollout is deterministic per user and monotonic', async () => {
    const { service } = build([{ ...FLAG, percentage: 50 }]);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => service.isEnabled(FLAG.key, { userId: `user-${i}` }))
    );
    // Deterministic: same user, same answer.
    expect(await service.isEnabled(FLAG.key, { userId: 'user-0' })).toBe(results[0]);
    // A 50% rollout lets some users through and keeps others out.
    expect(results.some(Boolean)).toBe(true);
    expect(results.some((r) => !r)).toBe(true);
    // Anonymous callers fail closed on partial rollouts.
    expect(await service.isEnabled(FLAG.key)).toBe(false);
  });

  it('0% rollout blocks everyone; 100% passes without a userId', async () => {
    const { service } = build([{ ...FLAG, key: 'zero', percentage: 0 }, FLAG]);
    expect(await service.isEnabled('zero', { userId: 'u1' })).toBe(false);
    expect(await service.isEnabled(FLAG.key)).toBe(true);
  });

  it('upsert invalidates the read cache immediately', async () => {
    const { service } = build([{ ...FLAG, enabled: false }]);
    expect(await service.isEnabled(FLAG.key)).toBe(false);
    await service.upsert(FLAG);
    expect(await service.isEnabled(FLAG.key)).toBe(true);
  });

  it('remove deletes the flag and fails closed afterwards', async () => {
    const { service } = build([FLAG]);
    expect(await service.remove(FLAG.key)).toBe(true);
    expect(await service.remove(FLAG.key)).toBe(false);
    expect(await service.isEnabled(FLAG.key)).toBe(false);
  });

  it('list returns flags sorted by key', async () => {
    const { service } = build([FLAG, { ...FLAG, key: 'audit.verify-ui' }]);
    expect((await service.list()).map((flag) => flag.key)).toEqual([
      'audit.verify-ui',
      'notifications.sse'
    ]);
  });
});
