import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit
} from '@nestjs/common';
import type { AdvisoryItem, Course, ForumTopic } from '@agric-platform/shared';
import {
  ADVISORY_REPOSITORY,
  BRIDGE_SYNC_STATE_REPOSITORY,
  COURSE_REPOSITORY,
  FORUM_TOPIC_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AdvisoryRepository } from '../../database/repositories/advisory.repository.js';
import type {
  BridgeName,
  BridgeSyncStateRepository,
  BridgeSyncStatus
} from '../../database/repositories/bridge-sync-state.repository.js';
import type { CourseRepository } from '../../database/repositories/course.repository.js';
import type { ForumTopicRepository } from '../../database/repositories/forum-topic.repository.js';
import type {
  DirectusClient,
  DirectusItem,
  DiscourseClient,
  DiscourseTopic,
  MoodleClient,
  MoodleCourse
} from './drivers/bridge.clients.js';
import { IntegrationsService } from './integrations.service.js';

/** Default cadence: every 6 hours (mirrors the market-data ingestion default). */
export const BRIDGE_SYNC_DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Consecutive failures before a bridge's circuit opens. */
export const BRIDGE_SYNC_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open (checked at call time — no timers). */
export const BRIDGE_SYNC_CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000;

const BRIDGES: readonly BridgeName[] = ['moodle', 'discourse', 'directus'];

/** Per-bridge feature-flag env var (default OFF — scheduled sync is opt-in). */
const BRIDGE_FLAG_ENV: Record<BridgeName, string> = {
  moodle: 'BRIDGE_SYNC_MOODLE',
  discourse: 'BRIDGE_SYNC_DISCOURSE',
  directus: 'BRIDGE_SYNC_DIRECTUS'
};

export interface BridgeSyncOutcome {
  bridge: BridgeName;
  status: BridgeSyncStatus;
  /** Rows created/updated in the target domain (0 for skipped/failed). */
  synced: number;
  detail?: string;
}

/**
 * Scheduled bridge sync consumers (WP-G20): the wave-P1 Moodle/Discourse/
 * Directus bridge clients previously had ZERO consumers. Each job is:
 *
 *  - CONFIG-GATED: BRIDGE_SYNC_<BRIDGE>=true opts in (default OFF) and the
 *    bridge's own driver must be live (LMS_DRIVER / COMMUNITY_DRIVER /
 *    CMS_DRIVER non-stub with the full credential set) — otherwise the
 *    scheduled run NO-OPS with a logged reason (recorded as 'skipped').
 *  - FAIL-CLOSED: a manual sync (POST /integrations/bridges/:bridge/sync)
 *    answers 503 when the job is disabled or the client is unconfigured —
 *    no silent stub data.
 *  - RESILIENT: the bridge clients' 5s HTTP timeout (drivers/http.ts) plus a
 *    call-time circuit breaker per bridge (opens after
 *    BRIDGE_SYNC_CIRCUIT_THRESHOLD consecutive failures for the cooldown),
 *    mirroring the weather-provider platform pattern.
 *  - REPLAY-SAFE: remote rows map onto deterministic ids (moodle-<id>,
 *    discourse-<id>, directus-<collection>-<id>) in the EXISTING target
 *    tables (learning.courses, community.forum_topics, advisory.items), so
 *    reruns and overlapping runs dedupe by id.
 *  - TRACKED: every run upserts integrations.bridge_sync_state
 *    (last_synced_at / last_status / payload_hash / detail).
 */
