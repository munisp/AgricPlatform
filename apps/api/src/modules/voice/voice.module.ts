import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdvisoryService } from '../advisory/advisory.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { LearningService } from '../learning/learning.service.js';
import { AgronomyRagService, RepositoryAgronomyCorpus } from './agronomy-rag.service.js';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';

/**
 * Voice agronomist (wave VOICE): IVR/USSD-first AI agronomy advisory with
 * human escalation. Retrieval is grounded in the repo's advisory/knowledge/
 * learning corpus (no external LLM, no vector DB); ASR and TTS are
 * fail-closed driver ports (stub default, live env-gated). Escalations open
 * agent cases worked from the agent-assist console (agronomist/admin).
 */
@Module({
  imports: [AdvisoryModule, KnowledgeModule, LearningModule, UsersModule],
  controllers: [VoiceController],
  providers: [
    {
      provide: AgronomyRagService,
      useFactory: (advisory: AdvisoryService, knowledge: KnowledgeService, learning: LearningService) =>
        new AgronomyRagService(new RepositoryAgronomyCorpus(advisory, knowledge, learning)),
      inject: [AdvisoryService, KnowledgeService, LearningService]
    },
    VoiceService
  ],
  exports: [VoiceService, AgronomyRagService]
})
export class VoiceModule {}
