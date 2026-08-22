import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { VslaCarbonController } from './vsla-carbon.controller.js';

/**
 * HTTP-level guard-coverage regression (Stage 24, audit A2-3): every handler
 * that calls requireActor(@CurrentUser()) depends on RolesGuard to populate
 * request.user. A route decorated WITHOUT the guard is permanently dead
 * (401 for every caller) — the Stage-22 sweep missed all 14 GETs and no
 * module-level spec caught it because they exercise the service directly.
 * This scan fails the build if any route loses its effective guard chain.
 */
describe('VslaCarbonController guard coverage (A2-3 regression)', () => {
  const prototype = VslaCarbonController.prototype;
  const classGuards = (Reflect.getMetadata(GUARDS_METADATA, VslaCarbonController) ?? []) as unknown[];

  function routes(): Array<{ name: string; method: number; guards: unknown[] }> {
    return Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = prototype[name as keyof VslaCarbonController];
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (method === undefined || path === undefined) {
          return undefined;
        }
        const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
        return { name, method, guards };
      })
      .filter((route): route is NonNullable<typeof route> => route !== undefined);
  }

  it('exposes the expected surface (guards against scan drift)', () => {
    const all = routes();
    expect(all.length).toBeGreaterThanOrEqual(27);
    expect(all.filter((r) => r.method === RequestMethod.GET)).toHaveLength(17);
  });

  it('EVERY route (reads included) resolves RolesGuard at method or class level', () => {
    const effective = (guards: unknown[]) => [...classGuards, ...guards];
    const unguarded = routes().filter(
      (route) => !effective(route.guards).includes(RolesGuard)
    );
    expect(unguarded.map((route) => route.name)).toEqual([]);
  });

  it('all GET handlers are guarded (the A2-3 defect class specifically)', () => {
    const gets = routes().filter((route) => route.method === RequestMethod.GET);
    expect(gets.length).toBeGreaterThan(0);
    for (const route of gets) {
      expect(route.guards.includes(RolesGuard) || classGuards.includes(RolesGuard)).toBe(true);
    }
  });
});
