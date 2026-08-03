/**
 * Workflow-orchestrator drivers (wave FABRIC): multi-step workflow
 * execution behind one WorkflowOrchestrator port. The stub driver is the
 * DEFAULT and directly invokes locally-registered workflow handlers
 * in-process (sequential, deterministic — the current behaviour for every
 * pipeline, which today is plain service calls). Setting
 * WORKFLOW_DRIVER=temporal selects the Temporal driver, which REQUIRES
 * TEMPORAL_ADDRESS and fails closed: the factory throws
 * ProviderConfigError at boot when the address is absent, and
 * connection/start failures raise ProviderRequestError (callers map to
 * 503) — never a silent fallback to direct invocation. Mirrors the
 * geo-intel flood-risk driver convention, including the call-time circuit
 * breaker.
 */
import { newId } from '../async-repository.js';
import {
  ProviderConfigError,
  ProviderRequestError,
  requireEnv
} from '../../modules/integrations/drivers/http.js';

/** DI token for the selected WorkflowOrchestrator driver. */
export const WORKFLOW_ORCHESTRATOR = Symbol('WORKFLOW_ORCHESTRATOR');

/** Number of consecutive failures before the circuit opens. */
export const WORKFLOW_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const WORKFLOW_CIRCUIT_COOLDOWN_MS = 30_000;
/** Temporal task queue the worker bootstrap (src/workers/) polls. */
export const DEFAULT_TASK_QUEUE = 'agric-platform';

export interface WorkflowStartOptions {
  /** Caller-chosen idempotency handle; generated when omitted. */
  workflowId?: string;
  /** Temporal task queue (defaults to DEFAULT_TASK_QUEUE). */
  taskQueue?: string;
}

export type WorkflowRunState = 'running' | 'completed' | 'failed';

export interface WorkflowExecution<R = unknown> {
  workflowId: string;
  /** Temporal run id (absent for the in-process stub driver). */
  runId?: string;
  state: WorkflowRunState;
  /** Stub driver: the local handler's return value (direct invocation). */
  result?: R;
}

export interface WorkflowOrchestratorStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export type LocalWorkflowHandler<I = unknown, R = unknown> = (input: I) => Promise<R>;

export interface WorkflowOrchestrator {
  readonly name: 'stub' | 'temporal';
  startWorkflow<R = unknown>(
    workflowName: string,
    input: unknown,
    options?: WorkflowStartOptions
  ): Promise<WorkflowExecution<R>>;
  status(): Promise<WorkflowOrchestratorStatus>;
}

/**
 * Minimal Temporal client surface (an @temporalio/client Client subset) so
 * tests can inject fakes and the client library import stays lazy — it is
 * only loaded when the temporal driver is actually selected.
 */
export interface TemporalWorkflowHandleLike {
  workflowId: string;
  firstExecutionRunId: string;
}

export interface TemporalClientLike {
  workflow: {
    start(
      workflowName: string,
      options: { taskQueue: string; workflowId: string; args: unknown[] }
    ): Promise<TemporalWorkflowHandleLike>;
  };
}

export type TemporalClientFactory = () => Promise<TemporalClientLike>;

async function defaultClientFactory(
  address: string,
  namespace: string
): Promise<TemporalClientLike> {
  const { Client, Connection } = await import('@temporalio/client');
  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}

/**
 * Default driver: direct invocation. Workflows register a local handler
 * (registerLocalWorkflow) and startWorkflow runs it inline — the same
 * sequential semantics as the service-call pipelines the platform has
 * today. Starting an UNREGISTERED workflow fails closed: the stub never
 * pretends to execute work it does not know about.
 */
export class StubWorkflowOrchestrator implements WorkflowOrchestrator {
  readonly name = 'stub' as const;

  private readonly handlers = new Map<string, LocalWorkflowHandler>();

  registerLocalWorkflow<I, R>(name: string, handler: LocalWorkflowHandler<I, R>): void {
    this.handlers.set(name, handler as LocalWorkflowHandler);
  }

