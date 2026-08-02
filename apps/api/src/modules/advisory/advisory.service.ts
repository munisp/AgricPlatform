import { Inject, Injectable } from '@nestjs/common';
import type { AdvisoryItem, ApiListResponse } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { ADVISORY_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  AdvisoryCriteria,
  AdvisoryRepository
} from '../../database/repositories/advisory.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { WeatherSnapshot } from '../integrations/adapters.js';

export interface CreateAdvisoryInput {
  kind: AdvisoryItem['kind'];
  title: string;
  summary: string;
  state?: string;
  crop?: string;
  severity?: AdvisoryItem['severity'];
}

export interface PriceSnapshot {
  crop: string;
  state?: string;
  pricePerTonneNaira: number;
  trend: 'rising' | 'stable' | 'falling';
  source: string;
}

@Injectable()
export class AdvisoryService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly integrations: IntegrationsService,
    @Inject(ADVISORY_REPOSITORY) private readonly items: AdvisoryRepository
  ) {}

  async list(
    filter: AdvisoryCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<AdvisoryItem>> {
    return this.items.searchPage(
      { kind: filter.kind, state: filter.state, crop: filter.crop },
      filter.page,
      filter.pageSize
    );
  }

  async all(): Promise<AdvisoryItem[]> {
    return this.items.all();
  }

  async get(id: string): Promise<AdvisoryItem> {
    return this.items.getById(id);
  }

  async create(input: CreateAdvisoryInput, actorId: string): Promise<AdvisoryItem> {
    const item: AdvisoryItem = {
      id: newId('adv'),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      state: input.state,
      crop: input.crop,
      severity: input.severity ?? 'info',
      publishedAt: new Date().toISOString()
    };
    const created = await this.items.create(item);
    await this.events.publish('advisory.content.published', { advisoryId: created.id, kind: created.kind }, actorId);
    return created;
  }

  /**
   * Weather readiness via the weather provider adapter. The stub driver
   * returns a deterministic fixture; a non-stub WEATHER_DRIVER resolves to
   * the live Open-Meteo feed (cached 15 minutes) — wave P1.
   */
  weatherFor(state: string): Promise<WeatherSnapshot> {
    return this.integrations.weatherSnapshot(state);
  }

  /** Local price signal fixture pending FEWS NET / exchange feed drivers. */
  priceFor(crop: string, state?: string): PriceSnapshot {
    const seed = [...crop].reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const base = 150000 + (seed % 20) * 25000;
    return {
      crop,
      state,
      pricePerTonneNaira: base,
      trend: seed % 3 === 0 ? 'rising' : seed % 3 === 1 ? 'stable' : 'falling',
      source: 'stub price adapter (FEWS NET / exchange feed in production)'
    };
  }
}
