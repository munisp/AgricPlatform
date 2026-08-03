import { Module } from '@nestjs/common';
import { FarmsModule } from '../farms/farms.module.js';
import { GeoIntelController } from './geo-intel.controller.js';
import { GeoIntelService } from './geo-intel.service.js';

/**
 * Wave ML (additive): geo-intelligence. Flood-risk assessments via the
 * driver port — deterministic stub fixture by default, the OPTIONAL
 * flood-ml sidecar when FLOOD_ML_DRIVER=http + FLOOD_ML_URL are set.
 */
@Module({
  imports: [FarmsModule],
  controllers: [GeoIntelController],
  providers: [GeoIntelService],
  exports: [GeoIntelService]
})
export class GeoIntelModule {}
