import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { LANGUAGE_CODES, type Course, type LanguageCode } from '@agric-platform/shared';
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

@ApiTags('learning')
@Controller()
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly users: UsersService
  ) {}

  @Get('courses')
  @ApiOperation({ summary: 'List courses with filters' })
  listCourses(@Query() query: ListCoursesQuery) {
    return this.learning.listCourses(query);
  }

  @Post('courses')
  @ApiOperation({ summary: 'Create a course (content team)' })
  createCourse(@Body() dto: CreateCourseDto) {
    return { data: this.learning.createCourse(dto) };
  }

  @Get('courses/:id')
  @ApiOperation({ summary: 'Course detail' })
  getCourse(@Param('id') id: string) {
    return { data: this.learning.getCourse(id) };
  }

  @Post('courses/:id/enrol')
  @ApiOperation({ summary: 'Enrol a user in a course' })
  enrol(@Param('id') id: string, @Body() dto: EnrolDto) {
    return { data: this.learning.enrol(id, dto.userId) };
  }

  @Get('enrolments/:id')
  @ApiOperation({ summary: 'Enrolment detail' })
  getEnrolment(@Param('id') id: string) {
    return { data: this.learning.getEnrolment(id) };
  }

  @Patch('enrolments/:id/progress')
  @ApiOperation({ summary: 'Update enrolment progress; issues a certificate at 100%' })
  updateProgress(@Param('id') id: string, @Body() dto: ProgressDto) {
    return { data: this.learning.updateProgress(id, dto.progressPercent) };
  }

  @Get('users/:userId/enrolments')
  @ApiOperation({ summary: 'Enrolments for a user' })
  enrolmentsForUser(@Param('userId') userId: string) {
    return { data: this.learning.enrolmentsForUser(userId) };
  }

  @Get('users/:userId/certificates')
  @ApiOperation({ summary: 'Certificates earned by a user' })
  certificatesForUser(@Param('userId') userId: string) {
    return { data: this.learning.certificatesForUser(userId) };
  }

  @Get('certificates/verify/:code')
  @ApiOperation({ summary: 'Verify a certificate by its public verification code' })
  verifyCertificate(@Param('code') code: string) {
    return {
      data: this.learning.verifyCertificate(code, (userId) => this.users.findById(userId)?.fullName)
    };
  }
}
