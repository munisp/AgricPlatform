import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { InputVouchersController } from './input-vouchers.controller.js';

/**
 * Auth-guard wiring checks (wave NINVOUCHER): programme administration and
 * voucher governance are admin-only, redemption requires the supplier
 * (agro-dealer) or admin role, farmer self-service accepts the farmer role,
 * and reports/exports accept regulator + donor. RolesGuard enforces this
 * metadata at runtime; here we pin the per-route declarations.
 */
describe('InputVouchersController auth metadata', () => {
  const reflector = new Reflector();

  it('programme administration routes are admin-only', () => {
    for (const method of [
      'createProgramme',
      'activateProgramme',
      'closeProgramme',
      'verifyBeneficiary',
      'listBeneficiaries',
      'allocateVoucher',
      'distributeVoucher',
      'voidVoucher',
      'expireVoucher',
      'identityStatus'
    ] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, InputVouchersController.prototype[method]);
      expect(roles, method).toEqual(['admin']);
    }
  });

  it('report/export routes accept admin, regulator and donor', () => {
    for (const method of ['listProgrammes', 'getProgramme', 'listProgrammeVouchers', 'reconciliation'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, InputVouchersController.prototype[method]);
      expect(roles, method).toEqual(['admin', 'regulator', 'donor']);
    }
  });

  it('redemption requires the supplier (agro-dealer) or admin role', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, InputVouchersController.prototype.redeemVoucher);
    expect(roles).toEqual(['supplier', 'admin']);
  });

  it('farmer voucher history is farmer self-service', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, InputVouchersController.prototype.farmerVouchers);
    expect(roles).toEqual(['farmer', 'admin']);
  });

  it('voucher detail accepts farmer, supplier and reviewers', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, InputVouchersController.prototype.getVoucher);
    expect(roles).toEqual(['farmer', 'supplier', 'admin', 'regulator', 'donor']);
  });

  it('every controller route declares a role restriction', () => {
    const methods = Object.getOwnPropertyNames(InputVouchersController.prototype).filter(
      (name) => name !== 'constructor'
    );
    for (const method of methods) {
      const roles = reflector.get<string[]>(
        ROLES_KEY,
        InputVouchersController.prototype[method as keyof InputVouchersController]
      );
      expect(roles?.length, method).toBeGreaterThan(0);
    }
  });
});
