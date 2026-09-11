/**
 * Temporal worker bootstrap (wave FABRIC). NOT auto-started: the API entry
 * (src/main.ts) never imports this file, and no compose service runs it by
 * default. It hosts the credit loan disbursement workflow
 * (modules/finance/workflows/) so WORKFLOW_DRIVER=temporal has a real
 * worker to dispatch to. Activities are bound to the SAME CreditService /
 * LedgerService / NotificationsService instances as the API by booting a
 * Nest application context.
 *
 * Run locally (after `npm run build -w @agric-platform/api`):
 *   docker compose -f infra/docker-compose.yml --profile temporal up -d
 *   TEMPORAL_ADDRESS=localhost:7233 npm run worker:temporal -w @agric-platform/api
 *
 * Stage 25.2 (telemetry): this process boots SEPARATELY from main.ts, so it
 * starts the OpenTelemetry SDK itself via the first import below (same
 * telemetry.boot.ts side effect as the API entry — initTelemetry() never
 * throws). Worker.create gets @temporalio/interceptors-opentelemetry
 * interceptors (workflow + activity tracing) and the workflow span exporter
 * sink when telemetry is enabled.
 */
// FIRST import: starts the OTel SDK before AppModule (and therefore
// kafkajs/pg/ioredis) is evaluated in this process. Never throws.
import '../common/telemetry/telemetry.boot.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker, type WorkerInterceptors } from '@temporalio/worker';
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor
} from '@temporalio/interceptors-opentelemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AppModule } from '../app.module.js';
import { requireEnv } from '../modules/integrations/drivers/http.js';
import { DEFAULT_TASK_QUEUE } from '../common/orchestration/workflow-orchestrator.driver.js';
import { initTelemetry, resolveTelemetryConfig } from '../common/telemetry/telemetry.sdk.js';
import { TelemetryService } from '../common/telemetry/telemetry.service.js';
import { CreditService } from '../modules/finance/credit.service.js';
import { LedgerService } from '../modules/finance/ledger.service.js';
import {
  buildLoanDisbursementDeps
} from '../modules/finance/workflows/loan-disbursement.registration.js';
import {
  createLoanDisbursementActivities,
  LOAN_DISBURSEMENT_WORKFLOW,
  type LoanDisbursementActivities,
  type LoanDisbursementInput
} from '../modules/finance/workflows/loan-disbursement.activities.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';

const nodeRequire = createRequire(import.meta.url);

/** OTel wiring for Worker.create — interceptors plus the workflow exporter sink. */
export interface TemporalOtelOptions {
  interceptors: WorkerInterceptors;
  sinks: Record<string, ReturnType<typeof makeWorkflowExporter>>;
}

/**
 * Builds the OpenTelemetry worker options (activity inbound interceptor +
 * workflow interceptor module + workflow span exporter sink pointed at the
 * same OTLP endpoint as the main SDK). Returns undefined when telemetry is
 * disabled (OTEL_ENABLED=false) or sink construction fails — the worker
 * then runs exactly as before, and no workflow-side span exporter is
 * registered (a missing sink would fail workflow executions). Never throws.
 */
export function buildTemporalOtelOptions(
  env: NodeJS.ProcessEnv = process.env
): TemporalOtelOptions | undefined {
  try {
    const config = resolveTelemetryConfig(env);
    if (!config.enabled) {
      return undefined;
    }
    const exporter = new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` });
    const sink = makeWorkflowExporter(
      new BatchSpanProcessor(exporter) as unknown as Parameters<typeof makeWorkflowExporter>[0],
      resourceFromAttributes({
        'service.name': config.serviceName,
        'service.version': config.serviceVersion,
        'deployment.environment': config.environment
      }) as unknown as Parameters<typeof makeWorkflowExporter>[1]
    );
    return {
      interceptors: {
        activityInbound: [(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx)],
        workflowModules: [
          nodeRequire.resolve('@temporalio/interceptors-opentelemetry/lib/workflow')
        ]
      },
      sinks: { exporter: sink }
    };
  } catch {
    return undefined;
  }
}

/**
 * Wraps the loan disbursement activities so each execution is traced as a
 * child of the interceptor's `RunActivity` span (business-handling span —
 * the interceptor span already covers transport, so no double counting).
 * Spans carry tenant.id (the `user:<applicantId>` convention from
 * tenant-context.ts — no platform tenant model exists yet), loan.id and the
 * workflow name; duration + error metrics are recorded around them. Never
 * throws into the activity.
 */
export function instrumentLoanDisbursementActivities(
  activities: LoanDisbursementActivities,
  telemetry: TelemetryService
): LoanDisbursementActivities {
  const wrap = <A extends unknown[], R>(
    activityName: string,
    fn: (...args: A) => Promise<R>
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const input = args[0] as LoanDisbursementInput | undefined;
      const spanAttributes = {
        'temporal.activity': activityName,
        'temporal.workflow': LOAN_DISBURSEMENT_WORKFLOW,
        ...(input
          ? { 'loan.id': input.loanId, 'tenant.id': `user:${input.applicantId}` }
          : {})
      };
      const started = performance.now();
      try {
        return await telemetry.withSpan(
          `activity.${LOAN_DISBURSEMENT_WORKFLOW}.${activityName}`,
          spanAttributes,
          () => fn(...args)
        );
      } catch (error) {
        telemetry.increment('temporal.activity.errors', 1, spanAttributes);
        throw error;
      } finally {
        telemetry.record('temporal.activity.duration', performance.now() - started, spanAttributes);
      }
    };
  };
  return {
    scoreCheck: wrap('score-check', activities.scoreCheck),
    ledgerRecord: wrap('ledger-record', activities.ledgerRecord),
    sendNotification: wrap('notification', activities.sendNotification)
  };
}

/** Builds (but does not run) the worker; fails closed without TEMPORAL_ADDRESS. */
export async function createTemporalWorker(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ worker: Worker; close: () => Promise<void> }> {
  const address = requireEnv('temporal', env, ['TEMPORAL_ADDRESS']);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn']
  });
  const activities = instrumentLoanDisbursementActivities(
    createLoanDisbursementActivities(
      buildLoanDisbursementDeps(
        app.get(CreditService),
        app.get(LedgerService),
        app.get(NotificationsService)
      )
    ),
    app.get(TelemetryService)
  );
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
    workflowsPath: nodeRequire.resolve(
      '../modules/finance/workflows/loan-disbursement.workflow.js'
    ),
    activities,
    // Stage 25.2: OTel interceptors + workflow exporter sink (omitted
    // entirely when telemetry is disabled).
    ...buildTemporalOtelOptions(env)
  });
  return {
    worker,
    close: async () => {
      await app.close();
    }
  };
}

/** Runs the worker until SIGINT/SIGTERM (direct execution only). */
export async function runTemporalWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Idempotent safeguard — the boot import above already ran initTelemetry().
  initTelemetry();
  const { worker, close } = await createTemporalWorker(env);
  const shutdown = () => worker.shutdown();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await worker.run();
  } finally {
    await close();
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runTemporalWorker().catch((error: unknown) => {
    // Fail closed: a worker that cannot reach Temporal exits non-zero.
    console.error('temporal worker failed to start:', error);
    process.exitCode = 1;
  });
}
