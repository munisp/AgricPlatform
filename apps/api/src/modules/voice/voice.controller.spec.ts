import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { VoiceController } from './voice.controller.js';

/**
 * Auth-guard wiring checks: agent endpoints must be restricted to
 * agronomist/admin and farmer endpoints to any authenticated identity
 * (RolesGuard enforces the metadata at runtime; its own spec covers the
 * mechanics — here we pin the per-route role metadata).
 */
describe('VoiceController auth metadata', () => {
  const reflector = new Reflector();

  it('agent-case routes require the agronomist or admin role', () => {
    for (const method of ['listCases', 'getCase', 'respond'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, VoiceController.prototype[method]);
      expect(roles).toEqual(['agronomist', 'admin']);
    }
  });

  it('session routes accept any authenticated role', () => {
    for (const method of ['startSession', 'addTurn', 'getSession', 'escalate'] as const) {
      const roles = reflector.get<string[]>(ROLES_KEY, VoiceController.prototype[method]);
      expect(roles?.length).toBeGreaterThan(0);
      expect(roles).toContain('farmer');
    }
  });
});
