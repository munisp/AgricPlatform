import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectusClient,
  createDiscourseClient,
  createMoodleClient,
  DirectusClient,
  DiscourseClient,
  MoodleClient
} from './bridge.clients.js';
import { ProviderConfigError, ProviderHttpError } from './http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MoodleClient', () => {
  it('calls REST web services with the token in the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ id: 2, fullname: 'Agronomy 101', shortname: 'AGR101' }])
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new MoodleClient('https://moodle.example.com', 'tok');
    const courses = await client.getCourses();
    expect(courses).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('https://moodle.example.com/webservice/rest/server.php?');
    expect(url).toContain('wstoken=tok');
    expect(url).toContain('wsfunction=core_course_get_courses');
  });

  it('fetches enrolled users per course', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 9, fullname: 'Ada' }]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MoodleClient('https://moodle.example.com/', 'tok');
    const users = await client.getEnrolledUsers(2);
    expect(users[0].fullname).toBe('Ada');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('courseid=2');
    expect(url).not.toContain('.com//webservices');
  });

  it('maps provider errors to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    await expect(new MoodleClient('https://m', 't').getCourses()).rejects.toThrow(ProviderHttpError);
  });
});

describe('DiscourseClient', () => {
  it('lists latest topics with Api-Key headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ topic_list: { topics: [{ id: 1, title: 'Welcome' }] } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscourseClient('https://forum.example.com', 'key', 'system');
    const topics = await client.listLatestTopics();
    expect(topics[0].title).toBe('Welcome');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('key');
    expect(headers['Api-Username']).toBe('system');
  });

  it('creates posts inside topics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 55 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscourseClient('https://forum.example.com', 'key', 'mod');
    const post = await client.createPost(7, 'Moderation note');
    expect(post.id).toBe(55);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ topic_id: 7, raw: 'Moderation note' });
  });
});

describe('DirectusClient', () => {
  it('reads collection items with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 1, title: 'Article' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DirectusClient('https://cms.example.com', 'tok');
    const items = await client.getItems('articles');
    expect(items[0].title).toBe('Article');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cms.example.com/items/articles?limit=100');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('returns a single item or undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { id: 'a1' } })));
    const client = new DirectusClient('https://cms.example.com', 'tok');
    expect(await client.getItem('articles', 'a1')).toEqual({ id: 'a1' });
  });
});

describe('bridge factories (fail closed)', () => {
  it('moodle requires base URL and token', () => {
    expect(() => createMoodleClient({})).toThrow(ProviderConfigError);
    expect(() => createMoodleClient({ MOODLE_BASE_URL: 'https://m' })).toThrow(/MOODLE_TOKEN/);
    expect(createMoodleClient({ MOODLE_BASE_URL: 'https://m', MOODLE_TOKEN: 't' })).toBeInstanceOf(
      MoodleClient
    );
  });

  it('discourse requires base URL and API key', () => {
    expect(() => createDiscourseClient({ DISCOURSE_BASE_URL: 'https://f' })).toThrow(
      /DISCOURSE_API_KEY/
    );
    expect(
      createDiscourseClient({ DISCOURSE_BASE_URL: 'https://f', DISCOURSE_API_KEY: 'k' })
    ).toBeInstanceOf(DiscourseClient);
  });

  it('directus requires base URL and token', () => {
    expect(() => createDirectusClient({ DIRECTUS_TOKEN: 't' })).toThrow(/DIRECTUS_BASE_URL/);
    expect(
      createDirectusClient({ DIRECTUS_BASE_URL: 'https://c', DIRECTUS_TOKEN: 't' })
    ).toBeInstanceOf(DirectusClient);
  });
});
