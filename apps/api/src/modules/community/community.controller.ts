import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { MentorRequest } from '@agric-platform/shared';
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

class CreateTopicDto implements CreateTopicInput {
  @IsString()
  title!: string;

  @IsString()
  category!: string;

  @IsString()
  authorId!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  crop?: string;
}

class ReplyDto {
  @IsString()
  authorId!: string;
}

class FlagDto {
  @IsString()
  reporterId!: string;

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

@ApiTags('community')
@Controller('community')
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('topics')
  @ApiOperation({ summary: 'List forum topics with filters' })
  listTopics(@Query() query: ListTopicsQuery) {
    return this.community.listTopics(query);
  }

  @Post('topics')
  @ApiOperation({ summary: 'Create a forum topic' })
  createTopic(@Body() dto: CreateTopicDto) {
    return { data: this.community.createTopic(dto) };
  }

  @Get('topics/:id')
  @ApiOperation({ summary: 'Topic detail' })
  getTopic(@Param('id') id: string) {
    return { data: this.community.getTopic(id) };
  }

  @Post('topics/:id/replies')
  @ApiOperation({ summary: 'Reply to a topic (increments reply count)' })
  reply(@Param('id') id: string, @Body() dto: ReplyDto) {
    return { data: this.community.reply(id, dto.authorId) };
  }

  @Post('topics/:id/flag')
  @ApiOperation({ summary: 'Flag a topic for moderation' })
  flag(@Param('id') id: string, @Body() dto: FlagDto) {
    return { data: this.community.flag(id, dto.reporterId, dto.reason) };
  }

  @Post('mentors/requests')
  @ApiOperation({ summary: 'Request a mentor' })
  createMentorRequest(@Body() dto: CreateMentorRequestDto) {
    return { data: this.community.createMentorRequest(dto) };
  }

  @Get('mentors/requests')
  @ApiOperation({ summary: 'List mentorship requests' })
  listMentorRequests(@Query('userId') userId?: string, @Query('status') status?: MentorRequest['status']) {
    return { data: this.community.listMentorRequests({ userId, status }) };
  }

  @Patch('mentors/requests/:id')
  @ApiOperation({ summary: 'Update mentorship request status (match/close)' })
  updateMentorRequest(@Param('id') id: string, @Body() dto: MentorStatusDto) {
    return { data: this.community.updateMentorRequestStatus(id, dto.status) };
  }
}
