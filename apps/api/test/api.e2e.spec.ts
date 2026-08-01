import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

/**
 * End-to-end tests against a real HTTP listener (no external network; the
 * server binds to an ephemeral localhost port).
 */
describe('AgricPlatform API (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  }

  it('serves health endpoints', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('@agric-platform/api');

    const ready = await (await fetch(`${base}/health/ready`)).json();
    expect(ready.integrations.length).toBeGreaterThanOrEqual(8);
    expect(ready.integrations.every((i: { driver: string }) => i.driver === 'stub')).toBe(true);
  });

  it('lists seeded courses with pagination envelope', async () => {
    const res = await fetch(`${base}/courses?pageSize=2`);
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.data).toHaveLength(2);
    expect(body.page).toBe(1);
  });

  it('supports enrolment -> progress -> certificate verification', async () => {
    const enrol = await (await post('/courses/course-post-harvest/enrol', { userId: 'user-aisha' })).json();
    expect(enrol.data.status).toBe('enrolled');

    const done = await (
      await fetch(`${base}/enrolments/${enrol.data.id}/progress`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ progressPercent: 100 })
      })
    ).json();
    expect(done.data.status).toBe('completed');

    const certs = await (await fetch(`${base}/users/user-aisha/certificates`)).json();
    const code = certs.data.find((c: { courseId: string }) => c.courseId === 'course-post-harvest')
      .verificationCode;
    const verification = await (await fetch(`${base}/certificates/verify/${code}`)).json();
    expect(verification.data.valid).toBe(true);
    expect(verification.data.learnerName).toBe('Aisha Yusuf');

    const invalid = await (await fetch(`${base}/certificates/verify/NOPE-000`)).json();
    expect(invalid.data.valid).toBe(false);
  });

  it('recomputes profile completion score on upsert', async () => {
    const res = await fetch(`${base}/profiles/user-admin`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        location: { state: 'FCT', lga: 'Abuja Municipal' },
        farmingInterests: ['Rice'],
        valueChains: ['Rice']
      })
    });
    const body = await res.json();
    expect(body.data.completionScore).toBe(70);

    const report = await (await fetch(`${base}/profiles/user-admin/completion`)).json();
    expect(report.data.score).toBe(70);
    expect(report.data.missing).toContain('bio');
  });

  it('applies to opportunities and rejects duplicates', async () => {
    const first = await post('/opportunities/opp-nysc-agribusiness/apply', { userId: 'user-aisha' });
    expect(first.status).toBe(201);
    const duplicate = await post('/opportunities/opp-nysc-agribusiness/apply', { userId: 'user-aisha' });
    expect(duplicate.status).toBe(409);
  });

  it('replays mutations with the same idempotency key', async () => {
    const payload = { buyerId: 'user-buyer', quantity: 1 };
    const headers = { 'idempotency-key': 'e2e-order-1' };
    const first = await post('/listings/listing-maize-kano/orders', payload, headers);
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await post('/listings/listing-maize-kano/orders', payload, headers);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    const replayBody = await replay.json();
    expect(replayBody.data.id).toBe(firstBody.data.id);

    const orders = await (await fetch(`${base}/orders?buyerId=user-buyer`)).json();
    expect(orders.data.filter((o: { listingId: string }) => o.listingId === 'listing-maize-kano')).toHaveLength(1);
  });

  it('records chapter event RSVP and attendance', async () => {
    const rsvp = await post('/events/event-kano-meeting/rsvp', { userId: 'user-farmer-2' });
    expect(rsvp.status).toBe(201);
    const attendance = await post('/events/event-kano-meeting/attendance', { userId: 'user-farmer-2' });
    expect(attendance.status).toBe(201);
    const event = await (await fetch(`${base}/events/event-kano-meeting`)).json();
    expect(event.data.rsvpCount).toBe(1);
    expect(event.data.attendanceCount).toBe(1);
  });

  it('enforces notification channel preferences', async () => {
    const res = await post('/notifications/send', {
      userId: 'user-adamu',
      channel: 'whatsapp',
      title: 'Test',
      body: 'Disabled channel'
    });
    expect(res.status).toBe(400);

    const ok = await post('/notifications/send', {
      userId: 'user-adamu',
      channel: 'sms',
      title: 'Test',
      body: 'Enabled channel'
    });
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body.data.status).toBe('sent');
  });

  it('protects admin routes with RBAC', async () => {
    expect((await fetch(`${base}/admin/users`)).status).toBe(401);
    expect((await fetch(`${base}/admin/users`, { headers: { 'x-user-id': 'user-adamu' } })).status).toBe(403);
    const res = await fetch(`${base}/admin/users`, { headers: { 'x-user-id': 'user-admin' } });
    expect(res.status).toBe(200);
  });

  it('audits admin role changes and exposes the audit log', async () => {
    const res = await fetch(`${base}/admin/users/user-aisha/roles`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user-admin' },
      body: JSON.stringify({ roles: ['student', 'farmer'] })
    });
    expect(res.status).toBe(200);

    const audit = await (
      await fetch(`${base}/admin/audit?entityType=user`, { headers: { 'x-user-id': 'user-admin' } })
    ).json();
    expect(
      audit.data.some((e: { action: string; entityId: string }) =>
        e.action === 'admin.user.roles_updated' && e.entityId === 'user-aisha'
      )
    ).toBe(true);
  });

  it('searches across domains', async () => {
    const body = await (await fetch(`${base}/search?q=cassava`)).json();
    const types = new Set(body.data.map((r: { type: string }) => r.type));
    expect(types.has('course')).toBe(true);
    expect(types.has('listing')).toBe(true);
  });

  it('exports and deletes personal data (NDPR)', async () => {
    const exportRes = await fetch(`${base}/privacy/export/user-hassan`);
    const bundle = await exportRes.json();
    expect(bundle.data.user.id).toBe('user-hassan');
    expect(bundle.data.profile.userId).toBe('user-hassan');

    const request = await (await post('/privacy/delete/user-hassan', {})).json();
    expect(request.data.status).toBe('pending');
    const confirmed = await (
      await post(`/privacy/delete/requests/${request.data.id}/confirm`, {})
    ).json();
    expect(confirmed.data.status).toBe('completed');

    const anonymized = await (await fetch(`${base}/users/user-hassan`)).json();
    expect(anonymized.data.fullName).toBe('Deleted user');
  });

  it('serves the OpenAPI document', async () => {
    const res = await fetch(`${base}/docs-json`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.info.title).toBe('AgricPlatform API');
  });
});