  /** Visible for tests/diagnostics. */
  get registeredWorkflows(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async startWorkflow<R = unknown>(
    workflowName: string,
    input: unknown,
    options: WorkflowStartOptions = {}
  ): Promise<WorkflowExecution<R>> {
    const handler = this.handlers.get(workflowName);
    if (!handler) {
      throw new Error(
        `Workflow '${workflowName}' has no registered local handler (stub orchestrator). ` +
          'Register it via registerLocalWorkflow or select WORKFLOW_DRIVER=temporal.'
      );
    }
    const result = (await handler(input)) as R;
    return {
      workflowId: options.workflowId ?? newId('wf'),
      state: 'completed',
      result
    };
  }

  status(): Promise<WorkflowOrchestratorStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        `Stub driver: direct in-process invocation (${this.handlers.size} workflow(s) registered). ` +
        'Set WORKFLOW_DRIVER=temporal and TEMPORAL_ADDRESS to orchestrate via Temporal.'
    });
  }
}

/**
 * Live Temporal driver (@temporalio/client, lazy import). Connects lazily
 * on first start; connection/start failures trip a call-time circuit
 * breaker and surface as ProviderRequestError so callers answer 503
 * instead of degrading silently to in-process execution.
 */
export class TemporalWorkflowOrchestrator implements WorkflowOrchestrator {
  readonly name = 'temporal' as const;

  private client?: TemporalClientLike;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly address: string,
    private readonly options: {
      namespace?: string;
      clientFactory?: TemporalClientFactory;
    } = {}
  ) {}

  get namespace(): string {
    return this.options.namespace?.trim() || 'default';
  }

  async startWorkflow<R = unknown>(
    workflowName: string,
    input: unknown,
    options: WorkflowStartOptions = {}
  ): Promise<WorkflowExecution<R>> {
    this.assertCircuitClosed();
    try {
      const client = await this.ensureClient();
      const handle = await client.workflow.start(workflowName, {
        taskQueue: options.taskQueue ?? DEFAULT_TASK_QUEUE,
        workflowId: options.workflowId ?? newId('wf'),
        args: [input]
      });
      this.recordSuccess();
      return {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        state: 'running'
      };
    } catch (error) {
      this.recordFailure();
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      throw new ProviderRequestError('temporal', 'network', error);
    }
  }

  status(): Promise<WorkflowOrchestratorStatus> {
    return Promise.resolve({
      configured: true,
      healthy: this.client !== undefined && !this.circuitOpen,
      detail: this.client
        ? this.circuitOpen
          ? `Temporal client connected but circuit open after ${this.consecutiveFailures} consecutive failures.`
          : `Temporal client connected to ${this.address} (namespace ${this.namespace}).`
        : `Temporal driver selected (address ${this.address}, namespace ${this.namespace}); connects on first workflow start.`
    });
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= WORKFLOW_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private async ensureClient(): Promise<TemporalClientLike> {
    if (!this.client) {
      const factory =
        this.options.clientFactory ??
        (() => defaultClientFactory(this.address, this.namespace));
      this.client = await factory();
    }
    return this.client;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'temporal',
        'network',
        new Error(
          `circuit open after ${this.consecutiveFailures} consecutive failures; retry after cooldown`
        )
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= WORKFLOW_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + WORKFLOW_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderRequestError };

/**
 * Builds the configured driver. Default is the stub (direct invocation —
 * current behaviour); WORKFLOW_DRIVER=temporal requires TEMPORAL_ADDRESS
 * and fails closed with ProviderConfigError otherwise.
 */
export function createWorkflowOrchestrator(
  env: NodeJS.ProcessEnv = process.env
): WorkflowOrchestrator {
  const flag = (env.WORKFLOW_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'temporal') {
    const address = requireEnv('temporal', env, ['TEMPORAL_ADDRESS']);
    return new TemporalWorkflowOrchestrator(address, {
      namespace: env.TEMPORAL_NAMESPACE
    });
  }
  return new StubWorkflowOrchestrator();
}
