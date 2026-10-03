import { describe, expect, it } from 'vitest';
import { createInMemoryProcessedEventRepository } from '../database/repositories/processed-event.repository.js';
import { EventDedupService } from './event-dedup.service.js';

function build() {
  const processed = createInMemoryProcessedEventRepository();
  const dedup = new EventDedupService(processed);
  return { processed, dedup };
}

describe('EventDedupService', () => {
  it('once() records the first delivery and rejects duplicates', async () => {
    const { dedup } = build();
    expect(await dedup.once('consumer', 'event-1')).toBe(true);
    expect(await dedup.once('consumer', 'event-1')).toBe(false);
    // Dedup is per consumer: another consumer still sees a first delivery.
    expect(await dedup.once('other-consumer', 'event-1')).toBe(true);
  });

  it('runOnce executes the handler on first delivery and records it', async () => {
    const { dedup } = build();
    let runs = 0;
    const ran = await dedup.runOnce('consumer', 'event-1', () => {
      runs += 1;
    });
    expect(ran).toBe(true);
    expect(runs).toBe(1);
    expect(await dedup.has('consumer', 'event-1')).toBe(true);
  });

  it('runOnce skips an already-processed event (sweeper re-drive is a no-op)', async () => {
    const { dedup } = build();
    let runs = 0;
    const handler = () => {
      runs += 1;
    };
    expect(await dedup.runOnce('consumer', 'event-1', handler)).toBe(true);
    // Re-delivery of the same event id: handler must NOT re-execute.
    expect(await dedup.runOnce('consumer', 'event-1', handler)).toBe(false);
    expect(runs).toBe(1);
  });

  it('runOnce leaves a failed handling unrecorded so re-drive retries it', async () => {
    const { dedup } = build();
    let runs = 0;
    await expect(
      dedup.runOnce('consumer', 'event-1', () => {
        runs += 1;
        throw new Error('handler exploded');
      })
    ).rejects.toThrow('handler exploded');
    expect(await dedup.has('consumer', 'event-1')).toBe(false);
    // The re-drive runs the handler again and now records it.
    expect(await dedup.runOnce('consumer', 'event-1', () => undefined)).toBe(true);
    expect(await dedup.has('consumer', 'event-1')).toBe(true);
    expect(runs).toBe(1);
  });

  it('runOnce skips a concurrent duplicate of an in-flight delivery', async () => {
    const { dedup } = build();
    let runs = 0;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = dedup.runOnce('consumer', 'event-1', async () => {
      runs += 1;
      await blocker;
    });
    // Same (consumer, eventId) while the first delivery is in flight.
    expect(await dedup.runOnce('consumer', 'event-1', () => undefined)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    expect(await dedup.has('consumer', 'event-1')).toBe(true);
  });

  it('runOnce releases the in-flight slot when the handler throws', async () => {
    const { dedup } = build();
    await expect(
      dedup.runOnce('consumer', 'event-1', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    // Not stuck in-flight: a later re-drive is allowed through.
    expect(await dedup.runOnce('consumer', 'event-1', () => undefined)).toBe(true);
  });
});
