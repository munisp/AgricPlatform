import { Module } from '@nestjs/common';
import { NinIdentityService } from './nin-identity.service.js';

/**
 * V-45 (duplicate identity, dim04-H3): global NIN anchoring, duplicate
 * detection report, account merge. Back-office service surface; report/merge
 * are admin actions driven through admin tooling.
 */
@Module({
  providers: [NinIdentityService],
  exports: [NinIdentityService]
})
export class IdentityModule {}
