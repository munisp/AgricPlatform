import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { createInMemoryStorage, createOfflineQueue } from '../src/offline/queue';
import { AgentQueueScreen } from '../src/screens/AgentQueueScreen';

/* ------------------------------ helpers --------------------------------- */

function flattenText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

function screenText(root: ReactTestInstance): string {
  return root
    .findAllByType('rn-text' as never)
    .map((node) => flattenText(node.props.children))
    .join('\n');
}

function pressByLabel(root: ReactTestInstance, label: string): void {
  const target = root
    .findAllByType('rn-pressable' as never)
    .find((node) => flattenText(node).includes(label));
  if (!target) throw new Error(`No pressable labelled "${label}"`);
  (target.props as { onPress?: () => void }).onPress?.();
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface StubbedApi {
  client: ApiClient;
  calls: Array<{ url: string; init?: RequestInit }>;
}

function stubApi(routes: Record<string, unknown>, failRoutes: string[] = []): StubbedApi {
  const calls: StubbedApi['calls'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    for (const route of failRoutes) {
      if (path.endsWith(route)) {
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      }
    }
    for (const [route, body] of Object.entries(routes)) {
      if (path.endsWith(route)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
  return { client, calls };
}

async function renderWithApi(api: StubbedApi, ui: ReactNode): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ApiProvider client={api.client}>{ui}</ApiProvider>);
  });
  await flush();
  return renderer!;
}

const ASSIGNMENT = {
  id: 'asgn-1',
  agentUserId: 'user-enumerator',
  state: 'Kaduna',
  lga: 'Zaria',
  purpose: 'farmer-registration',
  targetCount: 3,
  completedCount: 1,
  status: 'in_progress',
  createdBy: 'user-admin',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z'
};

/* ------------------------------ tests ----------------------------------- */

describe('AgentQueueScreen', () => {
  it('lists the enumerator open assignments with progress', async () => {
    const api = stubApi({ '/field-agents/assignments/mine': { data: [ASSIGNMENT] } });
    const renderer = await renderWithApi(api, <AgentQueueScreen />);
    const text = screenText(renderer.root);
    expect(text).toContain('My field assignments (1)');
    expect(text).toContain('farmer-registration');
    expect(text).toContain('Kaduna / Zaria');
    expect(text).toContain('1 of 3 done');
  });

  it('shows an empty state when the queue is empty', async () => {
    const api = stubApi({ '/field-agents/assignments/mine': { data: [] } });
    const renderer = await renderWithApi(api, <AgentQueueScreen />);
    expect(screenText(renderer.root)).toContain('No open assignments right now.');
  });

  it('reports progress directly with a stable idempotency key', async () => {
    const api = stubApi({
      '/field-agents/assignments/mine': { data: [ASSIGNMENT] },
      '/field-agents/assignments/asgn-1/progress': {
        data: { ...ASSIGNMENT, completedCount: 2 }
      }
    });
    const renderer = await renderWithApi(api, <AgentQueueScreen />);
    await act(async () => {
      pressByLabel(renderer.root, 'Report progress');
    });
    await flush();
    const progressCalls = api.calls.filter((call) =>
      call.url.endsWith('/field-agents/assignments/asgn-1/progress')
    );
    expect(progressCalls).toHaveLength(1);
    const headers = (progressCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('agent-progress:asgn-1:2');
  });

  it('writes progress through the offline queue and flushes it', async () => {
    const api = stubApi({
      '/field-agents/assignments/mine': { data: [ASSIGNMENT] },
      '/field-agents/assignments/asgn-1/progress': {
        data: { ...ASSIGNMENT, completedCount: 2 }
      }
    });
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await renderWithApi(api, <AgentQueueScreen queue={queue} />);
    await act(async () => {
      pressByLabel(renderer.root, 'Report progress');
    });
    await flush();
    const progressCalls = api.calls.filter((call) =>
      call.url.endsWith('/field-agents/assignments/asgn-1/progress')
    );
    expect(progressCalls).toHaveLength(1);
    const headers = (progressCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('agent-progress:asgn-1:2');
    // Successful flush drains the queue.
    expect(await queue.pending()).toHaveLength(0);
  });

  it('keeps the report queued and says so when the flush fails offline', async () => {
    const api = stubApi(
      { '/field-agents/assignments/mine': { data: [ASSIGNMENT] } },
      ['/field-agents/assignments/asgn-1/progress']
    );
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await renderWithApi(api, <AgentQueueScreen queue={queue} />);
    await act(async () => {
      pressByLabel(renderer.root, 'Report progress');
    });
    await flush();
    expect(screenText(renderer.root)).toContain('Saved offline');
    const parked = await queue.pending();
    expect(parked).toHaveLength(1);
    expect(parked[0].idempotencyKey).toBe('agent-progress:asgn-1:2');
    expect(parked[0].path).toBe('/field-agents/assignments/asgn-1/progress');
  });
});
