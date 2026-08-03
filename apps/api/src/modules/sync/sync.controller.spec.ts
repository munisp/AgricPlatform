import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { SyncService } from './sync.service.js';
import { SyncController } from './sync.controller.js';
import { SYNC_PUSH_PAYLOAD_MAX_BYTES } from './sync.types.js';

const actor = { id: 'user-1', roles: ['farmer'] } as User;

function makeController() {
  const calls: { push: number; pull: number; status: number } = { push: 0, pull: 0, status: 0 };
  const service = {
    push: async () => {
      calls.push += 1;
      return [];
    },
    pull: async () => {
      calls.pull += 1;
      return { entity: 'test_note', items: [], cursor: 0, hasMore: false };
    },
    status: async () => {
      calls.status += 1;
      return [];
    }
  } as unknown as SyncService;
  return { controller: new SyncController(service), calls };
}

const upsertItem = {
  entity: 'test_note',
  entityId: 'n-1',
  clientMutationId: 'm-1',
  baseVersion: 0,
  op: 'upsert' as const,
  payload: { text: 'hello' }
};

describe('SyncController auth + batch validation', () => {
  it('rejects anonymous push/pull/status with 401', async () => {
    const { controller } = makeController();
    await expect(controller.push({ items: [upsertItem] }, null)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(controller.pull({ entity: 'test_note' }, null)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(controller.status(null)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects upsert items without a payload (400)', async () => {
    const { controller, calls } = makeController();
    await expect(
      controller.push({ items: [{ ...upsertItem, payload: undefined }] }, actor)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.push).toBe(0);
  });

  it('rejects payloads above the per-item byte limit (400)', async () => {
    const { controller, calls } = makeController();
    const fat = { text: 'x'.repeat(SYNC_PUSH_PAYLOAD_MAX_BYTES) };
    await expect(
      controller.push({ items: [{ ...upsertItem, payload: fat }] }, actor)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.push).toBe(0);
  });

  it('accepts delete items without a payload', async () => {
    const { controller, calls } = makeController();
    await controller.push(
      { items: [{ ...upsertItem, op: 'delete' as const, payload: undefined }] },
      actor
    );
    expect(calls.push).toBe(1);
  });

  it('delegates pull/status for authenticated callers and wraps in { data }', async () => {
    const { controller, calls } = makeController();
    const pull = await controller.pull({ entity: 'test_note', since: 0, limit: 10 }, actor);
    expect(pull.data.entity).toBe('test_note');
    const status = await controller.status(actor);
    expect(status.data).toEqual([]);
    expect(calls).toEqual({ push: 0, pull: 1, status: 1 });
  });
});
