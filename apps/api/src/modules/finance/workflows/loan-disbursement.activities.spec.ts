import { describe, expect, it, vi } from 'vitest';
import { StubWorkflowOrchestrator } from '../../../common/orchestration/workflow-orchestrator.driver.js';
import {
  createLoanDisbursementActivities,
  LOAN_DISBURSEMENT_WORKFLOW,
  runLoanDisbursementPipeline,
  type LoanDisbursementDeps,
  type LoanDisbursementInput
} from './loan-disbursement.activities.js';
import {
  buildLoanDisbursementDeps,
  registerLoanDisbursementWorkflow
} from './loan-disbursement.registration.js';

const INPUT: LoanDisbursementInput = {
  loanId: 'loan-1',
  applicantId: 'user-1',
  amountKobo: 250_000_00,
  lenderAccountCode: 'lender:pool',
  borrowerAccountCode: 'borrower:user-1',
  actorId: 'admin-1',
  minScore: 600
};

function deps(score: number): LoanDisbursementDeps & {
  postDisbursementEntry: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  return {
    scoreForUser: vi.fn().mockResolvedValue({ score }),
    postDisbursementEntry: vi.fn().mockResolvedValue({ entryId: 'entry-1' }),
    notify: vi.fn().mockResolvedValue({ notificationId: 'notif-1' })
  };
}

describe('runLoanDisbursementPipeline (stub orchestrator executor)', () => {
  it('runs score-check → ledger-record → notification in order on approve', async () => {
    const d = deps(650);
    const result = await runLoanDisbursementPipeline(createLoanDisbursementActivities(d), INPUT);
    expect(result).toEqual({
      loanId: 'loan-1',
      score: 650,
      decision: 'approve',
      ledgerEntryId: 'entry-1',
      notificationId: 'notif-1',
      steps: ['score-check', 'ledger-record', 'notification']
    });
    expect(d.postDisbursementEntry).toHaveBeenCalledWith(INPUT);
    expect(d.notify).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('disbursed'),
      expect.stringContaining('entry-1')
    );
  });

  it('short-circuits BEFORE the ledger posting on decline and still notifies', async () => {
    const d = deps(420);
    const result = await runLoanDisbursementPipeline(createLoanDisbursementActivities(d), INPUT);
    expect(result.decision).toBe('decline');
    expect(result.ledgerEntryId).toBeUndefined();
    expect(result.steps).toEqual(['score-check', 'notification']);
    expect(d.postDisbursementEntry).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('declined'),
      expect.stringContaining('420')
    );
  });

  it('approves exactly at the minScore boundary', async () => {
    const d = deps(600);
    const result = await runLoanDisbursementPipeline(createLoanDisbursementActivities(d), INPUT);
    expect(result.decision).toBe('approve');
  });
});

describe('buildLoanDisbursementDeps (service mapping)', () => {
  it('posts a balanced disbursement entry with the solvency guard', async () => {
    const postEntry = vi.fn().mockResolvedValue({ id: 'entry-9' });
    const credit = { scoreForUser: vi.fn().mockResolvedValue({ score: 700 }) };
    const send = vi.fn().mockResolvedValue({ id: 'notif-9' });
    const mapped = buildLoanDisbursementDeps(
      credit as never,
      { postEntry } as never,
      { send } as never
    );

    expect((await mapped.scoreForUser('user-1')).score).toBe(700);
    expect(await mapped.postDisbursementEntry(INPUT)).toEqual({ entryId: 'entry-9' });
    expect(postEntry).toHaveBeenCalledWith(
      {
        idempotencyKey: 'loan-disbursement:loan-1',
        referenceType: 'credit_loan',
        referenceId: 'loan-1',
        description: expect.stringContaining(LOAN_DISBURSEMENT_WORKFLOW),
        postings: [
          { accountCode: 'lender:pool', direction: 'debit', amountKobo: INPUT.amountKobo },
          { accountCode: 'borrower:user-1', direction: 'credit', amountKobo: INPUT.amountKobo }
        ],
        requireSolventAccounts: ['lender:pool']
      },
      'admin-1'
    );
    expect(await mapped.notify('user-1', 't', 'b')).toEqual({ notificationId: 'notif-9' });
    expect(send).toHaveBeenCalledWith({
      userId: 'user-1',
      channel: 'in_app',
      title: 't',
      body: 'b'
    });
  });
});

describe('registerLoanDisbursementWorkflow (port proof)', () => {
  it('registers the local handler on the stub orchestrator and runs end-to-end', async () => {
    const orchestrator = new StubWorkflowOrchestrator();
    const registered = registerLoanDisbursementWorkflow(orchestrator, deps(650));
    expect(registered).toBe(true);
    expect(orchestrator.registeredWorkflows).toContain(LOAN_DISBURSEMENT_WORKFLOW);
    const execution = await orchestrator.startWorkflow(LOAN_DISBURSEMENT_WORKFLOW, INPUT);
    expect(execution.state).toBe('completed');
    expect((execution.result as { decision: string }).decision).toBe('approve');
  });

  it('does not register on a non-stub orchestrator (temporal hosts the worker)', () => {
    const fakeTemporal = { name: 'temporal' as const, startWorkflow: vi.fn(), status: vi.fn() };
    expect(registerLoanDisbursementWorkflow(fakeTemporal, deps(650))).toBe(false);
  });
});
