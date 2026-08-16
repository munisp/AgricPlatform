import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
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
  const lakehouse = {
    runExport: vi.fn().mockResolvedValue({
      runId: 'run-1',
      runDate: '2026-08-06',
      bucket: 'agric-lakehouse',
      prefix: 'lakehouse',
      format: 'parquet',
      startedAt: '2026-08-06T00:00:00.000Z',
      finishedAt: '2026-08-06T00:00:01.000Z',
      tables: [{ table: 'fact_orders', rows: 3, files: [{ key: 'lakehouse/fact_orders/dt=2026-08-06/part-run-1-00000.parquet', bytes: 1024, sha256: 'abc' }] }],
      totalRows: 3,
      totalBytes: 1024
    }),
    lastExportStatus: vi.fn().mockResolvedValue({
      enabled: false,
      reason: 'LAKEHOUSE_ENABLED is not true',
      prefix: 'lakehouse',
      manifest: null
    })
  };
  const controller = new AnalyticsController(
    {} as never,
    {} as never,
    audit as never,
    projector as never,
    star as never,
    lakehouse as never
  );
  return { controller, projector, star, audit, lakehouse };
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

  it('GET /analytics/metrics, /overview and /segments require admin (stage 22 sweep)', () => {
    expect(rolesOf('metrics')).toEqual(['admin']);
    expect(rolesOf('overview')).toEqual(['admin']);
    expect(rolesOf('segments')).toEqual(['admin']);
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

  it('POST /analytics/export requires admin (non-admin gets 403 from the guard)', () => {
    expect(rolesOf('exportLakehouse')).toEqual(['admin']);
  });

  it('GET /analytics/export/last requires admin (non-admin gets 403 from the guard)', () => {
    expect(rolesOf('lakehouseExportLast')).toEqual(['admin']);
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

describe('AnalyticsController lakehouse export endpoints', () => {
  it('POST /analytics/export runs the export, audit-logs and returns the manifest', async () => {
    const { controller, lakehouse, audit } = makeController();
    const result = await controller.exportLakehouse({ id: 'admin-1' } as never);
    expect(lakehouse.runExport).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      runId: 'run-1',
      runDate: '2026-08-06',
      format: 'parquet',
      totalRows: 3
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'analytics.export.lakehouse',
        entityId: 'run-1'
      })
    );
  });

  it('GET /analytics/export/last returns the honest disabled state', async () => {
    const { controller, lakehouse } = makeController();
    const result = await controller.lakehouseExportLast();
    expect(lakehouse.lastExportStatus).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({ enabled: false, manifest: null });
  });

  it('POST /analytics/export surfaces the disabled 503 from the service', async () => {
    const { controller, lakehouse } = makeController();
    lakehouse.runExport.mockRejectedValueOnce(
      new ServiceUnavailableException('Lakehouse export is disabled.')
    );
    await expect(controller.exportLakehouse(null)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });
});
