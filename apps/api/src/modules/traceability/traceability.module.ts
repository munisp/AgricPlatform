import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module.js';
import { FarmsModule } from '../farms/farms.module.js';
import { GeoIntelModule } from '../geo-intel/geo-intel.module.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { TraceabilityPartnerController } from './traceability-partner.controller.js';
import { TraceabilityController } from './traceability.controller.js';
import { TraceabilityService } from './traceability.service.js';

/**
 * EUDR traceability passport (wave-eudr, migrations 029/030). Repository
 * tokens resolve through the global DatabaseModule; audit/events through the
 * global CoreModule. FarmsModule provides plot geometry for the immutable
 * snapshots, GeoIntelModule the (stub-by-default, fail-closed) environmental
 * risk port, PartnerApiModule the API-key guard reused by the exporter
 * surface.
 */
@Module({
  imports: [CoreModule, FarmsModule, GeoIntelModule, PartnerApiModule],
  controllers: [TraceabilityController, TraceabilityPartnerController],
  providers: [TraceabilityService],
  exports: [TraceabilityService]
})
export class TraceabilityModule {}
