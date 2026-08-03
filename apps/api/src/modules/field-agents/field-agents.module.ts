import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { FieldAgentsController } from './field-agents.controller.js';
import { FieldAgentsService } from './field-agents.service.js';

/**
 * Wave AGENTS: field-agent (enumerator) capability. Repository tokens resolve
 * through the global DatabaseModule; users/audit/events are global; the
 * profiles service backs on-behalf capture.
 */
@Module({
  imports: [ProfilesModule],
  controllers: [FieldAgentsController],
  providers: [FieldAgentsService],
  exports: [FieldAgentsService]
})
export class FieldAgentsModule {}
