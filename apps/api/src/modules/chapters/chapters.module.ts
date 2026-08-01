import { Module } from '@nestjs/common';
import { ChaptersController } from './chapters.controller.js';
import { ChaptersService } from './chapters.service.js';

@Module({
  controllers: [ChaptersController],
  providers: [ChaptersService],
  exports: [ChaptersService]
})
export class ChaptersModule {}
