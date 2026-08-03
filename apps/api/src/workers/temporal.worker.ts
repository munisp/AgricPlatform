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
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AppModule } from '../app.module.js';
import { requireEnv } from '../modules/integrations/drivers/http.js';
import { DEFAULT_TASK_QUEUE } from '../common/orchestration/workflow-orchestrator.driver.js';
import { CreditService } from '../modules/finance/credit.service.js';
import { LedgerService } from '../modules/finance/ledger.service.js';
import {
  buildLoanDisbursementDeps
} from '../modules/finance/workflows/loan-disbursement.registration.js';
import { createLoanDisbursementActivities } from '../modules/finance/workflows/loan-disbursement.activities.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';

const nodeRequire = createRequire(import.meta.url);

/** Builds (but does not run) the worker; fails closed without TEMPORAL_ADDRESS. */
export async function createTemporalWorker(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ worker: Worker; close: () => Promise<void> }> {
  const address = requireEnv('temporal', env, ['TEMPORAL_ADDRESS']);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn']
  });
  const activities = createLoanDisbursementActivities(
    buildLoanDisbursementDeps(
      app.get(CreditService),
      app.get(LedgerService),
      app.get(NotificationsService)
    )
  );
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
    workflowsPath: nodeRequire.resolve(
      '../modules/finance/workflows/loan-disbursement.workflow.js'
    ),
    activities
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
