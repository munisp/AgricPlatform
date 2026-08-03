import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module.js';
import { FarmsController } from './farms.controller.js';
import { FarmsService } from './farms.service.js';
import { FarmsSyncEntities } from './farms-sync.js';

@Module({
  // W-SYNCWRITE: SyncModule provides the entity registry (farm_plot
  // descriptor registration) and the version-bump hook for REST writes.
  // SyncModule imports no feature modules, so there is no import cycle.
  imports: [SyncModule],
  controllers: [FarmsController],
  providers: [FarmsService, FarmsSyncEntities],
  exports: [FarmsService]
})
export class FarmsModule {}
