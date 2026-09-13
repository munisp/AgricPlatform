import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAdvisoryRepository } from '../../database/repositories/advisory.repository.js';
import { createInMemoryBridgeSyncStateRepository } from '../../database/repositories/bridge-sync-state.repository.js';
import { createInMemoryCourseRepository } from '../../database/repositories/course.repository.js';
import { createInMemoryForumTopicRepository } from '../../database/repositories/forum-topic.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryWebhookDedupeStore } from '../../database/repositories/webhook-dedupe.repository.js';
import type {
  DirectusClient,
  DiscourseClient,
  MoodleClient
} from './drivers/bridge.clients.js';
import { BridgeSyncService, BRIDGE_SYNC_CIRCUIT_THRESHOLD } from './bridge-sync.service.js';
import { IntegrationsService } from './integrations.service.js';

function makeService(env: NodeJS.ProcessEnv) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const integrations = new IntegrationsService(undefined, createInMemoryWebhookDedupeStore(), events);
  const courses = createInMemoryCourseRepository();
  const topics = createInMemoryForumTopicRepository();
  const advisory = createInMemoryAdvisoryRepository();
  const states = createInMemoryBridgeSyncStateRepository();
  const service = new BridgeSyncService(integrations, courses, topics, advisory, states, env);
  return { service, integrations, courses, topics, advisory, states };
}

const moodleClient = (courses: unknown[]): MoodleClient =>
  ({ getCourses: vi.fn(async () => courses) }) as unknown as MoodleClient;

const discourseClient = (topics: unknown[]): DiscourseClient =>
  ({ listLatestTopics: vi.fn(async () => topics) }) as unknown as DiscourseClient;

const directusClient = (items: unknown[]): DirectusClient =>
  ({ getItems: vi.fn(async () => items) }) as unknown as DirectusClient;

