import { Module } from '@nestjs/common';
import { PrivacyModule } from '../privacy/privacy.module.js';
import { LivestockController } from './livestock.controller.js';
import { LivestockService } from './livestock.service.js';

@Module({
  imports: [PrivacyModule],
  controllers: [LivestockController],
  providers: [LivestockService],
  exports: [LivestockService]
})
export class LivestockModule {}
