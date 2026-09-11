import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { FEATURE_FLAG_KEY } from '../../common/feature-flags/feature-flag.decorator.js';
import {
  LtvGuardianController,
  WHR_LTV_GUARDIAN_FLAG
} from './ltv-guardian.controller.js';

/**
 * Route wiring checks (Stage 27 / Innovation 8): every LTV-guardian route is
 * behind the whr-ltv-guardian feature flag (default OFF, fail-closed 404)
 * and mutating routes carry role metadata for the RolesGuard.
 */
describe('LtvGuardianController route metadata', () => {
  const reflector = new Reflector();

  it('pins the whr-ltv-guardian feature flag on every route', () => {
    for (const method of ['attachMonitor', 'getPosition', 'runEvaluation'] as const) {
      const flag = reflector.get<string>(FEATURE_FLAG_KEY, LtvGuardianController.prototype[method]);
      expect(flag, method).toBe(WHR_LTV_GUARDIAN_FLAG);
      expect(flag, method).toBe('whr-ltv-guardian');
    }
  });

  it('attach monitor is lender/admin only', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, LtvGuardianController.prototype.attachMonitor);
    expect(roles).toEqual(['lender', 'admin']);
  });

  it('the evaluation run step is admin-only (internal cron/Temporal)', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, LtvGuardianController.prototype.runEvaluation);
    expect(roles).toEqual(['admin']);
  });

  it('position detail requires authentication with in-service visibility rules', () => {
    // @Authenticated() declares every known role; LtvGuardianService
    // .getPosition then enforces the lender/borrower/oversight party check.
    const roles = reflector.get<string[]>(ROLES_KEY, LtvGuardianController.prototype.getPosition);
    expect(roles).toBeDefined();
    expect(roles).toContain('farmer');
    expect(roles).toContain('lender');
  });
});
