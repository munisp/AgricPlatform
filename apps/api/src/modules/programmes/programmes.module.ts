import { Module } from '@nestjs/common';
import { ProgrammesController } from './programmes.controller.js';
import { ProgrammesService } from './programmes.service.js';

@Module({
  controllers: [ProgrammesController],
  providers: [ProgrammesService],
  exports: [ProgrammesService]
})
export class ProgrammesModule {}
