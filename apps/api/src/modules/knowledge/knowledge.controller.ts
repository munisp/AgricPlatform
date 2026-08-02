import { Body, Controller, Get, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { KnowledgeFormat, LanguageCode, User, WebinarStatus } from '@agric-platform/shared';
import { KNOWLEDGE_FORMATS, LANGUAGE_CODES, WEBINAR_STATUSES } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  KnowledgeService,
  type CreateEpisodeInput,
  type CreateResourceInput,
  type CreateWebinarInput
} from './knowledge.service.js';

class ListResourcesQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  language?: LanguageCode;

  @IsOptional()
  @IsIn(KNOWLEDGE_FORMATS)
  format?: KnowledgeFormat;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  offlineAvailable?: boolean;
}

class CreateResourceDto implements CreateResourceInput {
  @IsString()
  title!: string;

  @IsString()
  body!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  language?: LanguageCode;

  @IsIn(KNOWLEDGE_FORMATS)
  format!: KnowledgeFormat;

  @IsOptional()
  @IsBoolean()
  offlineAvailable?: boolean;
}

class CreateEpisodeDto implements CreateEpisodeInput {
  @IsString()
  title!: string;

  @IsString()
  showNotes!: string;

  @IsUrl({ require_protocol: true })
  audioUrl!: string;

  @IsInt()
  @Min(1)
  durationSeconds!: number;

  @IsOptional()
  @IsString()
  transcript?: string;
}

class TranscriptDto {
  @IsString()
  transcript!: string;
}

class CreateWebinarDto implements CreateWebinarInput {
  @IsString()
  title!: string;

  @IsString()
  hostUserId!: string;

  @IsISO8601()
  startsAt!: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

class SetWebinarStatusDto {
  @IsIn(WEBINAR_STATUSES)
  status!: WebinarStatus;
}

class RecordingDto {
  @IsUrl({ require_protocol: true })
  recordingUrl!: string;
}

class RegisterDto {
  @IsString()
  userId!: string;
}

@ApiTags('knowledge')
@Controller()
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('knowledge-resources')
  @ApiOperation({ summary: 'List knowledge resources (tag / language / format / offline filters)' })
  listResources(@Query() query: ListResourcesQuery) {
    return this.knowledge.listResources(query);
  }

  @Post('knowledge-resources')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Publish a knowledge resource (partners and admins)' })
  async createResource(@Body() dto: CreateResourceDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.createResource(dto, actor?.id ?? 'anonymous') };
  }

  @Get('knowledge-resources/:id')
  @ApiOperation({ summary: 'Resource detail' })
  async getResource(@Param('id') id: string) {
    return { data: await this.knowledge.getResource(id) };
  }

  @Post('knowledge-resources/:id/view')
  @ApiOperation({ summary: 'Record a resource view (increments the view count)' })
  async recordView(@Param('id') id: string) {
    return { data: await this.knowledge.recordView(id) };
  }

  @Get('podcast-episodes')
  @ApiOperation({ summary: 'List podcast episodes' })
  async listEpisodes() {
    return { data: await this.knowledge.listEpisodes() };
  }

  @Post('podcast-episodes')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Publish a podcast episode (transcript supported for accessibility)' })
  async createEpisode(@Body() dto: CreateEpisodeDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.createEpisode(dto, actor?.id ?? 'anonymous') };
  }

  @Get('podcast-episodes/:id')
  @ApiOperation({ summary: 'Podcast episode detail' })
  async getEpisode(@Param('id') id: string) {
    return { data: await this.knowledge.getEpisode(id) };
  }

  @Post('podcast-episodes/:id/transcript')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Attach or replace the episode transcript (accessibility requirement)' })
  async setTranscript(@Param('id') id: string, @Body() dto: TranscriptDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.setTranscript(id, dto.transcript, actor?.id ?? 'anonymous') };
  }

  @Get('webinars')
  @ApiOperation({ summary: 'List webinars (status filter)' })
  async listWebinars(@Query('status') status?: WebinarStatus) {
    return { data: await this.knowledge.listWebinars({ status }) };
  }

  @Post('webinars')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Schedule a webinar (IANA timezone, default Africa/Lagos)' })
  async createWebinar(@Body() dto: CreateWebinarDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.createWebinar(dto, actor?.id ?? 'anonymous') };
  }

  // Declared before `webinars/:id` so 'mine' is not captured as an id.
  @Get('webinars/mine/registrations')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List the current user\'s webinar registrations' })
  async listMyRegistrations(@CurrentUser() actor: User | null) {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    return { data: await this.knowledge.listMyRegistrations(actor.id) };
  }

  @Get('webinars/:id')
  @ApiOperation({ summary: 'Webinar detail' })
  async getWebinar(@Param('id') id: string) {
    return { data: await this.knowledge.getWebinar(id) };
  }

  @Post('webinars/:id/status')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Drive the webinar lifecycle (scheduled → live → completed, or cancelled)' })
  async setWebinarStatus(@Param('id') id: string, @Body() dto: SetWebinarStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.setWebinarStatus(id, dto.status, actor?.id ?? 'anonymous') };
  }

  @Post('webinars/:id/recording')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Attach the recording URL once the webinar has completed' })
  async attachRecording(@Param('id') id: string, @Body() dto: RecordingDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.attachRecording(id, dto.recordingUrl, actor?.id ?? 'anonymous') };
  }

  @Post('webinars/:id/registrations')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Register for a scheduled webinar (own registration)' })
  async register(@Param('id') id: string, @Body() dto: RegisterDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.knowledge.registerForWebinar(id, dto.userId) };
  }

  @Get('webinars/:id/registrations')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'List webinar registrations (partners and admins)' })
  async listRegistrations(@Param('id') id: string) {
    return { data: await this.knowledge.listRegistrations(id) };
  }
}
