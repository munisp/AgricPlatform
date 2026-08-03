import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { ComplianceRetentionService } from './compliance-retention.service.js';
import { ComplianceController } from './compliance.controller.js';
import { ComplianceService } from './compliance.service.js';

/**
 * NDPA 2023 readiness tooling (Wave COMP). Repository tokens resolve through
 * the global DatabaseModule; audit/events through the global CoreModule.
 */
@Module({
  imports: [UsersModule],
  controllers: [ComplianceController],
  providers: [ComplianceService, ComplianceRetentionService],
  exports: [ComplianceService, ComplianceRetentionService]
})
export class ComplianceModule {}
