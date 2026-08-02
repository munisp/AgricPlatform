import { Module } from '@nestjs/common';
import { PathwaysController } from './pathways.controller.js';
import { PathwaysService } from './pathways.service.js';

@Module({
  controllers: [PathwaysController],
  providers: [PathwaysService],
  exports: [PathwaysService]
})
export class PathwaysModule {}
