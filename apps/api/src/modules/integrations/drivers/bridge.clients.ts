/**
 * Fail-closed REST bridge clients for the Phase 1 self-hosted systems
 * (wave P1): Moodle (LMS_DRIVER), Discourse (COMMUNITY_DRIVER) and
 * Directus (CMS_DRIVER). The learning/community/admin modules keep their
 * stub fixtures until these clients are wired in by the owning waves; the
 * factories here are the single construction point and refuse to build a
 * client without the full credential set.
 */
import { httpJson, missingEnv, ProviderConfigError } from './http.js';

// ---------------------------------------------------------------------------
// Moodle (course catalogue / enrolment sync)
// ---------------------------------------------------------------------------

export interface MoodleCourse {
  id: number;
  fullname: string;
  shortname: string;
  categoryid?: number;
}

export interface MoodleEnrolledUser {
  id: number;
  fullname: string;
  email?: string;
}

/** Moodle REST web-services client (token-authenticated). */
export class MoodleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async call<T>(wsfunction: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams({
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: 'json',
      ...params
    });
    return httpJson<T>(
      'moodle',
      `${this.baseUrl.replace(/\/$/, '')}/webservice/rest/server.php?${query.toString()}`,
      { method: 'POST' }
    );
  }

  /** Full visible course catalogue. */
  async getCourses(): Promise<MoodleCourse[]> {
    return this.call<MoodleCourse[]>('core_course_get_courses');
  }

  /** Users enrolled in a course (completion events arrive via webhook). */
  async getEnrolledUsers(courseId: number): Promise<MoodleEnrolledUser[]> {
    return this.call<MoodleEnrolledUser[]>('core_enrol_get_enrolled_users', {
      courseid: String(courseId)
    });
  }
}

// ---------------------------------------------------------------------------
// Discourse (community forum bridge)
// ---------------------------------------------------------------------------

export interface DiscourseTopic {
  id: number;
  title: string;
  slug?: string;
  posts_count?: number;
  category_id?: number;
}

export interface DiscourseLatestResponse {
  topic_list?: { topics?: DiscourseTopic[] };
}

/** Discourse API client (Api-Key/Api-Username header auth). */
export class DiscourseClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiUsername: string
  ) {}

  private headers(): Record<string, string> {
    return { 'Api-Key': this.apiKey, 'Api-Username': this.apiUsername };
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async getTopic(id: number): Promise<DiscourseTopic> {
    return httpJson<DiscourseTopic>('discourse', this.url(`/t/${id}.json`), {
      method: 'GET',
      headers: this.headers()
    });
  }

  async listLatestTopics(): Promise<DiscourseTopic[]> {
    const response = await httpJson<DiscourseLatestResponse>(
      'discourse',
      this.url('/latest.json'),
      { method: 'GET', headers: this.headers() }
    );
    return response.topic_list?.topics ?? [];
  }

  /** Creates a post inside an existing topic (moderation/announcement rail). */
  async createPost(topicId: number, raw: string): Promise<{ id?: number }> {
    return httpJson<{ id?: number }>('discourse', this.url('/posts.json'), {
      headers: this.headers(),
      body: { topic_id: topicId, raw }
    });
  }
}

// ---------------------------------------------------------------------------
// Directus (headless CMS for advisory content)
// ---------------------------------------------------------------------------

export interface DirectusItem {
  id: string | number;
  [field: string]: unknown;
}

interface DirectusItemsResponse {
  data?: DirectusItem[];
}

/** Directus REST client (static token bearer auth). */
export class DirectusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async getItems(collection: string, limit = 100): Promise<DirectusItem[]> {
    const response = await httpJson<DirectusItemsResponse>(
      'directus',
      this.url(`/items/${encodeURIComponent(collection)}?limit=${limit}`),
      { method: 'GET', headers: this.headers() }
    );
    return response.data ?? [];
  }

  async getItem(collection: string, id: string): Promise<DirectusItem | undefined> {
    const response = await httpJson<{ data?: DirectusItem }>(
      'directus',
      this.url(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`),
      { method: 'GET', headers: this.headers() }
    );
    return response.data;
  }
}

// ---------------------------------------------------------------------------
// Fail-closed factories
// ---------------------------------------------------------------------------

export function createMoodleClient(env: NodeJS.ProcessEnv = process.env): MoodleClient {
  const missing = missingEnv(env, ['MOODLE_BASE_URL', 'MOODLE_TOKEN']);
  if (missing.length > 0) {
    throw new ProviderConfigError('moodle', missing);
  }
  return new MoodleClient(env.MOODLE_BASE_URL as string, env.MOODLE_TOKEN as string);
}

export function createDiscourseClient(env: NodeJS.ProcessEnv = process.env): DiscourseClient {
  const missing = missingEnv(env, ['DISCOURSE_BASE_URL', 'DISCOURSE_API_KEY']);
  if (missing.length > 0) {
    throw new ProviderConfigError('discourse', missing);
  }
  return new DiscourseClient(
    env.DISCOURSE_BASE_URL as string,
    env.DISCOURSE_API_KEY as string,
    env.DISCOURSE_API_USERNAME ?? 'system'
  );
}

export function createDirectusClient(env: NodeJS.ProcessEnv = process.env): DirectusClient {
  const missing = missingEnv(env, ['DIRECTUS_BASE_URL', 'DIRECTUS_TOKEN']);
  if (missing.length > 0) {
    throw new ProviderConfigError('directus', missing);
  }
  return new DirectusClient(env.DIRECTUS_BASE_URL as string, env.DIRECTUS_TOKEN as string);
}
