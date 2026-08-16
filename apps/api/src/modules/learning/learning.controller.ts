import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LANGUAGE_CODES, type Course, type LanguageCode, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { UsersService } from '../users/users.service.js';
import { LearningService, type CreateCourseInput } from './learning.service.js';

class ListCoursesQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsIn(['beginner', 'intermediate', 'advanced'])
  level?: Course['level'];

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  language?: LanguageCode;

  @IsOptional()
  @IsString()
  q?: string;
}

class CreateCourseDto implements CreateCourseInput {
  @IsString()
  title!: string;

  @IsString()
  category!: string;

  @IsIn(['beginner', 'intermediate', 'advanced'])
  level!: Course['level'];

  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @IsIn(LANGUAGE_CODES)
  language!: LanguageCode;

  @IsOptional()
  @IsBoolean()
  offlineAvailable?: boolean;
}

class EnrolDto {
  @IsString()
  userId!: string;
}

class ProgressDto {
  @IsInt()
  @Min(0)
  @Max(100)
  progressPercent!: number;
}

/**
 * Course catalog reads and certificate verification are public. Enrolments,
 * progress and per-user learning records are personal data — restricted to
 * the owning user or an admin. Course authoring is admin-only.
 */
@ApiTags('learning')
@Controller()
@UseGuards(RolesGuard)
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly users: UsersService
  ) {}

  @Get('courses')
  @ApiOperation({ summary: 'List courses with filters (public catalog)' })
  listCourses(@Query() query: ListCoursesQuery) {
    return this.learning.listCourses(query);
  }

  @Post('courses')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a course (admin content team)' })
  async createCourse(@Body() dto: CreateCourseDto) {
    return { data: await this.learning.createCourse(dto) };
  }

  @Get('courses/:id')
  @ApiOperation({ summary: 'Course detail (public catalog)' })
  async getCourse(@Param('id') id: string) {
    return { data: await this.learning.getCourse(id) };
  }

  @Post('courses/:id/enrol')
  @Authenticated()
  @ApiOperation({ summary: 'Enrol a user in a course (own user or admin)' })
  async enrol(@Param('id') id: string, @Body() dto: EnrolDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.learning.enrol(id, dto.userId) };
  }

  @Get('enrolments/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Enrolment detail (owning user or admin)' })
  async getEnrolment(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const enrolment = await this.learning.getEnrolment(id);
    assertSelfOrAdmin(actor, enrolment.userId);
    return { data: enrolment };
  }

  @Patch('enrolments/:id/progress')
  @Authenticated()
  @ApiOperation({ summary: 'Update enrolment progress; issues a certificate at 100% (owning user or admin)' })
  async updateProgress(
    @Param('id') id: string,
    @Body() dto: ProgressDto,
    @CurrentUser() actor: User | null
  ) {
    const enrolment = await this.learning.getEnrolment(id);
    assertSelfOrAdmin(actor, enrolment.userId);
    return { data: await this.learning.updateProgress(id, dto.progressPercent) };
  }

  @Get('users/:userId/enrolments')
  @Authenticated()
  @ApiOperation({ summary: 'Enrolments for a user (own records or admin)' })
  async enrolmentsForUser(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.learning.enrolmentsForUser(userId) };
  }

  @Get('users/:userId/certificates')
  @Authenticated()
  @ApiOperation({ summary: 'Certificates earned by a user (own records or admin)' })
  async certificatesForUser(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.learning.certificatesForUser(userId) };
  }

  @Get('certificates/verify/:code')
  @ApiOperation({ summary: 'Verify a certificate by its public verification code (public)' })
  async verifyCertificate(@Param('code') code: string) {
    return {
      data: await this.learning.verifyCertificate(
        code,
        async (userId) => (await this.users.findById(userId))?.fullName
      )
    };
  }
}
