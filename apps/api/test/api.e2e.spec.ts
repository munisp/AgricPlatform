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
    // In-memory persistence mode reports both stores as disabled (plan §8).
    expect(ready.persistence).toEqual({ database: 'disabled', redis: 'disabled' });
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
    const headers = { 'idempotency-key': 'e2e-order-1', 'x-user-id': 'user-buyer' };
    const first = await post('/listings/listing-maize-kano/orders', payload, headers);
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await post('/listings/listing-maize-kano/orders', payload, headers);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    const replayBody = await replay.json();
    expect(replayBody.data.id).toBe(firstBody.data.id);

    const orders = await (
      await fetch(`${base}/orders?buyerId=user-buyer`, { headers: { 'x-user-id': 'user-buyer' } })
    ).json();
    expect(orders.data.filter((o: { listingId: string }) => o.listingId === 'listing-maize-kano')).toHaveLength(1);
  });

  it('records chapter event RSVP and attendance', async () => {
    const anonymous = await post('/events/event-kano-meeting/rsvp', { userId: 'user-farmer-2' });
    expect(anonymous.status).toBe(401);
    const rsvp = await post(
      '/events/event-kano-meeting/rsvp',
      { userId: 'user-farmer-2' },
      { 'x-user-id': 'user-farmer-2' }
    );
    expect(rsvp.status).toBe(201);
    // Attendance is checked in by a chapter lead/admin, not the attendee.
    const selfCheckIn = await post(
      '/events/event-kano-meeting/attendance',
      { userId: 'user-farmer-2' },
      { 'x-user-id': 'user-farmer-2' }
    );
    expect(selfCheckIn.status).toBe(403);
    const attendance = await post(
      '/events/event-kano-meeting/attendance',
      { userId: 'user-farmer-2' },
      { 'x-user-id': 'user-lead-kaduna' }
    );
    expect(attendance.status).toBe(201);
    const event = await (await fetch(`${base}/events/event-kano-meeting`)).json();
    expect(event.data.rsvpCount).toBe(1);
    expect(event.data.attendanceCount).toBe(1);
  });

  it('enforces notification channel preferences', async () => {
    const auth = { 'x-user-id': 'user-adamu' };
    const res = await post(
      '/notifications/send',
      { userId: 'user-adamu', channel: 'whatsapp', title: 'Test', body: 'Disabled channel' },
      auth
    );
    expect(res.status).toBe(400);

    const ok = await post(
      '/notifications/send',
      { userId: 'user-adamu', channel: 'sms', title: 'Test', body: 'Enabled channel' },
      auth
    );
    expect(ok.status).toBe(201);
    const body = await ok.json();
    // The stub SMS driver no longer fabricates delivery: the message stays
    // failed/pending for the retry machinery instead of a false 'sent'.
    expect(body.data.status).toBe('failed');
  });

  it('restricts notifications to the owning user or admin', async () => {
    // Anonymous callers are rejected.
    expect(
      (await post('/notifications/send', { userId: 'user-adamu', channel: 'sms', title: 'T', body: 'B' }))
        .status
    ).toBe(401);
    // A different authenticated user cannot send as or read someone else.
    expect(
      (
        await post(
          '/notifications/send',
          { userId: 'user-adamu', channel: 'sms', title: 'T', body: 'B' },
          { 'x-user-id': 'user-aisha' }
        )
      ).status
    ).toBe(403);
    expect(
      (await fetch(`${base}/notifications/preferences/user-adamu`, { headers: { 'x-user-id': 'user-aisha' } }))
        .status
    ).toBe(403);
    // The delivery log is admin-only.
    expect(
      (await fetch(`${base}/notifications/deliveries`, { headers: { 'x-user-id': 'user-adamu' } })).status
    ).toBe(403);
    expect(
      (await fetch(`${base}/notifications/deliveries`, { headers: { 'x-user-id': 'user-admin' } })).status
    ).toBe(200);
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
    const owner = { 'x-user-id': 'user-hassan' };
    // Privacy records require the data subject or an admin.
    expect((await fetch(`${base}/privacy/export/user-hassan`)).status).toBe(401);
    expect(
      (await fetch(`${base}/privacy/export/user-hassan`, { headers: { 'x-user-id': 'user-aisha' } })).status
    ).toBe(403);

    const exportRes = await fetch(`${base}/privacy/export/user-hassan`, { headers: owner });
    const bundle = await exportRes.json();
    expect(bundle.data.user.id).toBe('user-hassan');
    expect(bundle.data.profile.userId).toBe('user-hassan');

    const request = await (await post('/privacy/delete/user-hassan', {}, owner)).json();
    expect(request.data.status).toBe('pending');
    const confirmed = await (
      await post(`/privacy/delete/requests/${request.data.id}/confirm`, {}, owner)
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

  it('serves Prometheus metrics under the api/v1 prefix', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('service="agric-api"');
  });

  it('labels http metrics with parameterized routes (low cardinality)', async () => {
    // Concrete IDs must never appear in the `route` label.
    await fetch(`${base}/profiles/user-admin`);
    await fetch(`${base}/profiles/user-aisha`);

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('route="/api/v1/profiles/:userId"');
    expect(text).not.toContain('route="/api/v1/profiles/user-admin"');
    expect(text).not.toContain('route="/api/v1/profiles/user-aisha"');
    // The 'unmatched' fallback itself is covered by the interceptor unit test
    // (Express 404s for unknown paths bypass Nest interceptors).
  });

  it('propagates x-request-id onto responses and error envelopes', async () => {
    const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'e2e-req-123' } });
    expect(res.headers.get('x-request-id')).toBe('e2e-req-123');

    const err = await fetch(`${base}/admin/users`, {
      headers: { 'x-request-id': 'e2e-req-123' }
    });
    expect(err.status).toBe(401);
    const body = await err.json();
    expect(body.requestId).toBe('e2e-req-123');

    // A generated id is returned when the client sends none.
    const generated = await fetch(`${base}/health`);
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports readiness dependencies via the indicator registry', async () => {
    const ready = await (await fetch(`${base}/health/ready`)).json();
    expect(Array.isArray(ready.dependencies)).toBe(true);
    const byName = new Map(
      ready.dependencies.map((d: { name: string; status: string }) => [d.name, d.status])
    );
    // In-memory mode: persistence drivers are unconfigured -> skipped, and
    // skipped never degrades readiness (plan §A.5).
    expect(byName.get('database')).toBe('skipped');
    expect(byName.get('redis')).toBe('skipped');
    expect(ready.status).toBe('ok');
    expect(ready.persistence).toEqual({ database: 'disabled', redis: 'disabled' });
  });

  it('verifies the audit hash chain via the admin endpoint', async () => {
    expect(
      (await fetch(`${base}/admin/audit-log/verify`, { headers: { 'x-user-id': 'user-adamu' } })).status
    ).toBe(403);
    const res = await fetch(`${base}/admin/audit-log/verify`, {
      headers: { 'x-user-id': 'user-admin' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.valid).toBe(true);
  });

  it('exposes per-user "mine" list endpoints scoped to the caller', async () => {
    const auth = { 'x-user-id': 'user-aisha' };
    // Anonymous callers are rejected on every /mine route.
    expect((await fetch(`${base}/service-bookings/mine`)).status).toBe(401);
    expect((await fetch(`${base}/pathway-enrolments/mine`)).status).toBe(401);
    expect((await fetch(`${base}/programme-cohorts/mine`)).status).toBe(401);
    expect((await fetch(`${base}/webinars/mine/registrations`)).status).toBe(401);

    // Authenticated callers get their own (possibly empty) lists — the 'mine'
    // routes must not be swallowed by the sibling `:id` routes.
    for (const path of [
      '/service-bookings/mine',
      '/pathway-enrolments/mine',
      '/programme-cohorts/mine',
      '/webinars/mine/registrations'
    ]) {
      const res = await fetch(`${base}${path}`, { headers: auth });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
    }

    // The status filter is validated.
    expect(
      (await fetch(`${base}/service-bookings/mine?status=bogus`, { headers: auth })).status
    ).toBe(400);
  });

  it('counts domain events on the metrics endpoint', async () => {
    // OTP request + failed verification.
    const otp = await (
      await post('/auth/otp/request', { phone: '+2348010000001' })
    ).json();
    expect(otp.data.requestId).toBeTruthy();
    await post('/auth/otp/verify', { requestId: otp.data.requestId, code: '000000' });

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('agric_otp_requests_total{channel="sms"');
    expect(text).toContain('agric_otp_verifications_total{result="invalid"');
    expect(text).toContain('agric_idempotent_replays_total');
    expect(text).toContain('agric_errors_5xx_total');
  });

  // Funds-integrity wave: the financial read endpoints used to be
  // unauthenticated, and borrowers could mark their own installments paid.
  describe('funds-integrity hardening', () => {
    async function patch(path: string, body: unknown, headers: Record<string, string> = {}) {
      return fetch(`${base}${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
      });
    }

    it('rejects unauthenticated financial reads (401) and non-party reads (403)', async () => {
      // Order reads require authentication now.
      expect((await fetch(`${base}/orders`)).status).toBe(401);
      expect((await fetch(`${base}/orders/order-buyer-cassava`)).status).toBe(401);
      expect((await fetch(`${base}/orders/order-buyer-cassava/escrow`)).status).toBe(401);
      expect((await fetch(`${base}/orders/order-buyer-cassava/shipment`)).status).toBe(401);
      // A non-party authenticated user gets 403, the buyer gets 200.
      expect(
        (await fetch(`${base}/orders/order-buyer-cassava`, { headers: { 'x-user-id': 'user-aisha' } })).status
      ).toBe(403);
      expect(
        (await fetch(`${base}/orders/order-buyer-cassava`, { headers: { 'x-user-id': 'user-buyer' } })).status
      ).toBe(200);
      // Listing reads stay public (catalogue browsing).
      expect((await fetch(`${base}/listings/listing-maize-kano`)).status).toBe(200);
    });

    it('blocks borrower self-pay and honors the declare → confirm flow', async () => {
      const borrower = { 'x-user-id': 'user-adamu' };
      const admin = { 'x-user-id': 'user-admin' };
      // Apply → submit → review → approve.
      const applied = await (
        await post(
          '/finance/loans',
          {
            applicantId: 'user-adamu',
            lenderId: 'lender-nyfn-coop',
            amountKobo: 5_000_000,
            termMonths: 2,
            annualRateBps: 0
          },
          borrower
        )
      ).json();
      const loanId = applied.data.id as string;
      await patch(`/finance/loans/${loanId}/status`, { status: 'submitted' }, borrower);
      await patch(`/finance/loans/${loanId}/status`, { status: 'under_review' }, admin);
      await patch(`/finance/loans/${loanId}/status`, { status: 'approved' }, admin);

      // Disbursement requires a funded platform cash account (solvency).
      const underfunded = await post(`/finance/loans/${loanId}/disburse`, {}, admin);
      expect(underfunded.status).toBe(400);
      await post('/finance/ledger/accounts', { code: 'platform:cash', type: 'asset' }, admin);
      await post('/finance/ledger/accounts', { code: 'platform:funding', type: 'liability' }, admin);
      const funding = await post(
        '/finance/ledger/entries',
        {
          idempotencyKey: 'e2e-platform-funding-1',
          description: 'Lender funding',
          postings: [
            { accountCode: 'platform:cash', direction: 'debit', amountKobo: 5_000_000 },
            { accountCode: 'platform:funding', direction: 'credit', amountKobo: 5_000_000 }
          ]
        },
        admin
      );
      expect(funding.status).toBe(201);
      const disbursed = await post(`/finance/loans/${loanId}/disburse`, {}, admin);
      expect(disbursed.status).toBe(201);

      // CRIT-1: the borrower can no longer mark their own installment paid.
      const selfPay = await post(`/finance/loans/${loanId}/installments/1/pay`, {}, borrower);
      expect(selfPay.status).toBe(403);
      // The borrower declares the payment with a verifiable reference instead.
      const declared = await post(
        `/finance/loans/${loanId}/installments/1/declare-payment`,
        { paymentReference: 'paystack:e2e-ref-1' },
        borrower
      );
      expect(declared.status).toBe(201);
      expect((await declared.json()).data.status).toBe('declared');
      // A declaration without a reference is rejected.
      expect(
        (await post(`/finance/loans/${loanId}/installments/2/declare-payment`, {}, borrower)).status
      ).toBe(400);
      // Lender-side confirmation (admin) marks it paid with the reference.
      const confirmed = await post(`/finance/loans/${loanId}/installments/1/pay`, {}, admin);
      expect(confirmed.status).toBe(201);
      const confirmedBody = await confirmed.json();
      expect(confirmedBody.data.status).toBe('paid');
      expect(confirmedBody.data.paymentReference).toBe('paystack:e2e-ref-1');
      // Confirming the second installment closes the two-installment loan.
      await post(`/finance/loans/${loanId}/installments/2/pay`, {}, admin);
      const loan = await (
        await fetch(`${base}/finance/loans/${loanId}`, { headers: borrower })
      ).json();
      expect(loan.data.status).toBe('closed');
    });
  });
});