@Injectable()
export class BridgeSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BridgeSyncService.name);
  private timer?: NodeJS.Timeout;
  private readonly consecutiveFailures = new Map<BridgeName, number>();
  private readonly circuitOpenUntil = new Map<BridgeName, number>();

  constructor(
    private readonly integrations: IntegrationsService,
    @Inject(COURSE_REPOSITORY) private readonly courses: CourseRepository,
    @Inject(FORUM_TOPIC_REPOSITORY) private readonly topics: ForumTopicRepository,
    @Inject(ADVISORY_REPOSITORY) private readonly advisory: AdvisoryRepository,
    @Inject(BRIDGE_SYNC_STATE_REPOSITORY) private readonly states: BridgeSyncStateRepository,
    // @Optional: tests inject env directly; Nest keeps process.env at runtime.
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** Scheduled sync runs only when the per-bridge flag is explicitly on. */
  flagEnabled(bridge: BridgeName): boolean {
    return (this.env[BRIDGE_FLAG_ENV[bridge]] ?? '').trim().toLowerCase() === 'true';
  }

  /** Live bridge client; undefined while the bridge driver stays stub. */
  private clientFor(bridge: BridgeName): MoodleClient | DiscourseClient | DirectusClient | undefined {
    switch (bridge) {
      case 'moodle':
        return this.integrations.moodleClient();
      case 'discourse':
        return this.integrations.discourseClient();
      case 'directus':
        return this.integrations.directusClient();
    }
  }

  private anyEnabled(): boolean {
    return BRIDGES.some((bridge) => this.flagEnabled(bridge));
  }

  onModuleInit(): void {
    if (!this.anyEnabled()) {
      return; // default OFF: no timer, no network, no state writes.
    }
    const intervalMs = Number(this.env.BRIDGE_SYNC_INTERVAL_MS ?? BRIDGE_SYNC_DEFAULT_INTERVAL_MS);
    this.logger.log(
      `Bridge sync enabled (${BRIDGES.filter((bridge) => this.flagEnabled(bridge)).join(', ')}; every ${intervalMs}ms)`
    );
    void this.syncEnabled().catch((error) =>
      this.logger.warn(`Initial bridge sync failed: ${(error as Error).message}`)
    );
    this.timer = setInterval(() => {
      void this.syncEnabled().catch((error) =>
        this.logger.warn(`Scheduled bridge sync failed: ${(error as Error).message}`)
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Visible for tests: whether a bridge's circuit breaker is open. */
  circuitOpen(bridge: BridgeName): boolean {
    const failures = this.consecutiveFailures.get(bridge) ?? 0;
    return failures >= BRIDGE_SYNC_CIRCUIT_THRESHOLD && Date.now() < (this.circuitOpenUntil.get(bridge) ?? 0);
  }

  /** One scheduled pass over every flag-enabled bridge. Errors are contained per bridge. */
  async syncEnabled(): Promise<BridgeSyncOutcome[]> {
    const outcomes: BridgeSyncOutcome[] = [];
    for (const bridge of BRIDGES) {
      if (!this.flagEnabled(bridge)) {
        continue;
      }
      try {
        outcomes.push(await this.syncBridge(bridge));
      } catch (error) {
        // Contained per bridge: one failing bridge never blocks the others.
        this.logger.warn(`Bridge sync '${bridge}' failed: ${(error as Error).message}`);
        outcomes.push({ bridge, status: 'failed', synced: 0, detail: (error as Error).message });
      }
    }
    return outcomes;
  }

  /**
   * Manual trigger (admin API). FAIL-CLOSED: 503 when the job is disabled
   * or the bridge client is unconfigured — the scheduled path no-ops, but
   * an explicit API call must never pretend a sync happened.
   */
  async syncNow(bridge: string): Promise<BridgeSyncOutcome> {
    if (!BRIDGES.includes(bridge as BridgeName)) {
      throw new NotFoundException(`Unknown bridge '${bridge}' (expected one of ${BRIDGES.join(', ')})`);
    }
    const name = bridge as BridgeName;
    if (!this.flagEnabled(name)) {
      throw new ServiceUnavailableException(
        `Bridge sync '${name}' is disabled: set ${BRIDGE_FLAG_ENV[name]}=true to opt in.`
      );
    }
    if (!this.clientFor(name)) {
      throw new ServiceUnavailableException(
        `Bridge sync '${name}' is enabled but its bridge client is unconfigured ` +
          '(driver still stub — set the bridge base URL + credentials envs).'
      );
    }
    return this.syncBridge(name);
  }

  /**
   * One sync pass for a single bridge. Scheduled-safe: unconfigured clients
   * and open circuits NO-OP with a logged reason and a 'skipped' state row;
   * fetch/persist failures record 'failed', trip the circuit breaker and
   * rethrow so the manual API path surfaces the failure honestly.
   */
  async syncBridge(bridge: BridgeName): Promise<BridgeSyncOutcome> {
    const client = this.clientFor(bridge);
    if (!client) {
      const detail = 'bridge client unconfigured (driver stub)';
      this.logger.warn(`Bridge sync '${bridge}' skipped: ${detail}`);
      await this.recordState(bridge, { status: 'skipped', detail });
      return { bridge, status: 'skipped', synced: 0, detail };
    }
    if (this.circuitOpen(bridge)) {
      const detail = 'circuit breaker open after consecutive failures';
      this.logger.warn(`Bridge sync '${bridge}' skipped: ${detail}`);
      await this.recordState(bridge, { status: 'skipped', detail });
      return { bridge, status: 'skipped', synced: 0, detail };
    }
    try {
      const { synced, payloadHash } = await this.fetchAndPersist(bridge, client);
      this.recordSuccess(bridge);
      await this.recordState(bridge, {
        status: 'ok',
        payloadHash,
        detail: `${synced} row(s) synced`,
        syncedAt: new Date().toISOString()
      });
      return { bridge, status: 'ok', synced };
    } catch (error) {
      this.recordFailure(bridge);
      const detail = (error as Error).message;
      await this.recordState(bridge, { status: 'failed', detail });
      throw error;
    }
  }

  /** Fetch the remote catalogue and upsert it into the bridge's target table. */
  private async fetchAndPersist(
    bridge: BridgeName,
    client: MoodleClient | DiscourseClient | DirectusClient
  ): Promise<{ synced: number; payloadHash: string }> {
    switch (bridge) {
      case 'moodle': {
        const courses = await (client as MoodleClient).getCourses();
        return {
          synced: await this.upsertCourses(courses),
          payloadHash: hashPayload(courses)
        };
      }
      case 'discourse': {
        const topics = await (client as DiscourseClient).listLatestTopics();
        return {
          synced: await this.upsertTopics(topics),
          payloadHash: hashPayload(topics)
        };
      }
      case 'directus': {
        const collection = (this.env.DIRECTUS_COLLECTION ?? 'advisory').trim() || 'advisory';
        const items = await (client as DirectusClient).getItems(collection);
        return {
          synced: await this.upsertAdvisoryItems(collection, items),
          payloadHash: hashPayload(items)
        };
      }
    }
  }

  /** Moodle course catalogue → learning.courses (deterministic moodle-<id>). */
  private async upsertCourses(remote: MoodleCourse[]): Promise<number> {
    let synced = 0;
    for (const course of remote) {
      const id = `moodle-${course.id}`;
      const mapped: Course = {
        id,
        title: course.fullname,
        category: course.categoryid ? `moodle-${course.categoryid}` : 'moodle',
        level: 'beginner',
        durationMinutes: 0,
        language: 'en',
        enrolmentCount: 0,
        offlineAvailable: false
      };
      if (await this.courses.findById(id)) {
        // Never clobber local curation: only the synced title is refreshed.
        await this.courses.update(id, { title: mapped.title, category: mapped.category });
      } else {
        await this.courses.create(mapped);
      }
      synced += 1;
    }
    return synced;
  }

  /** Discourse latest topics → community.forum_topics (deterministic discourse-<id>). */
  private async upsertTopics(remote: DiscourseTopic[]): Promise<number> {
    let synced = 0;
    for (const topic of remote) {
      const id = `discourse-${topic.id}`;
      const replyCount = Math.max(0, (topic.posts_count ?? 1) - 1);
      if (await this.topics.findById(id)) {
        await this.topics.update(id, { title: topic.title, replyCount });
      } else {
        const mapped: ForumTopic = {
          id,
          title: topic.title,
          category: topic.category_id ? `discourse-${topic.category_id}` : 'discourse',
          // No FK to identity.users on author_id (001_init.sql): the bridge
          // system identity marks mirrored rows without impersonating a user.
          authorId: 'discourse-bridge',
          replyCount,
          createdAt: new Date().toISOString()
        };
        await this.topics.create(mapped);
      }
      synced += 1;
    }
    return synced;
  }

  /** Directus collection items → advisory.items (deterministic directus-<collection>-<id>). */
  private async upsertAdvisoryItems(collection: string, remote: DirectusItem[]): Promise<number> {
    let synced = 0;
    for (const item of remote) {
      const id = `directus-${collection}-${item.id}`;
      const title =
        typeof item.title === 'string' && item.title.trim().length > 0
          ? item.title
          : `Directus ${collection} item ${item.id}`;
      const summary =
        typeof item.summary === 'string' && item.summary.trim().length > 0
          ? item.summary
          : typeof item.description === 'string' && item.description.trim().length > 0
            ? item.description
            : title;
      if (await this.advisory.findById(id)) {
        await this.advisory.update(id, { title, summary });
      } else {
        const mapped: AdvisoryItem = {
          id,
          kind: 'guide',
          title,
          summary,
          state: typeof item.state === 'string' ? item.state : undefined,
          crop: typeof item.crop === 'string' ? item.crop : undefined,
          publishedAt:
            typeof item.published_at === 'string' ? item.published_at : new Date().toISOString()
        };
        await this.advisory.create(mapped);
      }
      synced += 1;
    }
    return synced;
  }

  private async recordState(
    bridge: BridgeName,
    update: { status: BridgeSyncStatus; detail?: string; payloadHash?: string; syncedAt?: string }
  ): Promise<void> {
    const previous = await this.states.get(bridge);
    await this.states.upsert({
      bridge,
      lastSyncedAt: update.syncedAt ?? previous?.lastSyncedAt,
      lastStatus: update.status,
      payloadHash: update.payloadHash ?? previous?.payloadHash,
      detail: update.detail
    });
  }

  private recordSuccess(bridge: BridgeName): void {
    this.consecutiveFailures.set(bridge, 0);
    this.circuitOpenUntil.set(bridge, 0);
  }

  private recordFailure(bridge: BridgeName): void {
    const failures = (this.consecutiveFailures.get(bridge) ?? 0) + 1;
    this.consecutiveFailures.set(bridge, failures);
    if (failures >= BRIDGE_SYNC_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil.set(bridge, Date.now() + BRIDGE_SYNC_CIRCUIT_COOLDOWN_MS);
    }
  }
}

/** sha256 over the fetched payload — change detection across sync runs. */
function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
