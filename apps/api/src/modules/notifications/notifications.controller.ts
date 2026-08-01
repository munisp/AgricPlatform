import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsString, ValidateNested } from 'class-validator';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationPreference,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin, isSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { NotificationsService, type SendNotificationInput } from './notifications.service.js';

class SendNotificationDto implements SendNotificationInput {
  @IsString()
  userId!: string;

  @IsIn(NOTIFICATION_CHANNELS)
  channel!: NotificationChannel;

  @IsString()
  title!: string;

  @IsString()
  body!: string;
}

class PreferenceItemDto {
  @IsIn(NOTIFICATION_CHANNELS)
  channel!: NotificationChannel;

  @IsBoolean()
  enabled!: boolean;
}

class SetPreferencesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PreferenceItemDto)
  preferences!: PreferenceItemDto[];
}

/**
 * Notification endpoints are authenticated; per-user resources are limited
 * to the owning user or an admin, and the cross-user delivery log is
 * admin-only.
 */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(RolesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'List notifications by user/status (own records or admin)' })
  async list(
    @CurrentUser() actor: User | null,
    @Query('userId') userId?: string,
    @Query('status') status?: NotificationMessage['status']
  ) {
    if (userId) {
      assertSelfOrAdmin(actor, userId);
    } else if (!actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing notifications across users requires the admin role');
    }
    return { data: await this.notifications.list({ userId, status }) };
  }

  @Post('send')
  @Authenticated()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a notification honouring user preferences and provider adapters' })
  async send(@Body() dto: SendNotificationDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.notifications.send(dto) };
  }

  @Post(':id/read')
  @Authenticated()
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markRead(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const message = await this.notifications.getMessage(id);
    assertSelfOrAdmin(actor, message.userId);
    return { data: await this.notifications.markRead(id) };
  }

  @Get('preferences/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Notification preferences for a user (own or admin)' })
  async preferences(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.notifications.preferencesFor(userId) };
  }

  @Put('preferences/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Replace notification preferences for a user (own or admin)' })
  async setPreferences(
    @Param('userId') userId: string,
    @Body() dto: SetPreferencesDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, userId);
    const prefs: NotificationPreference[] = dto.preferences.map((p) => ({
      userId,
      channel: p.channel,
      enabled: p.enabled
    }));
    return { data: await this.notifications.setPreferences(userId, prefs) };
  }

  @Get('deliveries')
  @Roles('admin')
  @ApiOperation({ summary: 'Delivery log across provider adapters (admin only)' })
  async deliveries() {
    return { data: await this.notifications.deliveries() };
  }
}
