import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller.js';
import { GeoService } from './geo.service.js';
import { H3Service } from './h3.service.js';

/**
 * Geospatial pack (Wave GEO, migration 026). H3-based spatial indexing
 * computed in the application layer — no PostGIS. Repository tokens resolve
 * via the global DatabaseModule; audit + domain events via the global
 * CoreModule.
 */
@Module({
  controllers: [GeoController],
  providers: [GeoService, H3Service],
  exports: [GeoService, H3Service]
})
export class GeoModule {}
