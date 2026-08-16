import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { MentorRequest, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  CommunityService,
  type CreateMentorRequestInput,
  type CreateTopicInput
} from './community.service.js';

class ListTopicsQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  crop?: string;

  @IsOptional()
  @IsString()
  q?: string;
}

/**
 * The author is ALWAYS the authenticated actor — the client must not
 * supply an authorId (impersonation), so it is not part of the DTO.
 */
class CreateTopicDto implements Omit<CreateTopicInput, 'authorId'> {
  @IsString()
  title!: string;

  @IsString()
  category!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  crop?: string;
}

class FlagDto {
  @IsString()
  reason!: string;
}

class CreateMentorRequestDto implements CreateMentorRequestInput {
  @IsString()
  userId!: string;

  @IsString()
  crop!: string;

  @IsString()
  state!: string;

  @IsString()
  challenge!: string;
}

class MentorStatusDto {
  @IsIn(['requested', 'matched', 'closed'])
  status!: MentorRequest['status'];
}

/**
 * Forum catalog reads (topics) are public. All writes require an
 * authenticated actor, and authorship/reporting identity is derived from
 * that actor — never from the request body. Mentorship requests are
 * personal records (own records or admin).
 */
@ApiTags('community')
@Controller('community')
@UseGuards(RolesGuard)
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('topics')
  @ApiOperation({ summary: 'List forum topics with filters (public catalog)' })
  listTopics(@Query() query: ListTopicsQuery) {
    return this.community.listTopics(query);
  }

  @Post('topics')
  @Authenticated()
  @ApiOperation({ summary: 'Create a forum topic (authored by the authenticated user)' })
  async createTopic(@Body() dto: CreateTopicDto, @CurrentUser() actor: User | null) {
    return { data: await this.community.createTopic({ ...dto, authorId: actor!.id }) };
  }

  @Get('topics/:id')
  @ApiOperation({ summary: 'Topic detail (public catalog)' })
  async getTopic(@Param('id') id: string) {
    return { data: await this.community.getTopic(id) };
  }

  @Post('topics/:id/replies')
  @Authenticated()
  @ApiOperation({ summary: 'Reply to a topic as the authenticated user (increments reply count)' })
  async reply(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.community.reply(id, actor!.id) };
  }

  @Post('topics/:id/flag')
  @Authenticated()
  @ApiOperation({ summary: 'Flag a topic for moderation (reporter is the authenticated user)' })
  async flag(@Param('id') id: string, @Body() dto: FlagDto, @CurrentUser() actor: User | null) {
    return { data: await this.community.flag(id, actor!.id, dto.reason) };
  }

  @Post('mentors/requests')
  @Authenticated()
  @ApiOperation({ summary: 'Request a mentor (own user or admin)' })
  async createMentorRequest(@Body() dto: CreateMentorRequestDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.community.createMentorRequest(dto) };
  }

  @Get('mentors/requests')
  @Authenticated()
  @ApiOperation({ summary: 'List mentorship requests (own records or admin)' })
  async listMentorRequests(
    @CurrentUser() actor: User | null,
    @Query('userId') userId?: string,
    @Query('status') status?: MentorRequest['status']
  ) {
    if (userId) {
      assertSelfOrAdmin(actor, userId);
    } else if (!actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing mentorship requests across users requires the admin role');
    }
    return { data: await this.community.listMentorRequests({ userId, status }) };
  }

  @Patch('mentors/requests/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update mentorship request status (admin match/close workflow)' })
  async updateMentorRequest(@Param('id') id: string, @Body() dto: MentorStatusDto) {
    return { data: await this.community.updateMentorRequestStatus(id, dto.status) };
  }
}
