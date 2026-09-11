import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from '../../modules/integrations/drivers/http.js';
import {
  createAuthorizationCheck,
  PermifyAuthorizationCheck,
  StubAuthorizationCheck
} from './authorization-check.driver.js';

describe('StubAuthorizationCheck (default — current RolesGuard/ownership logic)', () => {
  const check = new StubAuthorizationCheck();
  const loan = { type: 'credit_loan' as const, id: 'loan-1', ownerId: 'user-1' };

  it('allows the owner (mirrors assertSelfOrAdmin)', async () => {
    await expect(
      check.can({ userId: 'user-1', roles: ['farmer'] }, 'read', loan)
    ).resolves.toBe(true);
  });

  it('allows an admin', async () => {
    await expect(
      check.can({ userId: 'admin-9', roles: ['admin'] }, 'read', loan)
    ).resolves.toBe(true);
  });

  it('denies everyone else (fail closed)', async () => {
    await expect(
      check.can({ userId: 'user-2', roles: ['lender'] }, 'read', loan)
    ).resolves.toBe(false);
  });
});

describe('createAuthorizationCheck selection', () => {
  it('defaults to the stub when AUTHORIZATION_DRIVER is unset', () => {
    expect(createAuthorizationCheck({}).name).toBe('stub');
  });

  it('fails closed when permify is selected without PERMIFY_URL', () => {
    expect(() => createAuthorizationCheck({ AUTHORIZATION_DRIVER: 'permify' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds the permify driver with URL and tenant', () => {
    const check = createAuthorizationCheck({
      AUTHORIZATION_DRIVER: 'permify',
      PERMIFY_URL: 'http://localhost:3476',
      PERMIFY_TENANT_ID: 'agric'
    });
    expect(check.name).toBe('permify');
    expect((check as PermifyAuthorizationCheck).tenantId).toBe('agric');
  });
});

describe('PermifyAuthorizationCheck (REST proof for credit_loan read)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
  const loan = { type: 'credit_loan' as const, id: 'loan-1', ownerId: 'user-1' };

  it('posts the check to the tenant permissions endpoint and maps RESULT_ALLOWED', async () => {
    fetchMock().mockResolvedValue(
      new Response(JSON.stringify({ can: 'RESULT_ALLOWED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const check = new PermifyAuthorizationCheck('http://permify:3476/', { tenantId: 'agric' });
    await expect(
      check.can({ userId: 'user-1', roles: ['farmer'] }, 'read', loan)
    ).resolves.toBe(true);
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://permify:3476/v1/tenants/agric/permissions/check');
    const body = JSON.parse(init.body as string) as {
      entity: { type: string; id: string };
      permission: string;
      subject: { type: string; id: string };
    };
    expect(body.entity).toEqual({ type: 'credit_loan', id: 'loan-1' });
    expect(body.permission).toBe('read');
    expect(body.subject).toEqual({ type: 'user', id: 'user-1' });
  });

  it('maps RESULT_DENIED to false', async () => {
    fetchMock().mockResolvedValue(
      new Response(JSON.stringify({ can: 'RESULT_DENIED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const check = new PermifyAuthorizationCheck('http://permify:3476');
    await expect(
      check.can({ userId: 'user-2', roles: ['farmer'] }, 'read', loan)
    ).resolves.toBe(false);
  });

  it('fails closed on provider HTTP errors (ProviderHttpError → caller 503)', async () => {
    fetchMock().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const check = new PermifyAuthorizationCheck('http://permify:3476');
    await expect(
      check.can({ userId: 'user-1', roles: ['farmer'] }, 'read', loan)
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

/** Records TelemetryService calls; withSpan executes fn like the real thing. */
function fakeTelemetry() {
  return {
    withSpan: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()),
    increment: vi.fn(),
    record: vi.fn()
  };
}

describe('PermifyAuthorizationCheck telemetry (Stage 25.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
  const loan = { type: 'credit_loan' as const, id: 'loan-1', ownerId: 'user-1' };

  function permifyWith(telemetry: ReturnType<typeof fakeTelemetry>) {
    return new PermifyAuthorizationCheck('http://permify:3476', {
      tenantId: 'agric',
      telemetry: telemetry as never
    });
  }

  it('wraps checks in a span with relation/subject-type attrs and no PII', async () => {
    fetchMock().mockResolvedValue(
      new Response(JSON.stringify({ can: 'RESULT_ALLOWED' }), { status: 200 })
    );
    const telemetry = fakeTelemetry();
    await permifyWith(telemetry).can({ userId: 'user-1', roles: ['farmer'] }, 'read', loan);
    expect(telemetry.withSpan).toHaveBeenCalledWith(
      'permify.check',
      expect.objectContaining({
        'permify.relation': 'read',
        'permify.subject_type': 'user',
        'permify.resource_type': 'credit_loan',
        'permify.tenant': 'agric'
      }),
      expect.any(Function)
    );
    const attrs = JSON.stringify(telemetry.withSpan.mock.calls[0][1]);
    expect(attrs).not.toContain('user-1');
    expect(attrs).not.toContain('loan-1');
    expect(telemetry.record).toHaveBeenCalledWith(
      'permify.check.duration',
      expect.any(Number),
      expect.objectContaining({ 'permify.relation': 'read' })
    );
  });

  it('counts denies on permify.check.denied without counting an error', async () => {
    fetchMock().mockResolvedValue(
      new Response(JSON.stringify({ can: 'RESULT_DENIED' }), { status: 200 })
    );
    const telemetry = fakeTelemetry();
    await expect(
      permifyWith(telemetry).can({ userId: 'user-2', roles: ['farmer'] }, 'read', loan)
    ).resolves.toBe(false);
    expect(telemetry.increment).toHaveBeenCalledWith(
      'permify.check.denied',
      1,
      expect.objectContaining({ 'permify.relation': 'read' })
    );
    expect(telemetry.increment).not.toHaveBeenCalledWith(
      'permify.check.errors',
      expect.anything(),
      expect.anything()
    );
  });

  it('counts transport/HTTP failures and still throws (fail closed)', async () => {
    fetchMock().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const telemetry = fakeTelemetry();
    await expect(
      permifyWith(telemetry).can({ userId: 'user-1', roles: ['farmer'] }, 'read', loan)
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(telemetry.increment).toHaveBeenCalledWith(
      'permify.check.errors',
      1,
      expect.objectContaining({ 'permify.relation': 'read' })
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      'permify.check.duration',
      expect.any(Number),
      expect.anything()
    );
  });
});
