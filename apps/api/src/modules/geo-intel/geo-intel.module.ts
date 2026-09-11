import { Module } from '@nestjs/common';
import { FarmsModule } from '../farms/farms.module.js';
import { GeoModule } from '../geo/geo.module.js';
import { ChapterMapController } from './chapter-map.controller.js';
import { ChapterMapService } from './chapter-map.service.js';
import { GeoIntelController } from './geo-intel.controller.js';
import { GeoIntelService } from './geo-intel.service.js';

/**
 * Wave ML (additive): geo-intelligence. Flood-risk assessments via the
 * driver port — deterministic stub fixture by default, the OPTIONAL
 * flood-ml sidecar when FLOOD_ML_DRIVER=http + FLOOD_ML_URL are set.
 * Innovation 10 (Stage 27) adds the Chapter Map ops view: a read-only
 * aggregation over geo-indexed data into the migration-068 snapshot cache,
 * flag-gated ('chapter-map', default OFF) and k-anonymity enforced.
 */
@Module({
  imports: [FarmsModule, GeoModule],
  controllers: [GeoIntelController, ChapterMapController],
  providers: [GeoIntelService, ChapterMapService],
  exports: [GeoIntelService, ChapterMapService]
})
export class GeoIntelModule {}
