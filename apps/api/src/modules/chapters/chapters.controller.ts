import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import type { Chapter, ChapterEvent, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  ChaptersService,
  type CreateAnnouncementInput,
  type CreateChapterInput,
  type CreateEventInput
} from './chapters.service.js';

class ListChaptersQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(['national', 'state', 'lga', 'ward'])
  level?: Chapter['level'];

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

class CreateChapterDto implements CreateChapterInput {
  @IsString()
  name!: string;

  @IsIn(['national', 'state', 'lga', 'ward'])
  level!: Chapter['level'];

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsString()
  state!: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsString()
  leadUserId?: string;
}

class CreateEventDto implements CreateEventInput {
  @IsString()
  title!: string;

  @IsIn(['meeting', 'training', 'field_visit', 'programme'])
  type!: ChapterEvent['type'];

  @IsISO8601()
  startsAt!: string;

  @IsString()
  location!: string;
}

class EventUserDto {
  @IsString()
  userId!: string;
}

class CreateAnnouncementDto implements CreateAnnouncementInput {
  @IsString()
  title!: string;

  @IsString()
  body!: string;

  @IsString()
  authorId!: string;
}

@ApiTags('chapters')
@Controller()
export class ChaptersController {
  constructor(private readonly chapters: ChaptersService) {}

  @Get('chapters')
  @ApiOperation({ summary: 'List chapters in the national/state/LGA/ward hierarchy' })
  list(@Query() query: ListChaptersQuery) {
    return this.chapters.list(query);
  }

  @Post('chapters')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Create a chapter (chapter leads and admins)' })
  create(@Body() dto: CreateChapterDto) {
    return { data: this.chapters.create(dto) };
  }

  @Get('chapters/:id')
  @ApiOperation({ summary: 'Chapter detail with child chapters' })
  get(@Param('id') id: string) {
    return { data: this.chapters.getWithChildren(id) };
  }

  @Get('chapters/:id/events')
  @ApiOperation({ summary: 'List chapter events' })
  listEvents(@Param('id') id: string) {
    return { data: this.chapters.listEvents(id) };
  }

  @Post('chapters/:id/events')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Create a chapter event (chapter leads and admins)' })
  createEvent(@Param('id') id: string, @Body() dto: CreateEventDto, @CurrentUser() actor: User | null) {
    return { data: this.chapters.createEvent(id, dto, actor?.id ?? 'anonymous') };
  }

  @Get('chapters/:id/announcements')
  @ApiOperation({ summary: 'List chapter announcements' })
  listAnnouncements(@Param('id') id: string) {
    return { data: this.chapters.listAnnouncements(id) };
  }

  @Post('chapters/:id/announcements')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Publish a chapter announcement (chapter leads and admins)' })
  createAnnouncement(
    @Param('id') id: string,
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, dto.authorId);
    return { data: this.chapters.createAnnouncement(id, dto) };
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Event detail' })
  getEvent(@Param('id') id: string) {
    return { data: this.chapters.getEvent(id) };
  }

  @Post('events/:id/rsvp')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'RSVP to a chapter event (own RSVP)' })
  rsvp(@Param('id') id: string, @Body() dto: EventUserDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: this.chapters.rsvp(id, dto.userId) };
  }

  @Post('events/:id/attendance')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Record event attendance (checked in by a chapter lead or admin)' })
  attendance(@Param('id') id: string, @Body() dto: EventUserDto) {
    return { data: this.chapters.recordAttendance(id, dto.userId) };
  }
}
