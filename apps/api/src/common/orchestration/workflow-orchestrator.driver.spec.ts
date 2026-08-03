import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConfigError,
  ProviderRequestError
} from '../../modules/integrations/drivers/http.js';
import {
  createWorkflowOrchestrator,
  DEFAULT_TASK_QUEUE,
  StubWorkflowOrchestrator,
  TemporalWorkflowOrchestrator,
  WORKFLOW_CIRCUIT_THRESHOLD,
  type TemporalClientLike
} from './workflow-orchestrator.driver.js';

describe('StubWorkflowOrchestrator (default — direct invocation)', () => {
  it('invokes the registered local handler directly and returns its result', async () => {
    const orchestrator = new StubWorkflowOrchestrator();
    orchestrator.registerLocalWorkflow('test.workflow', async (input) => ({
      echo: (input as { value: number }).value * 2
    }));
    const execution = await orchestrator.startWorkflow<{ echo: number }>(
      'test.workflow',
      { value: 21 },
      { workflowId: 'wf-fixed' }
    );
    expect(execution.workflowId).toBe('wf-fixed');
    expect(execution.state).toBe('completed');
    expect(execution.result).toEqual({ echo: 42 });
    expect(execution.runId).toBeUndefined();
  });

  it('generates a workflow id when none is supplied', async () => {
    const orchestrator = new StubWorkflowOrchestrator();
    orchestrator.registerLocalWorkflow('test.workflow', async () => 'ok');
    const execution = await orchestrator.startWorkflow('test.workflow', {});
    expect(execution.workflowId).toMatch(/^wf-/);
  });

  it('fails closed on unregistered workflows (never pretends to execute)', async () => {
    const orchestrator = new StubWorkflowOrchestrator();
    await expect(orchestrator.startWorkflow('ghost.workflow', {})).rejects.toThrow(
      /no registered local handler/
    );
  });

  it('reports registered workflows and honest status', async () => {
    const orchestrator = new StubWorkflowOrchestrator();
    orchestrator.registerLocalWorkflow('b.wf', async () => null);
    orchestrator.registerLocalWorkflow('a.wf', async () => null);
    expect(orchestrator.registeredWorkflows).toEqual(['a.wf', 'b.wf']);
    const status = await orchestrator.status();
    expect(status.detail).toContain('Stub driver');
    expect(status.detail).toContain('WORKFLOW_DRIVER=temporal');
  });
});

describe('createWorkflowOrchestrator selection', () => {
  it('defaults to the stub when WORKFLOW_DRIVER is unset', () => {
    expect(createWorkflowOrchestrator({}).name).toBe('stub');
  });

  it('fails closed when temporal is selected without TEMPORAL_ADDRESS', () => {
    expect(() => createWorkflowOrchestrator({ WORKFLOW_DRIVER: 'temporal' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds the temporal driver with address and namespace', () => {
    const orchestrator = createWorkflowOrchestrator({
      WORKFLOW_DRIVER: 'temporal',
      TEMPORAL_ADDRESS: 'localhost:7233',
      TEMPORAL_NAMESPACE: 'agric'
    });
    expect(orchestrator.name).toBe('temporal');
    expect((orchestrator as TemporalWorkflowOrchestrator).namespace).toBe('agric');
  });
});

describe('TemporalWorkflowOrchestrator', () => {
  function fakeClient(start: TemporalClientLike['workflow']['start']): TemporalClientLike {
    return { workflow: { start } };
  }

  it('starts the workflow on the default task queue with the input as args', async () => {
    const start = vi.fn().mockResolvedValue({
      workflowId: 'wf-1',
      firstExecutionRunId: 'run-1'
    });
    const orchestrator = new TemporalWorkflowOrchestrator('localhost:7233', {
      clientFactory: () => Promise.resolve(fakeClient(start))
    });
    const execution = await orchestrator.startWorkflow('credit.loan_disbursement', {
      loanId: 'loan-1'
    });
    expect(start).toHaveBeenCalledWith('credit.loan_disbursement', {
      taskQueue: DEFAULT_TASK_QUEUE,
      workflowId: expect.any(String),
      args: [{ loanId: 'loan-1' }]
    });
    expect(execution).toEqual({ workflowId: 'wf-1', runId: 'run-1', state: 'running' });
  });

  it('honours the caller workflow id and task queue', async () => {
    const start = vi.fn().mockResolvedValue({ workflowId: 'wf-x', firstExecutionRunId: 'run-x' });
    const orchestrator = new TemporalWorkflowOrchestrator('localhost:7233', {
      clientFactory: () => Promise.resolve(fakeClient(start))
    });
    await orchestrator.startWorkflow('wf', {}, { workflowId: 'wf-x', taskQueue: 'custom' });
    expect(start).toHaveBeenCalledWith('wf', {
      taskQueue: 'custom',
      workflowId: 'wf-x',
      args: [{}]
    });
  });

  it('wraps connection/start failures as ProviderRequestError (fail closed)', async () => {
    const orchestrator = new TemporalWorkflowOrchestrator('localhost:7233', {
      clientFactory: () => Promise.reject(new Error('connection refused'))
    });
    await expect(orchestrator.startWorkflow('wf', {})).rejects.toBeInstanceOf(
      ProviderRequestError
    );
  });

  it('opens the circuit after consecutive failures and fails fast', async () => {
    const start = vi.fn().mockRejectedValue(new Error('unavailable'));
    const orchestrator = new TemporalWorkflowOrchestrator('localhost:7233', {
      clientFactory: () => Promise.resolve(fakeClient(start))
    });
    for (let i = 0; i < WORKFLOW_CIRCUIT_THRESHOLD; i += 1) {
      await expect(orchestrator.startWorkflow('wf', {})).rejects.toBeInstanceOf(
        ProviderRequestError
      );
    }
    expect(orchestrator.circuitOpen).toBe(true);
    const callsBefore = start.mock.calls.length;
    await expect(orchestrator.startWorkflow('wf', {})).rejects.toBeInstanceOf(
      ProviderRequestError
    );
    expect(start.mock.calls.length).toBe(callsBefore);
  });
});
