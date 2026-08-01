import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsString, ValidateNested } from 'class-validator';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationPreference
} from '@agric-platform/shared';
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

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List notifications by user/status' })
  list(@Query('userId') userId?: string, @Query('status') status?: NotificationMessage['status']) {
    return { data: this.notifications.list({ userId, status }) };
  }

  @Post('send')
  @ApiOperation({ summary: 'Send a notification honouring user preferences and provider adapters' })
  send(@Body() dto: SendNotificationDto) {
    return { data: this.notifications.send(dto) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  markRead(@Param('id') id: string) {
    return { data: this.notifications.markRead(id) };
  }

  @Get('preferences/:userId')
  @ApiOperation({ summary: 'Notification preferences for a user' })
  preferences(@Param('userId') userId: string) {
    return { data: this.notifications.preferencesFor(userId) };
  }

  @Put('preferences/:userId')
  @ApiOperation({ summary: 'Replace notification preferences for a user' })
  setPreferences(@Param('userId') userId: string, @Body() dto: SetPreferencesDto) {
    const prefs: NotificationPreference[] = dto.preferences.map((p) => ({
      userId,
      channel: p.channel,
      enabled: p.enabled
    }));
    return { data: this.notifications.setPreferences(userId, prefs) };
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'Delivery log across provider adapters' })
  deliveries() {
    return { data: this.notifications.deliveries() };
  }
}
