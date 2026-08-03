import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { AgentBankingController } from './agent-banking.controller.js';

/**
 * Auth-guard wiring checks (wave AGENTBANK): administration is admin-only,
 * agent operations require the agent (or admin) role, and farmer
 * self-service accepts the farmer role. RolesGuard enforces this metadata
 * at runtime; here we pin the per-route declarations.
 */
describe('AgentBankingController auth metadata', () => {
  const reflector = new Reflector();

  it('agent administration routes are admin-only', () => {
    for (const method of [
      'register',
      'list',
      'setStatus',
      'setLimits',
      'topUps',
      'approveTopUp',
      'rejectTopUp',
      'settleTopUp'
    ] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, AgentBankingController.prototype[method]);
      expect(roles, method).toEqual(['admin']);
    }
  });

  it('money-movement routes require the agent or admin role', () => {
    for (const method of ['cashIn', 'cashOut', 'issueVoucher', 'requestTopUp'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, AgentBankingController.prototype[method]);
      expect(roles, method).toEqual(['agent', 'admin']);
    }
  });

  it('reporting routes require the agent or admin role', () => {
    for (const method of [
      'float',
      'transactions',
      'ownTopUps',
      'vouchers',
      'commissions',
      'reconciliation'
    ] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, AgentBankingController.prototype[method]);
      expect(roles, method).toEqual(['agent', 'admin']);
    }
  });

  it('voucher redemption accepts farmer self-service too', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, AgentBankingController.prototype.redeemVoucher);
    expect(roles).toEqual(['agent', 'farmer', 'admin']);
  });

  it('farmer transaction history is farmer self-service', () => {
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      AgentBankingController.prototype.farmerTransactions
    );
    expect(roles).toEqual(['farmer', 'admin']);
  });

  it('every controller route declares a role restriction', () => {
    const methods = Object.getOwnPropertyNames(AgentBankingController.prototype).filter(
      (name) => name !== 'constructor'
    );
    for (const method of methods) {
      const roles = reflector.get<string[]>(
        ROLES_KEY,
        AgentBankingController.prototype[method as keyof AgentBankingController]
      );
      expect(roles?.length, method).toBeGreaterThan(0);
    }
  });
});
