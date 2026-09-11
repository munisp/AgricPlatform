/**
 * Temporal worker readiness probe (WP-G8, V3 audit finding B). Previously
 * the API could run with WORKFLOW_DRIVER=temporal while no worker process
 * polled the task queue — startWorkflow succeeded at the Temporal server
 * and the workflow then queued FOREVER with no signal anywhere.
 *
 * Doctrine: this indicator is only `configured()` when the temporal driver
 * is selected; with the default stub driver it reports `skipped` and never
 * degrades readiness. When configured it fails readiness unless at least
 * one worker is polling the configured task queue (DescribeTaskQueue
 * pollers — the Temporal-side heartbeat of a live worker). The Temporal
 * client library is imported lazily so the default boot path never loads
 * it; probe failures (server unreachable, missing address) degrade
 * readiness exactly like any other configured dependency.
 */
import { DEFAULT_TASK_QUEUE } from '../common/orchestration/workflow-orchestrator.driver.js';
import type { DependencyIndicator } from './dependency-indicator.js';

/** Counts the workers currently polling the configured Temporal task queue. */
export type TemporalPollerProbe = () => Promise<number>;

/** Whether the temporal workflow driver is selected (default is the in-process stub). */
export function isTemporalDriverSelected(env: NodeJS.ProcessEnv): boolean {
  return (env.WORKFLOW_DRIVER ?? 'stub').toLowerCase() === 'temporal';
}

/**
 * Real probe: connect to the Temporal server and DescribeTaskQueue the
 * configured task queue (workflow kind), returning the poller count. Only
 * loaded when the temporal driver is selected.
 */
async function defaultPollerProbe(env: NodeJS.ProcessEnv): Promise<number> {
  const address = env.TEMPORAL_ADDRESS;
  if (!address) {
    // createWorkflowOrchestrator fails closed on this at boot; if the probe
    // ever observes it anyway, that is a misconfiguration — report down.
    throw new Error('WORKFLOW_DRIVER=temporal requires TEMPORAL_ADDRESS');
  }
  const { Connection } = await import('@temporalio/client');
  const { temporal } = await import('@temporalio/proto');
  const connection = await Connection.connect({ address });
  try {
    const response = await connection.workflowService.describeTaskQueue({
      namespace: env.TEMPORAL_NAMESPACE?.trim() || 'default',
      taskQueue: {
        name: env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL
      }
    });
    return response.pollers?.length ?? 0;
  } finally {
    await connection.close();
  }
}

export class TemporalWorkerIndicator implements DependencyIndicator {
  readonly name = 'temporal-worker';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly probe: TemporalPollerProbe | null = null
  ) {}

  configured(): boolean {
    return isTemporalDriverSelected(this.env);
  }

  async check(): Promise<void> {
    const probe = this.probe ?? (() => defaultPollerProbe(this.env));
    const pollers = await probe();
    if (pollers < 1) {
      throw new Error(
        `WORKFLOW_DRIVER=temporal but no worker is polling task queue ` +
          `'${this.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE}' — started ` +
          'workflows would queue forever. Start a worker via ' +
          '`npm run worker:temporal -w @agric-platform/api` or the compose ' +
          '`temporal-worker` service (profile: temporal).'
      );
    }
  }
}
