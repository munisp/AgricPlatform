import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  ValidationPipe
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { SyncService } from './sync.service.js';
import {
  SYNC_CLIENT_MUTATION_ID_MAX_LENGTH,
  SYNC_ENTITY_ID_MAX_LENGTH,
  SYNC_PULL_LIMIT_MAX,
  SYNC_PUSH_BATCH_LIMIT,
  SYNC_PUSH_PAYLOAD_MAX_BYTES,
  type SyncPushItem,
  type SyncPushItemResult,
  type SyncPullPage,
  type SyncStatusEntry
} from './sync.types.js';

class SyncPushItemDto implements SyncPushItem {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entity!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(SYNC_ENTITY_ID_MAX_LENGTH)
  entityId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(SYNC_CLIENT_MUTATION_ID_MAX_LENGTH)
  clientMutationId!: string;

  @IsInt()
  @Min(0)
  baseVersion!: number;

  @IsIn(['upsert', 'delete'])
  op!: SyncPushItem['op'];

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

class SyncPushBody {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SYNC_PUSH_BATCH_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => SyncPushItemDto)
  items!: SyncPushItemDto[];
}

class SyncPullQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entity!: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? 0 : Number(value)))
  @IsInt()
  @Min(0)
  since?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(SYNC_PULL_LIMIT_MAX)
  limit?: number;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for sync endpoints');
  }
  return actor;
}

/**
 * Sync protocol v1 (Wave SYNCSRV; docs/sync-protocol.md). All routes require
 * an authenticated identity; every operation is scoped to the caller.
 */
@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @Authenticated()
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Push a batch of offline mutations (idempotent per clientMutationId)' })
  async push(
    @Body(new ValidationPipe({ whitelist: true, transform: true })) body: SyncPushBody,
    @CurrentUser() actor: User | null
  ): Promise<{ data: { results: SyncPushItemResult[] } }> {
    const caller = requireActor(actor);
    for (const item of body.items) {
      if (item.op === 'upsert') {
        if (!item.payload) {
          throw new BadRequestException('upsert items require a payload');
        }
        const bytes = Buffer.byteLength(JSON.stringify(item.payload), 'utf8');
        if (bytes > SYNC_PUSH_PAYLOAD_MAX_BYTES) {
          throw new BadRequestException(
            `payload exceeds the ${SYNC_PUSH_PAYLOAD_MAX_BYTES}-byte per-item limit`
          );
        }
      }
    }
    const results = await this.sync.push(caller, body.items);
    return { data: { results } };
  }

  @Get('pull')
  @Authenticated()
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Pull owner-scoped changes since a cursor (version-ordered, tombstoned)' })
  async pull(
    @Query(new ValidationPipe({ transform: true })) query: SyncPullQuery,
    @CurrentUser() actor: User | null
  ): Promise<{ data: SyncPullPage }> {
    const caller = requireActor(actor);
    const page = await this.sync.pull(caller, query.entity, query.since ?? 0, query.limit);
    return { data: page };
  }

  @Get('status')
  @Authenticated()
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Per-entity server max version + recorded cursor for the caller' })
  async status(@CurrentUser() actor: User | null): Promise<{ data: SyncStatusEntry[] }> {
    const caller = requireActor(actor);
    return { data: await this.sync.status(caller) };
  }
}
