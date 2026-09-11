import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryService } from '../common/telemetry/telemetry.service.js';
import type {
  LoanDisbursementActivities,
  LoanDisbursementInput
} from '../modules/finance/workflows/loan-disbursement.activities.js';

// The worker entrypoint's first import starts the OTel SDK as a side
// effect; tests must never start real exporters, so the boot module is
// mocked out. AppModule is mocked to avoid loading the whole Nest graph.
vi.mock('../common/telemetry/telemetry.boot.js', () => ({}));
vi.mock('../app.module.js', () => ({ AppModule: class AppModule {} }));
vi.mock('@nestjs/core', () => ({
  NestFactory: { createApplicationContext: vi.fn() }
}));
vi.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: vi.fn().mockResolvedValue({}) },
  Worker: { create: vi.fn().mockResolvedValue({ shutdown: vi.fn(), run: vi.fn() }) }
}));
// The worker resolves the compiled workflow bundle path
// (../modules/finance/workflows/loan-disbursement.workflow.js), which only
// exists after `npm run build`. Tests run from source, so createRequire is
// stubbed to a pass-through resolver.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: () =>
      Object.assign(
        () => {
          throw new Error('require disabled in tests');
        },
        { resolve: (specifier: string) => specifier }
      )
  };
});

import { NestFactory } from '@nestjs/core';
import { Worker } from '@temporalio/worker';
import {
  buildTemporalOtelOptions,
  createTemporalWorker,
  instrumentLoanDisbursementActivities
} from './temporal.worker.js';

const INPUT: LoanDisbursementInput = {
  loanId: 'loan-1',
  applicantId: 'user-1',
  amountKobo: 500_000,
  lenderAccountCode: 'lender-pool',
  borrowerAccountCode: 'borrower-1',
  actorId: 'admin-1',
  minScore: 600
};

function fakeTelemetry() {
  return {
    withSpan: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()),
    increment: vi.fn(),
    record: vi.fn()
  };
}

function fakeActivities(overrides: Partial<LoanDisbursementActivities> = {}): LoanDisbursementActivities {
  return {
    scoreCheck: vi.fn().mockResolvedValue({ score: 720, decision: 'approve' }),
    ledgerRecord: vi.fn().mockResolvedValue({ entryId: 'entry-1' }),
    sendNotification: vi.fn().mockResolvedValue({ notificationId: 'notif-1' }),
    ...overrides
  };
}

describe('buildTemporalOtelOptions', () => {
  it('returns undefined when telemetry is disabled (no interceptors, no sink)', () => {
    expect(buildTemporalOtelOptions({ OTEL_ENABLED: 'false' })).toBeUndefined();
  });

  it('wires workflow + activity interceptors and the exporter sink when enabled', () => {
    const options = buildTemporalOtelOptions({ OTEL_ENABLED: 'true' });
    expect(options).toBeDefined();
    expect(options?.interceptors.workflowModules).toEqual([
      expect.stringContaining('@temporalio/interceptors-opentelemetry')
    ]);
    expect(options?.interceptors.activityInbound).toHaveLength(1);
    expect(options?.sinks.exporter).toBeDefined();
  });
});

describe('instrumentLoanDisbursementActivities', () => {
  it('wraps each activity in a span carrying tenant.id + loan.id + workflow name', async () => {
    const telemetry = fakeTelemetry();
    const wrapped = instrumentLoanDisbursementActivities(
      fakeActivities(),
      telemetry as unknown as TelemetryService
    );
    const score = await wrapped.scoreCheck(INPUT);
    expect(score).toEqual({ score: 720, decision: 'approve' });
    expect(telemetry.withSpan).toHaveBeenCalledWith(
      'activity.credit.loan_disbursement.score-check',
      expect.objectContaining({
        'tenant.id': 'user:user-1',
        'loan.id': 'loan-1',
        'temporal.activity': 'score-check',
        'temporal.workflow': 'credit.loan_disbursement'
      }),
      expect.any(Function)
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      'temporal.activity.duration',
      expect.any(Number),
      expect.objectContaining({ 'loan.id': 'loan-1' })
    );
  });

  it('counts activity failures and rethrows unchanged', async () => {
    const telemetry = fakeTelemetry();
    const boom = new Error('ledger unreachable');
    const wrapped = instrumentLoanDisbursementActivities(
      fakeActivities({ ledgerRecord: vi.fn().mockRejectedValue(boom) }),
      telemetry as unknown as TelemetryService
    );
    await expect(wrapped.ledgerRecord(INPUT, { score: 720, decision: 'approve' })).rejects.toBe(
      boom
    );
    expect(telemetry.increment).toHaveBeenCalledWith(
      'temporal.activity.errors',
      1,
      expect.objectContaining({ 'temporal.activity': 'ledger-record' })
    );
  });

  it('works on the disabled path with a real TelemetryService (no-op tracer)', async () => {
    const { TelemetryService: RealTelemetryService } = await import(
      '../common/telemetry/telemetry.service.js'
    );
    const wrapped = instrumentLoanDisbursementActivities(
      fakeActivities(),
      new RealTelemetryService()
    );
    // SDK never started in this process: the global tracer/meter are no-op
    // providers, so instrumentation must be transparent to business logic.
    await expect(wrapped.scoreCheck(INPUT)).resolves.toEqual({
      score: 720,
      decision: 'approve'
    });
  });
});

describe('createTemporalWorker interceptor wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fakeApp = {
      get: vi.fn().mockImplementation(() => ({})),
      close: vi.fn().mockResolvedValue(undefined)
    };
    (NestFactory.createApplicationContext as ReturnType<typeof vi.fn>).mockResolvedValue(fakeApp);
  });

  it('passes OTel interceptors + sinks to Worker.create when telemetry is enabled', async () => {
    await createTemporalWorker({
      TEMPORAL_ADDRESS: 'localhost:7233',
      OTEL_ENABLED: 'true'
    });
    const options = (Worker.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(options.interceptors).toBeDefined();
    expect(options.sinks).toBeDefined();
    expect(
      (options.interceptors as { workflowModules?: string[] }).workflowModules?.[0]
    ).toContain('@temporalio/interceptors-opentelemetry');
  });

  it('omits interceptors entirely when telemetry is disabled', async () => {
    await createTemporalWorker({
      TEMPORAL_ADDRESS: 'localhost:7233',
      OTEL_ENABLED: 'false'
    });
    const options = (Worker.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty('interceptors');
    expect(options).not.toHaveProperty('sinks');
  });
});
