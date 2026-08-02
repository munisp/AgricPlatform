import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { COMMODITY_PRICE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { CommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { LearningService } from '../learning/learning.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';

/**
 * Anonymous, read-only embed feed for the public widgets
 * (apps/web/public/widgets/*.js, wave P5d). Responses contain no PII, are
 * CORS-open (`Access-Control-Allow-Origin: *`) and carry cache-friendly
 * headers so third-party pages can poll cheaply.
 */
@ApiTags('embed')
@Controller('embed')
export class EmbedController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly learning: LearningService,
    @Inject(COMMODITY_PRICE_REPOSITORY) private readonly prices: CommodityPriceRepository
  ) {}

  @Get('opportunities')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Public opportunity directory for embeds (no PII)' })
  async opportunityDirectory(@Query('limit') limit?: string) {
    const cap = Math.min(Number(limit) || 20, 50);
    const all = await this.opportunities.all();
    const open = all
      .filter((opportunity) => opportunity.deadline >= new Date().toISOString().slice(0, 10))
      .slice(0, cap)
      .map((opportunity) => ({
        id: opportunity.id,
        title: opportunity.title,
        type: opportunity.type,
        states: opportunity.states ?? [],
        deadline: opportunity.deadline
      }));
    return { data: open, generatedAt: new Date().toISOString() };
  }

  @Get('prices')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Latest commodity price observations (ticker feed)' })
  async priceTicker(@Query('limit') limit?: string) {
    const cap = Math.min(Number(limit) || 30, 100);
    const latest = (await this.prices.all())
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .slice(0, cap)
      .map((price) => ({
        commodity: price.commodity,
        market: price.market,
        state: price.state,
        priceNgn: price.priceNgn,
        observedAt: price.observedAt
      }));
    return { data: latest, generatedAt: new Date().toISOString() };
  }

  @Get('courses')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Course catalogue for embeds (no PII)' })
  async courseCatalogue(@Query('limit') limit?: string) {
    const cap = Math.min(Number(limit) || 20, 50);
    const courses = (await this.learning.allCourses()).slice(0, cap).map((course) => ({
      id: course.id,
      title: course.title,
      category: course.category,
      level: course.level,
      durationMinutes: course.durationMinutes,
      language: course.language
    }));
    return { data: courses, generatedAt: new Date().toISOString() };
  }

  @Get('member-cta')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'NYFN member registration button configuration' })
  memberCta() {
    return {
      data: {
        label: 'Register as NYFN Member',
        href: '/onboarding',
        description:
          'Join the Nigeria Youth Farmers Network to access opportunities, training and markets.'
      }
    };
  }
}
