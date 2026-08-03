import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SyncEntityRegistry, type SyncableEntityDescriptor } from './sync-registry.js';

function descriptor(name: string, writable = false): SyncableEntityDescriptor {
  return {
    name,
    ownerField: 'ownerId',
    writable,
    getOwnerId: async () => null,
    getPayloads: async () => new Map()
  };
}

describe('SyncEntityRegistry', () => {
  it('registers and resolves a descriptor by name', () => {
    const registry = new SyncEntityRegistry();
    const entry = descriptor('farm');
    registry.register(entry);
    expect(registry.get('farm')).toBe(entry);
  });

  it('returns undefined for unregistered entities (fail-closed lookup)', () => {
    const registry = new SyncEntityRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('rejects duplicate registrations as wiring bugs', () => {
    const registry = new SyncEntityRegistry();
    registry.register(descriptor('farm'));
    expect(() => registry.register(descriptor('farm'))).toThrow(ConflictException);
  });

  it('lists registered entity names in stable sorted order', () => {
    const registry = new SyncEntityRegistry();
    registry.register(descriptor('zebra'));
    registry.register(descriptor('alpha'));
    expect(registry.list()).toEqual(['alpha', 'zebra']);
  });

  it('keeps writable and read-only descriptors distinct', () => {
    const registry = new SyncEntityRegistry();
    registry.register(descriptor('ro', false));
    registry.register(descriptor('rw', true));
    expect(registry.get('ro')!.writable).toBe(false);
    expect(registry.get('rw')!.writable).toBe(true);
  });
});
