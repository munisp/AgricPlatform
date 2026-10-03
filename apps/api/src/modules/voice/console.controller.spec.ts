import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { FEATURE_FLAG_KEY } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { AgronomistConsoleController } from './console.controller.js';

/**
 * Flag-gate wiring regression: the class declares
 * `@RequiresFeature('agronomist-console')` (default OFF, fail-closed 404),
 * but the flag is only enforced when FeatureFlagGuard sits in the guard
 * chain — the guard is not registered globally. This spec pins the
 * declaration so the SMS-dispatching console surface cannot silently lose
 * its kill-switch again.
 */
describe('AgronomistConsoleController feature-flag wiring', () => {
  const reflector = new Reflector();
  const classGuards = (Reflect.getMetadata(GUARDS_METADATA, AgronomistConsoleController) ??
    []) as unknown[];

  it('declares the agronomist-console feature flag on the controller', () => {
    expect(reflector.get<string>(FEATURE_FLAG_KEY, AgronomistConsoleController)).toBe(
      'agronomist-console'
    );
  });

  it('applies FeatureFlagGuard alongside RolesGuard at class level', () => {
    expect(classGuards).toContain(RolesGuard);
    expect(classGuards).toContain(FeatureFlagGuard);
  });

  it('every route inherits the class-level guard chain (no method-level opt-out)', () => {
    const prototype = AgronomistConsoleController.prototype;
    const routes = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => {
        const handler = prototype[name as keyof AgronomistConsoleController];
        return (
          Reflect.getMetadata(METHOD_METADATA, handler) !== undefined &&
          Reflect.getMetadata(PATH_METADATA, handler) !== undefined
        );
      });
    expect(routes.length).toBeGreaterThan(0);
    for (const name of routes) {
      const handler = prototype[name as keyof AgronomistConsoleController];
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
      const effective = [...classGuards, ...methodGuards];
      expect(effective, name).toContain(RolesGuard);
      expect(effective, name).toContain(FeatureFlagGuard);
      // Role scoping stays intact alongside the flag gate.
      expect(
        reflector.getAllAndOverride<string[]>(ROLES_KEY, [handler, AgronomistConsoleController]),
        name
      ).toBeTruthy();
    }
  });
});
