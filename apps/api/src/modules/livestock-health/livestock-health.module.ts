import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { GovernmentDiseaseNotificationAdapter } from './disease-notification.adapter.js';
import { LivestockHealthController } from './livestock-health.controller.js';
import { LivestockHealthService } from './livestock-health.service.js';
import { RecallNotificationsListener } from './recall-notifications.listener.js';

@Module({
  imports: [NotificationsModule],
  controllers: [LivestockHealthController],
  providers: [LivestockHealthService, GovernmentDiseaseNotificationAdapter, RecallNotificationsListener],
  exports: [LivestockHealthService]
})
export class LivestockHealthModule {}
