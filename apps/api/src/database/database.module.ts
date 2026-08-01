import { Global, Module } from '@nestjs/common';
import { PgPoolProvider } from './pg/pg-pool.provider.js';
import {
  ADVISORY_REPOSITORY,
  ANNOUNCEMENT_REPOSITORY,
  APPLICATION_REPOSITORY,
  AUDIT_REPOSITORY,
  CERTIFICATE_REPOSITORY,
  CHAPTER_EVENT_REPOSITORY,
  CHAPTER_REPOSITORY,
  CONSENT_REPOSITORY,
  COURSE_REPOSITORY,
  CREDIT_PROFILE_REPOSITORY,
  DELETION_REQUEST_REPOSITORY,
  DELIVERY_LOG_REPOSITORY,
  DOCUMENT_REPOSITORY,
  ENROLMENT_REPOSITORY,
  EVENT_RSVP_REPOSITORY,
  FORUM_TOPIC_REPOSITORY,
  LISTING_REPOSITORY,
  MENTOR_REQUEST_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OPPORTUNITY_REPOSITORY,
  ORDER_REPOSITORY,
  OUTBOX_REPOSITORY,
  PG_POOL,
  PROFILE_REPOSITORY,
  REVIEW_REPOSITORY,
  TOPIC_FLAG_REPOSITORY,
  USER_REPOSITORY
} from './persistence.tokens.js';
import { createInMemoryAdvisoryRepository } from './repositories/advisory.repository.js';
import { createInMemoryAnnouncementRepository } from './repositories/announcement.repository.js';
import { createInMemoryApplicationRepository } from './repositories/application.repository.js';
import { createInMemoryAuditRepository } from './repositories/audit.repository.js';
import { createInMemoryCertificateRepository } from './repositories/certificate.repository.js';
import { createInMemoryChapterEventRepository } from './repositories/chapter-event.repository.js';
import { createInMemoryChapterRepository } from './repositories/chapter.repository.js';
import { createInMemoryConsentRepository } from './repositories/consent.repository.js';
import { createInMemoryCourseRepository } from './repositories/course.repository.js';
import { createInMemoryCreditProfileRepository } from './repositories/credit-profile.repository.js';
import { createInMemoryDeletionRequestRepository } from './repositories/deletion-request.repository.js';
import { createInMemoryDeliveryLogRepository } from './repositories/delivery-log.repository.js';
import { createInMemoryDocumentRepository } from './repositories/document.repository.js';
import { createInMemoryEnrolmentRepository } from './repositories/enrolment.repository.js';
import { createInMemoryEventRsvpRepository } from './repositories/event-rsvp.repository.js';
import { createInMemoryForumTopicRepository } from './repositories/forum-topic.repository.js';
import { createInMemoryListingRepository } from './repositories/listing.repository.js';
import { createInMemoryMentorRequestRepository } from './repositories/mentor-request.repository.js';
import { createInMemoryNotificationPreferenceRepository } from './repositories/notification-preference.repository.js';
import { createInMemoryNotificationRepository } from './repositories/notification.repository.js';
import { createInMemoryOpportunityRepository } from './repositories/opportunity.repository.js';
import { createInMemoryOrderRepository } from './repositories/order.repository.js';
import { createInMemoryOutboxRepository } from './repositories/outbox.repository.js';
import { createInMemoryProfileRepository } from './repositories/profile.repository.js';
import { createInMemoryReviewRepository } from './repositories/review.repository.js';
import { createInMemoryTopicFlagRepository } from './repositories/topic-flag.repository.js';
import { createInMemoryUserRepository } from './repositories/user.repository.js';

/**
 * Global persistence module. Repository tokens resolve to the in-memory
 * implementations by default and to the pg implementations when
 * DATABASE_URL is configured (factories keyed off PG_POOL). Services depend
 * only on the port interfaces.
 */
