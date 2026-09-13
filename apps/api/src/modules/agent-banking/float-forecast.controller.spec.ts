import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { FEATURE_FLAG_KEY } from '../../common/feature-flags/feature-flag.decorator.js';
import { FLOAT_FORECASTER_FLAG } from './float-forecast.service.js';
import { FloatForecastController } from './float-forecast.controller.js';

/**
 * Auth/flag wiring checks (Stage 27, Innovation 15): the whole forecaster
 * surface is admin-only (the platform's ops role) and flag-gated behind
 * `float-forecaster`; FeatureFlagGuard fails closed with 404 when off.
 * The guards enforce this at runtime; here we pin the declarations.
 */
describe('FloatForecastController auth + flag metadata', () => {
  const reflector = new Reflector();

  it('every route is admin-only (ops surface)', () => {
    const methods = Object.getOwnPropertyNames(FloatForecastController.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(methods.sort()).toEqual(
      ['ack', 'alerts', 'createRun', 'forecasts', 'resolve', 'run', 'runs'].sort()
    );
    for (const method of methods) {
      // Roles are declared at class level; getAllAndOverride sees them per route.
      const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
        FloatForecastController.prototype[method as keyof FloatForecastController],
        FloatForecastController
      ]);
      expect(roles, method).toEqual(['admin']);
    }
  });

  it('the whole controller is gated behind the float-forecaster flag', () => {
    expect(reflector.get<string>(FEATURE_FLAG_KEY, FloatForecastController)).toBe(
      FLOAT_FORECASTER_FLAG
    );
    expect(FLOAT_FORECASTER_FLAG).toBe('float-forecaster');
  });
});
