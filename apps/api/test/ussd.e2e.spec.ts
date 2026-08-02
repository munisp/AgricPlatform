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
    booted = await boot({ USSD_DRIVER: undefined, AT_API_KEY: undefined, AT_USERNAME: undefined });
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
      AT_USERNAME: 'sandbox'
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
});
