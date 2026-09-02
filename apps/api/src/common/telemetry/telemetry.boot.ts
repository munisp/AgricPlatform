/**
 * Side-effect entrypoint imported FIRST in `main.ts` (before AppModule and
 * the production assertions). ESM imports are hoisted and evaluated in
 * source order, so placing this import first guarantees `initTelemetry()`
 * runs before any application module — and therefore before `pg`, `ioredis`,
 * `kafkajs` or `express` are loaded — giving auto-instrumentation the chance
 * to patch them at module load (integration map §1).
 *
 * initTelemetry() never throws; telemetry must never break the app.
 */
import { initTelemetry } from './telemetry.sdk.js';

initTelemetry();
