import { Module } from '@nestjs/common';
import { SuccessionService } from './succession.service.js';

/**
 * V-09 (deceased/succession, dim04-H1): deceased account status, next-of-kin
 * claims, estate-scoped read/transfer. Read/transfer surface is the service
 * (admin/agent tooling); no public controller — estate operations are
 * back-office actions driven through admin tooling.
 */
@Module({
  providers: [SuccessionService],
  exports: [SuccessionService]
})
export class SuccessionModule {}