describe('BridgeSyncService — config gating + fail-closed (WP-G20)', () => {
  it('default OFF: scheduled pass is a no-op and manual sync answers 503', async () => {
    const { service, states } = makeService({});
    expect(await service.syncEnabled()).toEqual([]);
    await expect(service.syncNow('moodle')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await states.all()).toHaveLength(0); // nothing was recorded
  });

  it('unknown bridge answers 404', async () => {
    const { service } = makeService({ BRIDGE_SYNC_MOODLE: 'true' });
    await expect(service.syncNow('wordpress')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('flag on but bridge client unconfigured: job no-ops with a recorded reason; API 503s', async () => {
    const { service, states } = makeService({ BRIDGE_SYNC_MOODLE: 'true' });
    // Stub driver: moodleClient() is undefined.
    const outcome = await service.syncBridge('moodle');
    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('unconfigured');
    const state = await states.get('moodle');
    expect(state?.lastStatus).toBe('skipped');
    expect(state?.lastSyncedAt).toBeUndefined();
    await expect(service.syncNow('moodle')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('BridgeSyncService — Moodle → learning.courses catalogue sync', () => {
  it('maps the remote catalogue onto deterministic ids and records sync state', async () => {
    const { service, integrations, courses, states } = makeService({ BRIDGE_SYNC_MOODLE: 'true' });
    vi.spyOn(integrations, 'moodleClient').mockReturnValue(
      moodleClient([
        { id: 7, fullname: 'Maize Agronomy 101', shortname: 'MA101', categoryid: 3 },
        { id: 9, fullname: 'Post-harvest Handling', shortname: 'PHH' }
      ])
    );

    const outcome = await service.syncNow('moodle');
    expect(outcome).toMatchObject({ bridge: 'moodle', status: 'ok', synced: 2 });

    const maize = await courses.findById('moodle-7');
    expect(maize).toBeDefined();
    expect(maize?.title).toBe('Maize Agronomy 101');
    expect(maize?.category).toBe('moodle-3');
    const other = await courses.findById('moodle-9');
    expect(other?.category).toBe('moodle');

    const state = await states.get('moodle');
    expect(state?.lastStatus).toBe('ok');
    expect(state?.lastSyncedAt).toBeDefined();
    expect(state?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replay-safe: a second run refreshes titles without duplicating or clobbering curation', async () => {
    const { service, integrations, courses } = makeService({ BRIDGE_SYNC_MOODLE: 'true' });
    const client = moodleClient([{ id: 7, fullname: 'Maize Agronomy 101', shortname: 'MA101' }]);
    vi.spyOn(integrations, 'moodleClient').mockReturnValue(client);
    await service.syncNow('moodle');
    const before = (await courses.findById('moodle-7'))!;
    // Local curation the sync must not clobber.
    await courses.update('moodle-7', { level: 'advanced', enrolmentCount: 42 });

    await service.syncNow('moodle');
    const after = (await courses.findById('moodle-7'))!;
    expect((await courses.find({})).filter((course) => course.id === 'moodle-7')).toHaveLength(1);
    expect(after.level).toBe('advanced');
    expect(after.enrolmentCount).toBe(42);
    // The same record is refreshed in place (not recreated): the second sync
    // serves the same client title for moodle-7. (Course has no createdAt
    // field — the pre-existing WP-G20 spec asserted against one in error.)
    expect(after.title).toBe(before.title);
  });
});

describe('BridgeSyncService — Discourse → community.forum_topics metadata sync', () => {
  it('mirrors latest topics under the bridge system identity', async () => {
    const { service, integrations, topics, states } = makeService({ BRIDGE_SYNC_DISCOURSE: 'true' });
    vi.spyOn(integrations, 'discourseClient').mockReturnValue(
      discourseClient([{ id: 42, title: 'Best planting window for sorghum', posts_count: 5, category_id: 8 }])
    );

    const outcome = await service.syncNow('discourse');
    expect(outcome).toMatchObject({ bridge: 'discourse', status: 'ok', synced: 1 });

    const topic = await topics.findById('discourse-42');
    expect(topic?.title).toBe('Best planting window for sorghum');
    expect(topic?.category).toBe('discourse-8');
    expect(topic?.authorId).toBe('discourse-bridge');
    expect(topic?.replyCount).toBe(4); // posts minus the opening post

    expect((await states.get('discourse'))?.lastStatus).toBe('ok');
  });
});

describe('BridgeSyncService — Directus → advisory.items content sync', () => {
  it('maps collection items onto advisory guides with defensive field fallbacks', async () => {
    const { service, integrations, advisory, states } = makeService({
      BRIDGE_SYNC_DIRECTUS: 'true',
      DIRECTUS_COLLECTION: 'guides'
    });
    const client = directusClient([
      { id: 'a1', title: 'Fall armyworm scouting', summary: 'Weekly scouting protocol', state: 'kebbi' },
      { id: 'b2', description: 'No title row falls back honestly' }
    ]);
    vi.spyOn(integrations, 'directusClient').mockReturnValue(client);

    const outcome = await service.syncNow('directus');
    expect(outcome).toMatchObject({ bridge: 'directus', status: 'ok', synced: 2 });
    expect(client.getItems).toHaveBeenCalledWith('guides');

    const guide = await advisory.findById('directus-guides-a1');
    expect(guide?.kind).toBe('guide');
    expect(guide?.title).toBe('Fall armyworm scouting');
    expect(guide?.state).toBe('kebbi');
    const fallback = await advisory.findById('directus-guides-b2');
    expect(fallback?.title).toBe('Directus guides item b2');
    expect(fallback?.summary).toBe('No title row falls back honestly');

    expect((await states.get('directus'))?.lastStatus).toBe('ok');
  });
});

describe('BridgeSyncService — failure handling + circuit breaker', () => {
  it('records failed runs and opens the circuit after consecutive failures', async () => {
    const { service, integrations, states } = makeService({ BRIDGE_SYNC_MOODLE: 'true' });
    vi.spyOn(integrations, 'moodleClient').mockReturnValue({
      getCourses: vi.fn(async () => {
        throw new Error('connection refused');
      })
    } as unknown as MoodleClient);

    for (let attempt = 0; attempt < BRIDGE_SYNC_CIRCUIT_THRESHOLD; attempt += 1) {
      await expect(service.syncNow('moodle')).rejects.toThrow('connection refused');
    }
    const failed = await states.get('moodle');
    expect(failed?.lastStatus).toBe('failed');
    expect(failed?.detail).toBe('connection refused');
    expect(failed?.lastSyncedAt).toBeUndefined();
    expect(service.circuitOpen('moodle')).toBe(true);

    // Circuit open: the scheduled pass no-ops with a logged/recorded reason
    // instead of hammering the unreachable bridge.
    const skipped = await service.syncBridge('moodle');
    expect(skipped.status).toBe('skipped');
    expect(skipped.detail).toContain('circuit');
    expect((await states.get('moodle'))?.lastStatus).toBe('skipped');
  });

  it('a failing bridge never blocks the others in the scheduled pass', async () => {
    const { service, integrations, topics } = makeService({
      BRIDGE_SYNC_MOODLE: 'true',
      BRIDGE_SYNC_DISCOURSE: 'true'
    });
    vi.spyOn(integrations, 'moodleClient').mockReturnValue({
      getCourses: vi.fn(async () => {
        throw new Error('boom');
      })
    } as unknown as MoodleClient);
    vi.spyOn(integrations, 'discourseClient').mockReturnValue(
      discourseClient([{ id: 1, title: 'Welcome', posts_count: 1 }])
    );

    const outcomes = await service.syncEnabled();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((outcome) => outcome.bridge === 'moodle')?.status).toBe('failed');
    expect(outcomes.find((outcome) => outcome.bridge === 'discourse')?.status).toBe('ok');
    expect(await topics.findById('discourse-1')).toBeDefined();
  });
});
