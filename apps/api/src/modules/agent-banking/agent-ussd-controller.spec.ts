import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUssdController } from './agent-banking.controller.js';
import type { AgentUssdService } from './agent-ussd.service.js';

/**
 * V-19 callback parity: the agent-banking USSD callback applies the same
 * resolveAtCallbackToken + assertAtCallbackFreshness gates as the USSD/IVR
 * channels — header-only token in production and per-request
 * timestamp/nonce freshness.
 */

// Meets the Stage-24 production strength floor (>= 32 chars, not a placeholder).
const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';
const PROD_ENV = { NODE_ENV: 'production', AT_CALLBACK_TOKEN: STRONG_TOKEN };

function makeController() {
  const ussd = {
    driverConfig: { enabled: true },
    handleCallback: vi.fn().mockResolvedValue('CON Main menu')
  };
  const controller = new AgentUssdController(ussd as unknown as AgentUssdService);
  return { controller, ussd };
}

const dto = { sessionId: 'sess-1', phoneNumber: '+2348012345678', text: '' };

describe('AgentUssdController callback (V-19 parity)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', PROD_ENV.NODE_ENV);
    vi.stubEnv('AT_CALLBACK_TOKEN', PROD_ENV.AT_CALLBACK_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a query-string token in production even when it is correct', async () => {
    const { controller, ussd } = makeController();
    await expect(
      controller.callback(dto, STRONG_TOKEN, undefined, String(Date.now()), 'nonce-query-1')
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      controller.callback(dto, STRONG_TOKEN, undefined, String(Date.now()), 'nonce-query-2')
    ).rejects.toThrow('Refusing query-string callback token in production');
    expect(ussd.handleCallback).not.toHaveBeenCalled();
  });

  it('enforces freshness in production: missing timestamp/nonce is refused', async () => {
    const { controller, ussd } = makeController();
    await expect(controller.callback(dto, undefined, STRONG_TOKEN)).rejects.toThrow(
      UnauthorizedException
    );
    await expect(
      controller.callback(dto, undefined, STRONG_TOKEN, String(Date.now()), undefined)
    ).rejects.toThrow('nonce');
    expect(ussd.handleCallback).not.toHaveBeenCalled();
  });

  it('refuses a replayed nonce in production', async () => {
    const { controller } = makeController();
    const timestamp = String(Date.now());
    await expect(
      controller.callback(dto, undefined, STRONG_TOKEN, timestamp, 'nonce-replay-1')
    ).resolves.toBe('CON Main menu');
    await expect(
      controller.callback(dto, undefined, STRONG_TOKEN, timestamp, 'nonce-replay-1')
    ).rejects.toThrow('replay refused');
  });

  it('refuses a stale timestamp in production', async () => {
    const { controller } = makeController();
    const stale = String(Date.now() - 10 * 60 * 1000);
    await expect(
      controller.callback(dto, undefined, STRONG_TOKEN, stale, 'nonce-stale-1')
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts the header token with a fresh timestamp/nonce in production', async () => {
    const { controller, ussd } = makeController();
    await expect(
      controller.callback(dto, undefined, STRONG_TOKEN, String(Date.now()), 'nonce-fresh-1')
    ).resolves.toBe('CON Main menu');
    expect(ussd.handleCallback).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      phoneNumber: '+2348012345678',
      text: ''
    });
  });

  it('keeps the query-param fallback outside production (dev/test posture)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { controller, ussd } = makeController();
    await expect(controller.callback(dto, STRONG_TOKEN, undefined)).resolves.toBe('CON Main menu');
    expect(ussd.handleCallback).toHaveBeenCalledTimes(1);
  });
});
