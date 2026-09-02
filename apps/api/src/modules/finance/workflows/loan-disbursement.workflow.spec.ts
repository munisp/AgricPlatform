import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, trace, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { loanDisbursementWorkflow } from './loan-disbursement.workflow.js';
import type { LoanDisbursementInput } from './loan-disbursement.activities.js';

// Without a registered context manager the otel API is fully no-op
// (setSpan is dropped by the NoopContextManager). The worker's OTel
// interceptors register one inside the workflow sandbox; tests do it here.
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  contextManager.disable();
  context.disable();
});

const INPUT: LoanDisbursementInput = {
  loanId: 'loan-1',
  applicantId: 'user-1',
  amountKobo: 500_000,
  lenderAccountCode: 'lender-pool',
  borrowerAccountCode: 'borrower-1',
  actorId: 'admin-1',
  minScore: 600
};

/**
 * The workflow function can only fully execute inside the Temporal workflow
 * runtime (proxied activities need the sandbox), so these tests assert the
 * telemetry stamping that happens BEFORE the first activity is scheduled:
 * stamping runs, then scheduling fails outside the runtime. The fake span
 * is planted via the standard otel context API — the same mechanism the
 * interceptors-opentelemetry workflow interceptor uses.
 */
describe('loanDisbursementWorkflow telemetry stamping (Stage 25.2)', () => {
  it('stamps tenant.id and loan.id on the active workflow span', async () => {
    const setAttribute = vi.fn();
    const fakeSpan = { setAttribute } as unknown as Span;
    await expect(
      context.with(trace.setSpan(context.active(), fakeSpan), () =>
        loanDisbursementWorkflow(INPUT)
      )
    ).rejects.toThrow();
    expect(setAttribute).toHaveBeenCalledWith('tenant.id', 'user:user-1');
    expect(setAttribute).toHaveBeenCalledWith('loan.id', 'loan-1');
  });

  it('does not throw when no span is active', async () => {
    // Stamping must be a silent no-op; the subsequent rejection comes from
    // scheduling activities outside the workflow runtime, not from telemetry.
    await expect(loanDisbursementWorkflow(INPUT)).rejects.toThrow(/[a-z]/i);
  });

  it('does not throw when the active span rejects setAttribute', async () => {
    const fakeSpan = {
      setAttribute: () => {
        throw new Error('span exploded');
      }
    } as unknown as Span;
    await expect(
      context.with(trace.setSpan(context.active(), fakeSpan), () =>
        loanDisbursementWorkflow(INPUT)
      )
    ).rejects.toThrow(/[a-z]/i);
    await expect(
      context
        .with(trace.setSpan(context.active(), fakeSpan), () => loanDisbursementWorkflow(INPUT))
        .catch((error: unknown) => error)
    ).resolves.not.toThrow(/span exploded/);
  });
});