@Global()
@Module({
  providers: [
    PgPoolProvider,
    { provide: PG_POOL, useFactory: (provider: PgPoolProvider) => provider.pool, inject: [PgPoolProvider] },
    { provide: USER_REPOSITORY, useFactory: createInMemoryUserRepository },
    { provide: PROFILE_REPOSITORY, useFactory: createInMemoryProfileRepository },
    { provide: CONSENT_REPOSITORY, useFactory: createInMemoryConsentRepository },
    { provide: DELETION_REQUEST_REPOSITORY, useFactory: createInMemoryDeletionRequestRepository },
    { provide: COURSE_REPOSITORY, useFactory: createInMemoryCourseRepository },
    { provide: ENROLMENT_REPOSITORY, useFactory: createInMemoryEnrolmentRepository },
    { provide: CERTIFICATE_REPOSITORY, useFactory: createInMemoryCertificateRepository },
    { provide: FORUM_TOPIC_REPOSITORY, useFactory: createInMemoryForumTopicRepository },
    { provide: MENTOR_REQUEST_REPOSITORY, useFactory: createInMemoryMentorRequestRepository },
    { provide: TOPIC_FLAG_REPOSITORY, useFactory: createInMemoryTopicFlagRepository },
    {
      provide: OPPORTUNITY_REPOSITORY,
      useFactory: createInMemoryOpportunityRepository
    },
    {
      provide: APPLICATION_REPOSITORY,
      useFactory: (opportunities: unknown) =>
        createInMemoryApplicationRepository(
          opportunities as Parameters<typeof createInMemoryApplicationRepository>[0]
        ),
      inject: [OPPORTUNITY_REPOSITORY]
    },
    { provide: CHAPTER_REPOSITORY, useFactory: createInMemoryChapterRepository },
    { provide: CHAPTER_EVENT_REPOSITORY, useFactory: createInMemoryChapterEventRepository },
    { provide: EVENT_RSVP_REPOSITORY, useFactory: createInMemoryEventRsvpRepository },
    { provide: ANNOUNCEMENT_REPOSITORY, useFactory: createInMemoryAnnouncementRepository },
    { provide: ADVISORY_REPOSITORY, useFactory: createInMemoryAdvisoryRepository },
    { provide: LISTING_REPOSITORY, useFactory: createInMemoryListingRepository },
    { provide: ORDER_REPOSITORY, useFactory: createInMemoryOrderRepository },
    { provide: REVIEW_REPOSITORY, useFactory: createInMemoryReviewRepository },
    { provide: CREDIT_PROFILE_REPOSITORY, useFactory: createInMemoryCreditProfileRepository },
    { provide: DOCUMENT_REPOSITORY, useFactory: createInMemoryDocumentRepository },
    { provide: NOTIFICATION_REPOSITORY, useFactory: createInMemoryNotificationRepository },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useFactory: createInMemoryNotificationPreferenceRepository
    },
    { provide: DELIVERY_LOG_REPOSITORY, useFactory: createInMemoryDeliveryLogRepository },
    { provide: AUDIT_REPOSITORY, useFactory: createInMemoryAuditRepository },
    { provide: OUTBOX_REPOSITORY, useFactory: createInMemoryOutboxRepository }
  ],
  exports: [
    PG_POOL,
    USER_REPOSITORY,
    PROFILE_REPOSITORY,
    CONSENT_REPOSITORY,
    DELETION_REQUEST_REPOSITORY,
    COURSE_REPOSITORY,
    ENROLMENT_REPOSITORY,
    CERTIFICATE_REPOSITORY,
    FORUM_TOPIC_REPOSITORY,
    MENTOR_REQUEST_REPOSITORY,
    TOPIC_FLAG_REPOSITORY,
    OPPORTUNITY_REPOSITORY,
    APPLICATION_REPOSITORY,
    CHAPTER_REPOSITORY,
    CHAPTER_EVENT_REPOSITORY,
    EVENT_RSVP_REPOSITORY,
    ANNOUNCEMENT_REPOSITORY,
    ADVISORY_REPOSITORY,
    LISTING_REPOSITORY,
    ORDER_REPOSITORY,
    REVIEW_REPOSITORY,
    CREDIT_PROFILE_REPOSITORY,
    DOCUMENT_REPOSITORY,
    NOTIFICATION_REPOSITORY,
    NOTIFICATION_PREFERENCE_REPOSITORY,
    DELIVERY_LOG_REPOSITORY,
    AUDIT_REPOSITORY,
    OUTBOX_REPOSITORY
  ]
})
export class DatabaseModule {}
