import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';

/**
 * Contract fuzz (FP-5): malformed identifiers, out-of-range numbers,
 * oversize strings and out-of-range scalars must be rejected with 400 at
 * the boundary — never accepted (state corruption) and never 500.
 */
describe('API contract fuzz (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;
  const admin = { 'x-user-id': 'user-admin' };
  const farmer = { 'x-user-id': 'user-adamu' };

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

  async function post(path: string, body: unknown, headers: Record<string, string>) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  }

  const validLoan = {
    applicantId: 'user-adamu',
    lenderId: 'lender-nyfn-coop',
    amountKobo: 5_000_000,
    termMonths: 6,
    annualRateBps: 1200
  };

  it('V-23: termMonths above the business ceiling is 400, the ceiling applies, absurd terms are 400', async () => {
    expect((await post('/finance/loans', { ...validLoan, termMonths: 1_000_000_000 }, farmer)).status).toBe(
      400
    );
    expect((await post('/finance/loans', { ...validLoan, termMonths: 121 }, farmer)).status).toBe(400);
    expect((await post('/finance/loans', { ...validLoan, termMonths: 0 }, farmer)).status).toBe(400);
    expect((await post('/finance/loans', { ...validLoan, termMonths: 6.5 }, farmer)).status).toBe(400);
    const ok = await post('/finance/loans', { ...validLoan, termMonths: 120 }, farmer);
    expect(ok.status).toBe(201);
  });

  it('L-12: datetime-shaped firstDueDate on disburse is 400 (not a 500 from the schedule lib)', async () => {
    const res = await post(
      '/finance/loans/loan-does-not-need-to-exist/disburse',
      { firstDueDate: '2026-09-01T10:00:00.000Z' },
      admin
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/YYYY-MM-DD/);
  });

  it('V-71: oversize strings in DTO fields are 400', async () => {
    const res = await post('/finance/loans', { ...validLoan, purpose: 'x'.repeat(600) }, farmer);
    expect(res.status).toBe(400);
  });

  it('L-13: absurd kobo amounts are 400 at money boundaries', async () => {
    // Loan application above the ₦1bn ceiling.
    expect(
      (await post('/finance/loans', { ...validLoan, amountKobo: 100_000_000_001 }, farmer)).status
    ).toBe(400);
    // Agent cash-out above the per-transaction ceiling (route needs an agent
    // id; validation fires before the handler).
    const cashOut = await post(
      '/agent-banking/agents/agent-1/cash-out',
      { farmerId: 'user-adamu', amountKobo: 10_000_000_000, otp: '1234', idempotencyKey: 'k-1' },
      admin
    );
    expect(cashOut.status).toBe(400);
  });

  it('NIN pattern: non-11-digit NIN at beneficiary verification is 400', async () => {
    const res = await post(
      '/input-vouchers/programmes/prog-1/beneficiaries',
      { farmerId: 'user-adamu', nin: '12345', fullName: 'Adamu Test' },
      admin
    );
    expect(res.status).toBe(400);
    // class-validator surfaces an array of messages.
    expect(JSON.stringify(await res.json())).toMatch(/nin/i);
  });

  it('L-15: out-of-range geo coordinates are 400', async () => {
    for (const query of ['lat=99999&long=4', 'lat=-91&long=4', 'lat=6&long=181', 'lat=abc&long=4']) {
      const res = await fetch(`${base}/geo-intel/flood-risk?${query}`, { headers: farmer });
      expect(res.status, query).toBe(400);
    }
    const ok = await fetch(`${base}/geo-intel/flood-risk?lat=6.5&long=3.4`, { headers: farmer });
    expect(ok.status).toBe(200);
  });

  it('V-72: admin user directory is a real page envelope (page 2 works)', async () => {
    const page1 = await (
      await fetch(`${base}/admin/users?page=1&pageSize=1`, { headers: admin })
    ).json();
    expect(page1.data.page).toBe(1);
    expect(page1.data.pageSize).toBe(1);
    expect(page1.data.total).toBeGreaterThan(1);
    expect(page1.data.data).toHaveLength(1);
    const page2 = await (
      await fetch(`${base}/admin/users?page=2&pageSize=1`, { headers: admin })
    ).json();
    expect(page2.data.page).toBe(2);
    expect(page2.data.data).toHaveLength(1);
    expect(page2.data.data[0].user.id).not.toBe(page1.data.data[0].user.id);
  });

  it('V-72: insurance admin directories return paginated envelopes', async () => {
    const triggerEvents = await (
      await fetch(`${base}/insurance/trigger-events/all?page=1&pageSize=5`, { headers: admin })
    ).json();
    expect(triggerEvents.data.page).toBe(1);
    expect(Array.isArray(triggerEvents.data.data)).toBe(true);
    const payouts = await (
      await fetch(`${base}/insurance/payouts/all?page=1&pageSize=5`, { headers: admin })
    ).json();
    expect(payouts.data.page).toBe(1);
  });

  it('V-79: redrive of a missing/non-dead-lettered outbox row is 404 (admin route exists)', async () => {
    const res = await fetch(`${base}/admin/outbox/dead-letters/event-missing/redrive`, {
      method: 'POST',
      headers: admin
    });
    expect(res.status).toBe(404);
  });

  it('V-74: unknown body fields are rejected outright (forbidNonWhitelisted)', async () => {
    const res = await post('/finance/loans', { ...validLoan, hackerField: 'evil' }, farmer);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('hackerField');
  });
});
