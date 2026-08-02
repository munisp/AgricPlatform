import {
  BadRequestException,
  Inject,
  Injectable
} from '@nestjs/common';
import type { ColdChainLog, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGGREGATION_POINT_REPOSITORY,
  COLD_CHAIN_LOG_REPOSITORY,
  COLD_CHAIN_PROVIDER
} from '../../database/persistence.tokens.js';
import type {
  AggregationPointRepository,
  ColdChainLogRepository
} from '../../database/repositories/livestock-trade.repository.js';
import type { ColdChainProvider } from './provider-stubs.js';
import { requireActor } from './trade.utils.js';

export interface IngestReadingInput {
  recordedAt: string;
  temperatureCelsius: number;
  humidityPercent?: number;
}

/**
 * Cold-chain telemetry ingestion for aggregation points (F7 contract-only
 * wave). Readings are submitted through the injected ColdChainProvider;
 * the default provider is a fail-closed stub that throws
 * ProviderNotConfiguredError without configuration, so nothing is ingested
 * until a real telemetry vendor is wired behind the same token.
 */
@Injectable()
export class ColdChainService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(AGGREGATION_POINT_REPOSITORY)
    private readonly points: AggregationPointRepository,
    @Inject(COLD_CHAIN_LOG_REPOSITORY)
    private readonly logs: ColdChainLogRepository,
    @Inject(COLD_CHAIN_PROVIDER)
    private readonly provider: ColdChainProvider
  ) {}

  async ingest(
    actor: User | null,
    pointId: string,
    input: IngestReadingInput
  ): Promise<ColdChainLog> {
    const caller = requireActor(actor);
    const point = await this.points.getById(pointId);
    assertSelfOrAdmin(caller, point.managerUserId);
    if (Number.isNaN(Date.parse(input.recordedAt))) {
      throw new BadRequestException('recordedAt must be an ISO timestamp');
    }
    if (!Number.isFinite(input.temperatureCelsius)) {
      throw new BadRequestException('temperatureCelsius must be a finite number');
    }
    if (
      input.humidityPercent !== undefined &&
      (!Number.isFinite(input.humidityPercent) ||
        input.humidityPercent < 0 ||
        input.humidityPercent > 100)
    ) {
      throw new BadRequestException('humidityPercent must be between 0 and 100');
    }
    // Fail-closed provider call: throws ProviderNotConfiguredError in the
    // default stub configuration, before any log is stored.
    await this.provider.submitReading({ pointId, ...input });
    const log: ColdChainLog = {
      id: newId('cold_chain_log'),
      pointId,
      recordedAt: input.recordedAt,
      temperatureCelsius: input.temperatureCelsius,
      humidityPercent: input.humidityPercent,
      source: this.provider.provider,
      createdAt: new Date().toISOString()
    };
    const created = await this.logs.create(log);
    await this.events.publish(
      'livestock_trade.cold_chain.reading_ingested',
      { pointId, logId: created.id, temperatureCelsius: input.temperatureCelsius },
      caller.id
    );
    return created;
  }

  async listLogs(actor: User | null, pointId: string): Promise<ColdChainLog[]> {
    const caller = requireActor(actor);
    const point = await this.points.getById(pointId);
    assertSelfOrAdmin(caller, point.managerUserId);
    const logs = await this.logs.find({ pointId });
    return logs.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
}
