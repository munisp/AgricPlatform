import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { FEATURE_FLAG_KEY } from '../../common/feature-flags/feature-flag.decorator.js';
import { DEALER_QR_PAY_FLAG } from './dealer-qr.service.js';
import { DealerQrController, DealerQrWebhookController } from './dealer-qr.controller.js';

/**
 * Auth/flag wiring checks (Stage 27, Innovation 16): the dealer surface is
 * role-scoped per route and flag-gated behind `dealer-qr-pay`
 * (FeatureFlagGuard fails closed with 404 when off); the switch webhook is
 * unauthenticated-by-user (token + live-driver fulfilment verification
 * instead) but still flag-gated. The guards enforce this at runtime; here
 * we pin the declarations.
 */
describe('DealerQrController auth + flag metadata', () => {
  const reflector = new Reflector();

  it('the whole dealer surface is gated behind the dealer-qr-pay flag', () => {
    expect(reflector.get<string>(FEATURE_FLAG_KEY, DealerQrController)).toBe(DEALER_QR_PAY_FLAG);
    expect(reflector.get<string>(FEATURE_FLAG_KEY, DealerQrWebhookController)).toBe(DEALER_QR_PAY_FLAG);
    expect(DEALER_QR_PAY_FLAG).toBe('dealer-qr-pay');
  });

  it('QR issuance/listing is dealer-or-admin; pay/read include the farmer', () => {
    const expected: Record<string, string[]> = {
      issueQr: ['agent', 'admin'],
      listQr: ['agent', 'admin'],
      pay: ['farmer', 'agent', 'admin'],
      payment: ['farmer', 'agent', 'admin'],
      confirm: ['admin']
    };
    for (const [method, roles] of Object.entries(expected)) {
      const declared = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
        DealerQrController.prototype[method as keyof DealerQrController],
        DealerQrController
      ]);
      expect(declared, method).toEqual(roles);
    }
  });

  it('the confirmation poller route is admin-only', () => {
    const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      DealerQrController.prototype.confirm,
      DealerQrController
    ]);
    expect(roles).toEqual(['admin']);
  });
});
