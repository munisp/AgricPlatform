import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
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

class ScanAttendanceDto {
  /** Signed QR code payload (v1.<eventId>.<window>.<hmac>). */
  @IsString()
  code!: string;

  /**
   * Member being checked in. Defaults to the authenticated caller (self
   * scan); checking in someone else requires an admin or chapter lead.
   */
  @IsOptional()
  @IsString()
  memberId?: string;
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
  async create(@Body() dto: CreateChapterDto) {
    return { data: await this.chapters.create(dto) };
  }

  @Get('chapters/:id')
  @ApiOperation({ summary: 'Chapter detail with child chapters' })
  async get(@Param('id') id: string) {
    return { data: await this.chapters.getWithChildren(id) };
  }

  @Get('chapters/:id/events')
  @ApiOperation({ summary: 'List chapter events' })
  async listEvents(@Param('id') id: string) {
    return { data: await this.chapters.listEvents(id) };
  }

  @Post('chapters/:id/events')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Create a chapter event (chapter leads and admins)' })
  async createEvent(@Param('id') id: string, @Body() dto: CreateEventDto, @CurrentUser() actor: User | null) {
    return { data: await this.chapters.createEvent(id, dto, actor?.id ?? 'anonymous') };
  }

  @Get('chapters/:id/announcements')
  @ApiOperation({ summary: 'List chapter announcements' })
  async listAnnouncements(@Param('id') id: string) {
    return { data: await this.chapters.listAnnouncements(id) };
  }

  @Post('chapters/:id/announcements')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Publish a chapter announcement (chapter leads and admins)' })
  async createAnnouncement(
    @Param('id') id: string,
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, dto.authorId);
    return { data: await this.chapters.createAnnouncement(id, dto) };
  }

  @Get('events/:id/roster')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({
    summary: 'Event attendance roster (RSVP list with member names; chapter leads and admins)'
  })
  async eventRoster(@Param('id') id: string) {
    return { data: await this.chapters.eventRoster(id) };
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Event detail' })
  async getEvent(@Param('id') id: string) {
    return { data: await this.chapters.getEvent(id) };
  }

  @Post('events/:id/rsvp')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'RSVP to a chapter event (own RSVP)' })
  async rsvp(@Param('id') id: string, @Body() dto: EventUserDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.chapters.rsvp(id, dto.userId) };
  }

  @Post('events/:id/attendance')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Record event attendance (checked in by a chapter lead or admin)' })
  async attendance(@Param('id') id: string, @Body() dto: EventUserDto) {
    return { data: await this.chapters.recordAttendance(id, dto.userId) };
  }

  @Get('events/:id/attendance-code')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead')
  @ApiOperation({
    summary:
      'Signed QR attendance code for an event (rotating 15-minute window; chapter leads and admins)'
  })
  async attendanceCode(@Param('id') id: string) {
    return { data: await this.chapters.issueAttendanceCode(id) };
  }

  @Post('events/:id/attendance/scan')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({
    summary:
      'Check in to an event by scanning its signed QR code. Duplicate scans for the same member return 409; retries with the same Idempotency-Key replay the first response.'
  })
  async scanAttendance(
    @Param('id') id: string,
    @Body() dto: ScanAttendanceDto,
    @CurrentUser() actor: User | null
  ) {
    if (!actor) {
      throw new UnauthorizedException('Authentication required to scan attendance');
    }
    const memberId = dto.memberId ?? actor.id;
    if (
      memberId !== actor.id &&
      !actor.roles.includes('admin') &&
      !actor.roles.includes('chapter_lead')
    ) {
      throw new ForbiddenException('Only chapter leads and admins can check in another member');
    }
    return { data: await this.chapters.scanAttendance(id, dto.code, memberId, actor.id) };
  }
}
