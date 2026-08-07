import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { WarehouseController } from './warehouse.controller.js';

/**
 * Auth-guard wiring checks (wave WAREHOUSE): the warehouse registry and
 * grading/issuance are admin-only, pledging is lender/admin, deposits and
 * receipt self-service accept the farmer role, and the audit export is
 * regulator/admin. RolesGuard enforces this metadata at runtime; here we pin
 * the per-route declarations.
 */
describe('WarehouseController auth metadata', () => {
  const reflector = new Reflector();

  it('warehouse administration routes are admin-only', () => {
    for (const method of ['registerWarehouse', 'refreshCertification'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, WarehouseController.prototype[method]);
      expect(roles, method).toEqual(['admin']);
    }
  });

  it('grading and receipt issuance are admin-only (warehouse operator)', () => {
    for (const method of ['gradeDeposit', 'issueReceipt'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, WarehouseController.prototype[method]);
      expect(roles, method).toEqual(['admin']);
    }
  });

  it('pledge routes require the lender or admin role', () => {
    for (const method of ['pledgeReceipt', 'releasePledge', 'myPledges'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, WarehouseController.prototype[method]);
      expect(roles, method).toEqual(['lender', 'admin']);
    }
  });

  it('farmer self-service routes accept the farmer role', () => {
    for (const method of ['createDeposit', 'myDeposits', 'myReceipts'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, WarehouseController.prototype[method]);
      expect(roles, method).toEqual(['farmer', 'admin']);
    }
  });

  it('the registry audit export is regulator/admin read-only', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, WarehouseController.prototype.exportRegistry);
    expect(roles).toEqual(['regulator', 'admin']);
  });

  it('every mutating or self-service route declares a role restriction', () => {
    const guarded = [
      'registerWarehouse',
      'refreshCertification',
      'createDeposit',
      'myDeposits',
      'getDeposit',
      'gradeDeposit',
      'issueReceipt',
      'myReceipts',
      'getReceipt',
      'receiptPledges',
      'receiptTransfers',
      'pledgeReceipt',
      'releasePledge',
      'transferReceipt',
      'redeemReceipt',
      'myPledges',
      'exportRegistry'
    ] as const;
    for (const method of guarded) {
      // @Authenticated() expands to Roles(...USER_ROLES), so every guarded
      // route must carry a non-empty ROLES_KEY declaration.
      const roles = reflector.get<string[]>(ROLES_KEY, WarehouseController.prototype[method]);
      expect(Array.isArray(roles) && roles.length > 0, method).toBe(true);
    }
  });
});
