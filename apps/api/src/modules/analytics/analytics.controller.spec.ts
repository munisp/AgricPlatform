import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { AnalyticsController } from './analytics.controller.js';

/**
 * Wave B endpoint contract: role gating (admin/regulator for reads, admin
 * for the projection trigger), audit logging and CSV export behaviour. The
 * guard itself is covered by roles.guard.spec.ts; here we assert the
 * metadata the guard enforces on each new handler.
 */

function makeController() {
  const projector = {
    project: vi.fn().mockResolvedValue({
      scanned: 3,
      applied: 2,
      skipped: 1,
      recomputedDates: ['2026-08-01'],
      ranAt: '2026-08-06T00:00:00.000Z'
    })
  };
  const star = {
    dailyMetrics: vi.fn().mockResolvedValue([{ metricDate: '2026-08-01', ordersCount: 1 }]),
    summary: vi.fn().mockResolvedValue({ gmvKobo: 42 }),
    factCsv: vi.fn().mockResolvedValue('h1,h2\r\na,b\r\n')
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new AnalyticsController(
    {} as never,
    {} as never,
    audit as never,
    projector as never,
    star as never
  );
  return { controller, projector, star, audit };
}

function rolesOf(handler: string): string[] | undefined {
  const reflector = new Reflector();
  return reflector.get(ROLES_KEY, (AnalyticsController.prototype as never)[handler]);
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    }
  };
}

describe('AnalyticsController Wave B role gating', () => {
  it('POST /analytics/project requires admin', () => {
    expect(rolesOf('project')).toEqual(['admin']);
  });

  it('GET /analytics/metrics/daily requires admin or regulator', () => {
    expect(rolesOf('dailyMetrics')).toEqual(['admin', 'regulator']);
  });

  it('GET /analytics/metrics/summary requires admin or regulator', () => {
    expect(rolesOf('metricsSummary')).toEqual(['admin', 'regulator']);
  });

  it('GET /analytics/export/:fact.csv requires admin or regulator', () => {
    expect(rolesOf('exportFact')).toEqual(['admin', 'regulator']);
  });
});

describe('AnalyticsController Wave B handlers', () => {
  it('project runs one projection pass and audit-logs the outcome', async () => {
    const { controller, projector, audit } = makeController();
    const actor = { id: 'admin-1' };
    const result = await controller.project(actor as never);
    expect(projector.project).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({ applied: 2, skipped: 1, recomputedDates: ['2026-08-01'] });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'admin-1', action: 'analytics.project' })
    );
  });

  it('dailyMetrics passes the date range through', async () => {
    const { controller, star } = makeController();
    const result = await controller.dailyMetrics({ from: '2026-08-01', to: '2026-08-31' } as never);
    expect(star.dailyMetrics).toHaveBeenCalledWith({ from: '2026-08-01', to: '2026-08-31' });
    expect(result.data).toHaveLength(1);
  });

  it('metricsSummary returns the aggregate bundle', async () => {
    const { controller } = makeController();
    const result = await controller.metricsSummary();
    expect(result.data).toMatchObject({ gmvKobo: 42 });
  });

  it('exportFact streams fact_orders CSV with download headers and audit', async () => {
    const { controller, star, audit } = makeController();
    const response = fakeResponse();
    const csv = await controller.exportFact(
      'fact_orders',
      { from: '2026-08-01', to: undefined } as never,
      { id: 'admin-1' } as never,
      response as never
    );
    expect(star.factCsv).toHaveBeenCalledWith('fact_orders', { from: '2026-08-01', to: undefined });
    expect(response.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['Content-Disposition']).toBe('attachment; filename="fact_orders.csv"');
    expect(csv).toContain('h1,h2');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'analytics.export.fact', entityId: 'fact_orders' })
    );
  });

  it('exportFact rejects unknown fact names with a 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.exportFact('fact_secrets', {} as never, null, fakeResponse() as never)
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
