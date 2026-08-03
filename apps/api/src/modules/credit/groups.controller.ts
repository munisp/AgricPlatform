import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { CreditGroupsService, type CreateCreditGroupInput } from './groups.service.js';

class CreateGroupDto implements CreateCreditGroupInput {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  chapterId?: string;
}

class AddMemberDto {
  @IsString()
  userId!: string;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/** VSLA/chama groups: creation, membership join/leave, leader administration. */
@ApiTags('credit')
@Controller('credit/groups')
export class CreditGroupsController {
  constructor(private readonly groups: CreditGroupsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Create a credit group (creator becomes leader)' })
  async create(@Body() dto: CreateGroupDto, @CurrentUser() actor: User | null) {
    return { data: await this.groups.createGroup(dto, requireActor(actor)) };
  }

  @Get()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List credit groups' })
  async list() {
    return { data: await this.groups.listGroups() };
  }

  @Get('mine')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Groups the caller belongs to (with members)' })
  async mine(@CurrentUser() actor: User | null) {
    return { data: await this.groups.listMyGroups(requireActor(actor)) };
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Group detail with members' })
  async get(@Param('id') id: string) {
    return { data: await this.groups.getGroup(id) };
  }

  @Post(':id/join')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Join a group as a member (idempotent)' })
  async join(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.groups.join(id, requireActor(actor)) };
  }

  @Post(':id/leave')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Leave a group (leader blocked while members remain)' })
  async leave(@Param('id') id: string, @CurrentUser() actor: User | null) {
    await this.groups.leave(id, requireActor(actor));
    return { data: { left: true } };
  }

  @Post(':id/members')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Add a member (group leader or admin)' })
  async addMember(
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.groups.addMember(id, dto.userId, requireActor(actor)) };
  }

  @Delete(':id/members/:userId')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Remove a member (group leader or admin; leader cannot be removed)' })
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() actor: User | null
  ) {
    await this.groups.removeMember(id, userId, requireActor(actor));
    return { data: { removed: true } };
  }
}
