import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { USSD_MAX_RESPONSE_CHARS } from '../src/modules/ussd/menu-engine.js';

/**
 * USSD channel end-to-end over the real HTTP layer (wave P6b gap 4):
 * Africa's Talking form-encoded callbacks to POST /api/v1/ussd/callback.
 * Suite one proves the endpoint is fail-closed (404) while the driver is a
 * stub; suite two boots with USSD_DRIVER=sandbox + dummy AT credentials and
 * walks a full registration session, asserting CON/END prefixes and the
 * 182-char turnaround cap (including the prefix) on every response.
 */

interface Booted {
  app: NestExpressApplication;
  base: string;
}

async function boot(env: Record<string, string | undefined>): Promise<Booted> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${address.port}/api/v1` };
}

async function ussdTurn(
  base: string,
  input: { sessionId: string; phoneNumber: string; text?: string }
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/ussd/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      sessionId: input.sessionId,
      phoneNumber: input.phoneNumber,
      text: input.text ?? ''
    }).toString()
  });
  return { status: res.status, body: await res.text() };
}

describe('USSD callback (e2e, driver stub)', () => {
  let booted: Booted;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    booted = await boot({
      USSD_DRIVER: undefined,
      AT_API_KEY: undefined,
      AT_USERNAME: undefined,
      AT_CALLBACK_TOKEN: undefined,
      AT_CALLBACK_IP_ALLOWLIST: undefined
    });
  });

  afterAll(async () => {
    await booted.app.close();
    process.env = { ...savedEnv };
  });

  it('answers 404 while the USSD driver is a stub', async () => {
    const res = await ussdTurn(booted.base, {
      sessionId: 'sess-stub',
      phoneNumber: '+234810000001',
      text: ''
    });
    expect(res.status).toBe(404);
  });
});

describe('USSD callback (e2e, sandbox driver)', () => {
  let booted: Booted;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    booted = await boot({
      USSD_DRIVER: 'sandbox',
      AT_API_KEY: 'atsk_test_dummy',
      AT_USERNAME: 'sandbox',
      AT_CALLBACK_TOKEN: undefined,
      AT_CALLBACK_IP_ALLOWLIST: undefined
    });
  });

  afterAll(async () => {
    await booted.app.close();
    process.env = { ...savedEnv };
  });

  it('walks a registration session with CON/END prefixes under the 182-char cap', async () => {
    const sessionId = 'sess-e2e-1';
    const phoneNumber = '+234810000002';

    const expectPrefix = (body: string, prefix: 'CON' | 'END') => {
      expect(body.startsWith(`${prefix} `)).toBe(true);
      expect(body.length).toBeLessThanOrEqual(USSD_MAX_RESPONSE_CHARS);
    };

    // Opening dial: main menu continues the session.
    const open = await ussdTurn(booted.base, { sessionId, phoneNumber, text: '' });
    expect(open.status).toBe(200);
    expectPrefix(open.body, 'CON');
    expect(open.body).toContain('Register');

    // Turn 1: choose Register -> name prompt.
    const name = await ussdTurn(booted.base, { sessionId, phoneNumber, text: '1' });
    expect(name.status).toBe(200);
    expectPrefix(name.body, 'CON');
    expect(name.body).toContain('full name');

    // Turn 2: name -> state prompt (cumulative text, AT style).
    const state = await ussdTurn(booted.base, {
      sessionId,
      phoneNumber,
      text: '1*Amina Yusuf'
    });
    expectPrefix(state.body, 'CON');
    expect(state.body).toContain('state');

    // Turn 3: state -> role prompt.
    const role = await ussdTurn(booted.base, {
      sessionId,
      phoneNumber,
      text: '1*Amina Yusuf*Kano'
    });
    expectPrefix(role.body, 'CON');
    expect(role.body).toContain('Farmer');

    // Turn 4: role -> registration completes and the session ends.
    const done = await ussdTurn(booted.base, {
      sessionId,
      phoneNumber,
      text: '1*Amina Yusuf*Kano*1'
    });
    expect(done.status).toBe(200);
    expectPrefix(done.body, 'END');
    expect(done.body).toContain('Registration complete');
  });

  it('replays the same cumulative text idempotently within a session', async () => {
    const sessionId = 'sess-e2e-2';
    const phoneNumber = '+234810000003';
    const first = await ussdTurn(booted.base, { sessionId, phoneNumber, text: '1' });
    const replay = await ussdTurn(booted.base, { sessionId, phoneNumber, text: '1' });
    expect(replay.status).toBe(200);
    expect(replay.body).toBe(first.body);
  });

  it('rejects a mid-session phone-number change (audit C2-3)', async () => {
    const sessionId = 'sess-e2e-3';
    const phoneNumber = '+234810000004';
    const open = await ussdTurn(booted.base, { sessionId, phoneNumber, text: '' });
    expect(open.status).toBe(200);
    const hijack = await ussdTurn(booted.base, {
      sessionId,
      phoneNumber: '+234819999999',
      text: '1'
    });
    expect(hijack.status).toBe(401);
    // The original phone still owns the session.
    const next = await ussdTurn(booted.base, { sessionId, phoneNumber, text: '1' });
    expect(next.status).toBe(200);
    expect(next.body.startsWith('CON ')).toBe(true);
  });
});

describe('USSD callback token gate (e2e, audit C2-3)', () => {
  let booted: Booted;
  const savedEnv = { ...process.env };
  const TOKEN = 'e2e-callback-secret';

  beforeAll(async () => {
    booted = await boot({
      USSD_DRIVER: 'sandbox',
      AT_API_KEY: 'atsk_test_dummy',
      AT_USERNAME: 'sandbox',
      AT_CALLBACK_TOKEN: TOKEN,
      AT_CALLBACK_IP_ALLOWLIST: undefined
    });
  });

  afterAll(async () => {
    await booted.app.close();
    process.env = { ...savedEnv };
  });

  it('answers 401 without a token and with a wrong token', async () => {
    const missing = await ussdTurn(booted.base, {
      sessionId: 'sess-tok-1',
      phoneNumber: '+234810000010',
      text: ''
    });
    expect(missing.status).toBe(401);

    const res = await fetch(`${booted.base}/ussd/callback?token=wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        sessionId: 'sess-tok-1',
        phoneNumber: '+234810000010',
        text: ''
      }).toString()
    });
    expect(res.status).toBe(401);
  });

  it('serves the callback when the token arrives as a query param or header', async () => {
    const viaQuery = await fetch(`${booted.base}/ussd/callback?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        sessionId: 'sess-tok-2',
        phoneNumber: '+234810000011',
        text: ''
      }).toString()
    });
    expect(viaQuery.status).toBe(200);
    expect((await viaQuery.text()).startsWith('CON ')).toBe(true);

    const viaHeader = await fetch(`${booted.base}/ussd/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-at-callback-token': TOKEN
      },
      body: new URLSearchParams({
        sessionId: 'sess-tok-3',
        phoneNumber: '+234810000012',
        text: ''
      }).toString()
    });
    expect(viaHeader.status).toBe(200);
  });
});

describe('USSD callback IP allowlist (e2e, audit C2-3)', () => {
  let booted: Booted;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    booted = await boot({
      USSD_DRIVER: 'sandbox',
      AT_API_KEY: 'atsk_test_dummy',
      AT_USERNAME: 'sandbox',
      AT_CALLBACK_TOKEN: undefined,
      AT_CALLBACK_IP_ALLOWLIST: '203.0.113.9' // not the loopback test client
    });
  });

  afterAll(async () => {
    await booted.app.close();
    process.env = { ...savedEnv };
  });

  it('answers 403 for callers outside the allowlist', async () => {
    const res = await ussdTurn(booted.base, {
      sessionId: 'sess-ip-1',
      phoneNumber: '+234810000020',
      text: ''
    });
    expect(res.status).toBe(403);
  });
});
