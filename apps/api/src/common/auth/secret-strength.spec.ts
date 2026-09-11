import { describe, expect, it } from 'vitest';
import {
  assertProductionSecretStrength,
  PRODUCTION_HMAC_SECRET_MIN_LENGTH
} from './auth.config.js';
import {
  DEV_VOUCHER_SECRET,
  resolveVoucherSecret
} from '../../modules/agent-banking/voucher-crypto.js';
import { DEV_NIN_HASH_SALT, resolveNinHashSalt } from '../../modules/input-vouchers/nin-crypto.js';
import {
  DEV_RECEIPT_SECRET,
  resolveReceiptSecret
} from '../../modules/warehouse/receipt-crypto.js';
import {
  DEV_PASSPORT_CODE_SECRET,
  resolvePassportCodeSecret
} from '../../modules/livestock-passport/passport-code.js';
import {
  DEV_ATTENDANCE_SECRET,
  resolveAttendanceSecret
} from '../../config/attendance.config.js';
import {
  DEV_VET_SIGNING_SECRET,
  resolveVetSigningSecret
} from '../../config/livestock-health.config.js';

/**
 * Permanent regression specs for audit A3-2 / A3-3 (adopted from the
 * auditor's red tests): in production an explicitly configured HMAC secret
 * must be REJECTED when it equals the published development default (zero
 * entropy — committed in this repo), and every HMAC secret enforces a
 * >= 32-char floor ('x' was previously accepted for AGENT_VOUCHER_SECRET,
 * NIN_HASH_SALT and WAREHOUSE_RECEIPT_SECRET).
 */

const STRONG = 's'.repeat(PRODUCTION_HMAC_SECRET_MIN_LENGTH); // exactly at the floor
const JUST_UNDER = 's'.repeat(PRODUCTION_HMAC_SECRET_MIN_LENGTH - 1);

const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

describe('assertProductionSecretStrength', () => {
  it('is a no-op outside production', () => {
    expect(() =>
      assertProductionSecretStrength({ NODE_ENV: 'development' }, 'ANY_SECRET')
    ).not.toThrow();
  });

  it('throws in production when the variable is unset (required by default)', () => {
    expect(() => assertProductionSecretStrength(PROD, 'ANY_SECRET')).toThrow(/ANY_SECRET/);
  });

  it('allows an unset variable when required=false, but strength-checks a set one', () => {
    expect(() =>
      assertProductionSecretStrength(PROD, 'ANY_SECRET', { required: false })
    ).not.toThrow();
    expect(() =>
      assertProductionSecretStrength({ ...PROD, ANY_SECRET: 'x' }, 'ANY_SECRET', {
        required: false,
        minLength: 16
      })
    ).toThrow(/ANY_SECRET/);
  });

  it('rejects published development defaults regardless of length', () => {
    expect(() =>
      assertProductionSecretStrength({ ...PROD, ANY_SECRET: 'a'.repeat(64) }, 'ANY_SECRET', {
        minLength: 16,
        publishedDefaults: ['a'.repeat(64)]
      })
    ).toThrow(/PUBLISHED development default/);
  });

  it('enforces the length floor at the exact boundary', () => {
    expect(() =>
      assertProductionSecretStrength({ ...PROD, ANY_SECRET: 'b'.repeat(15) }, 'ANY_SECRET', {
        minLength: 16
      })
    ).toThrow(/at least 16 characters/);
    expect(() =>
      assertProductionSecretStrength({ ...PROD, ANY_SECRET: 'b'.repeat(16) }, 'ANY_SECRET', {
        minLength: 16
      })
    ).not.toThrow();
  });
});

describe('A3-2/A3-3 — HMAC secret resolvers fail closed in production', () => {
  const cases: ReadonlyArray<{
    name: string;
    envKey: string;
    devDefault: string;
    resolve: (env: NodeJS.ProcessEnv) => string;
  }> = [
    {
      name: 'resolveVoucherSecret',
      envKey: 'AGENT_VOUCHER_SECRET',
      devDefault: DEV_VOUCHER_SECRET,
      resolve: resolveVoucherSecret
    },
    {
      name: 'resolveNinHashSalt',
      envKey: 'NIN_HASH_SALT',
      devDefault: DEV_NIN_HASH_SALT,
      resolve: resolveNinHashSalt
    },
    {
      name: 'resolveReceiptSecret',
      envKey: 'WAREHOUSE_RECEIPT_SECRET',
      devDefault: DEV_RECEIPT_SECRET,
      resolve: resolveReceiptSecret
    },
    {
      name: 'resolvePassportCodeSecret',
      envKey: 'LIVESTOCK_PASSPORT_SECRET',
      devDefault: DEV_PASSPORT_CODE_SECRET,
      resolve: resolvePassportCodeSecret
    },
    {
      name: 'resolveAttendanceSecret',
      envKey: 'ATTENDANCE_SIGNING_SECRET',
      devDefault: DEV_ATTENDANCE_SECRET,
      resolve: resolveAttendanceSecret
    },
    {
      name: 'resolveVetSigningSecret',
      envKey: 'VET_SIGNING_SECRET',
      devDefault: DEV_VET_SIGNING_SECRET,
      resolve: resolveVetSigningSecret
    }
  ];

  for (const { name, envKey, devDefault, resolve } of cases) {
    describe(name, () => {
      it('rejects the published development default when explicitly set in production', () => {
        expect(() => resolve({ ...PROD, [envKey]: devDefault })).toThrow(
          /PUBLISHED development default/
        );
      });

      it('rejects a 1-character secret in production', () => {
        expect(() => resolve({ ...PROD, [envKey]: 'x' })).toThrow(new RegExp(envKey));
      });

      it('rejects a 31-character secret in production (floor boundary)', () => {
        expect(() => resolve({ ...PROD, [envKey]: JUST_UNDER })).toThrow(new RegExp(envKey));
      });

      it('accepts a 32-character high-entropy secret in production', () => {
        expect(resolve({ ...PROD, [envKey]: STRONG })).toBe(STRONG);
      });

      it('still fails closed when unset in production', () => {
        expect(() => resolve(PROD)).toThrow(new RegExp(envKey));
      });

      it('keeps the labelled dev default outside production', () => {
        expect(resolve({ NODE_ENV: 'development' })).toBe(devDefault);
      });

      it('accepts the dev default outside production without throwing', () => {
        expect(() =>
          resolve({ NODE_ENV: 'development', [envKey]: devDefault })
        ).not.toThrow();
      });
    });
  }
});
