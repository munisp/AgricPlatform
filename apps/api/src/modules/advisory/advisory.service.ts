import { Injectable } from '@nestjs/common';
import type { AdvisoryItem, ApiListResponse } from '@agric-platform/shared';
import { seedAdvisory } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
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
  private readonly items = new InMemoryRepository<AdvisoryItem>(seedAdvisory);

  constructor(
    private readonly events: DomainEventsService,
    private readonly integrations: IntegrationsService
  ) {}

  list(filter: {
    kind?: AdvisoryItem['kind'];
    state?: string;
    crop?: string;
    page?: number;
    pageSize?: number;
  }): ApiListResponse<AdvisoryItem> {
    let items = this.items.all();
    if (filter.kind) items = items.filter((i) => i.kind === filter.kind);
    if (filter.state) items = items.filter((i) => i.state === filter.state);
    if (filter.crop) items = items.filter((i) => i.crop === filter.crop);
    return paginate(items, filter.page, filter.pageSize);
  }

  all(): AdvisoryItem[] {
    return this.items.all();
  }

  get(id: string): AdvisoryItem {
    return this.items.getById(id);
  }

  create(input: CreateAdvisoryInput, actorId: string): AdvisoryItem {
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
    const created = this.items.create(item);
    this.events.publish('advisory.content.published', { advisoryId: created.id, kind: created.kind }, actorId);
    return created;
  }

  /** Weather readiness via the weather provider adapter (stub: deterministic). */
  weatherFor(state: string): WeatherSnapshot {
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
