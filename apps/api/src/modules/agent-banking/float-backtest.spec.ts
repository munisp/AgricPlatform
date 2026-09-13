import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryFloatForecastRepository,
  createInMemoryRebalanceAlertRepository,
  createInMemoryRebalanceRunRepository
} from '../../database/repositories/float-forecast.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { DEFAULT_HIT_TOLERANCE_DAYS, runBacktest } from './float-backtest.js';
import {
  FORECAST_DEPLETION_HIT_RATE_BPS,
  FORECAST_MAPE_BPS,
  FloatForecastService
} from './float-forecast.service.js';
import {
  FLOAT_FORECAST_MODEL_VERSION,
  addDays,
  type DailyNetFlow
} from './float-forecast.js';

/**
 * Backtest harness honesty tests (Stage 27, Innovation 15): accuracy numbers
 * are EMITTED from walk-forward evaluation over fixture ledger history, never
 * claimed. Expected values below come from an independent exact-rational
 * reference implementation of the same documented algorithm.
 */

function series(start: string, days: number, flow: (index: number) => number): DailyNetFlow[] {
  const rows: DailyNetFlow[] = [];
  for (let index = 0; index < days; index += 1) {
    rows.push({ date: addDays(start, index), netFlowKobo: flow(index) });
  }
  return rows;
}

/**
 * Noisy fixture: weekly seasonality (Mon..Sun 1500/1000/500/200/-200/-1200/
 * -1800 naira), a -N60/day trend and a deterministic +/-N40 ripple — the
 * model fits the structure but not the ripple, so the MAPE is honestly > 0.
 */
const WEEK = [150_000, 100_000, 50_000, 20_000, -20_000, -120_000, -180_000];
const NOISY = series('2026-01-05', 56, (index) => WEEK[index % 7] - 6_000 * index + ((index % 3) - 1) * 4_000);

/** Clean fixture: constant N500/day drain — perfectly predictable. */
const CLEAN = series('2026-01-05', 42, () => -50_000);

describe('runBacktest — fixture ledger history', () => {
  it('reports honest non-perfect metrics on the noisy fixture', () => {
    const result = runBacktest(NOISY, {
      horizonDays: 14,
      initialFloatKobo: 8_000_000,
      depletionThresholdKobo: 2_000_000,
      hitToleranceDays: DEFAULT_HIT_TOLERANCE_DAYS
    });
    expect(result.modelVersion).toBe(FLOAT_FORECAST_MODEL_VERSION);
    expect(result.samples).toBe(42);
    expect(result.evaluatedDays).toBe(497);
    // Honest accuracy: ~47% mean absolute error — this is a naive v1 model
    // on a noisy series, and the harness says so instead of hiding it.
    expect(result.mapeBps).toBe(4_708);
    expect(result.depletionCases).toBe(23);
    expect(result.depletionHits).toBe(22);
    expect(result.depletionHitRateBps).toBe(9_565);
    expect(result.falseAlarms).toBe(2);
  });

  it('scores the perfectly predictable fixture perfectly', () => {
    const result = runBacktest(CLEAN, {
      horizonDays: 14,
      initialFloatKobo: 1_500_000,
      depletionThresholdKobo: 100_000,
      hitToleranceDays: 1
    });
    expect(result.samples).toBe(28);
    expect(result.evaluatedDays).toBe(301);
    expect(result.mapeBps).toBe(0);
    expect(result.depletionCases).toBe(28);
    expect(result.depletionHits).toBe(28);
    expect(result.depletionHitRateBps).toBe(10_000);
    expect(result.falseAlarms).toBe(0);
  });

  it('reports null hit-rate when no actual depletion occurs', () => {
    const result = runBacktest(NOISY, {
      horizonDays: 14,
      initialFloatKobo: 20_000_000,
      depletionThresholdKobo: 2_000_000,
      hitToleranceDays: 1
    });
    expect(result.depletionCases).toBe(0);
    expect(result.depletionHitRateBps).toBeNull();
    expect(result.mapeBps).toBe(4_708);
  });

  it('is deterministic: the same series yields the same metrics', () => {
    const config = {
      horizonDays: 14,
      initialFloatKobo: 8_000_000,
      depletionThresholdKobo: 2_000_000,
      hitToleranceDays: 1
    };
    expect(runBacktest(NOISY, config)).toEqual(runBacktest(NOISY, config));
  });
});

describe('FloatForecastService.publishBacktestMetrics', () => {
  it('emits MAPE and hit-rate histograms labelled per model_version', () => {
    const recorded: { name: string; value: number; attributes: Record<string, unknown> }[] = [];
    const telemetrySpy = {
      withSpan: async <T>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
      increment: () => undefined,
      record: (name: string, value: number, attributes: Record<string, unknown>) => {
        recorded.push({ name, value, attributes });
      }
    };
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const ledger = new LedgerService(
      events,
      createInMemoryLedgerAccountRepository(),
      createInMemoryLedgerEntryRepository()
    );
    const service = new FloatForecastService(
      // Repository args are unused by the emission path.
      undefined as never,
      createInMemoryFloatForecastRepository(),
      createInMemoryRebalanceAlertRepository(),
      createInMemoryRebalanceRunRepository(),
      ledger,
      events,
      telemetrySpy as never
    );
    const noisy = runBacktest(NOISY, {
      horizonDays: 14,
      initialFloatKobo: 8_000_000,
      depletionThresholdKobo: 2_000_000,
      hitToleranceDays: 1
    });
    service.publishBacktestMetrics(noisy);
    expect(recorded).toEqual([
      {
        name: FORECAST_MAPE_BPS,
        value: 4_708,
        attributes: { model_version: FLOAT_FORECAST_MODEL_VERSION }
      },
      {
        name: FORECAST_DEPLETION_HIT_RATE_BPS,
        value: 9_565,
        attributes: { model_version: FLOAT_FORECAST_MODEL_VERSION }
      }
    ]);
  });

  it('emits nothing for null metrics (no eligible days / no depletion cases)', () => {
    const recorded: string[] = [];
    const telemetrySpy = {
      withSpan: async <T>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
      increment: () => undefined,
      record: (name: string) => {
        recorded.push(name);
      }
    };
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const ledger = new LedgerService(
      events,
      createInMemoryLedgerAccountRepository(),
      createInMemoryLedgerEntryRepository()
    );
    const service = new FloatForecastService(
      undefined as never,
      createInMemoryFloatForecastRepository(),
      createInMemoryRebalanceAlertRepository(),
      createInMemoryRebalanceRunRepository(),
      ledger,
      events,
      telemetrySpy as never
    );
    service.publishBacktestMetrics({
      modelVersion: FLOAT_FORECAST_MODEL_VERSION,
      horizonDays: 14,
      samples: 0,
      evaluatedDays: 0,
      mapeBps: null,
      depletionCases: 0,
      depletionHits: 0,
      depletionHitRateBps: null,
      falseAlarms: 0
    });
    expect(recorded).toEqual([]);
  });
});
