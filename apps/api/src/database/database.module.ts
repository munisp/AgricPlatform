import { Global, Module } from '@nestjs/common';
import type pg from 'pg';
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
import { createPgAdvisoryRepository } from './repositories/advisory.pg-repository.js';
import { createInMemoryAnnouncementRepository } from './repositories/announcement.repository.js';
import { createInMemoryApplicationRepository } from './repositories/application.repository.js';
import { createInMemoryAuditRepository } from './repositories/audit.repository.js';
import { createInMemoryCertificateRepository } from './repositories/certificate.repository.js';
import { createInMemoryChapterEventRepository } from './repositories/chapter-event.repository.js';
import { createInMemoryChapterRepository } from './repositories/chapter.repository.js';
import {
  createPgAnnouncementRepository,
  createPgChapterEventRepository,
  createPgChapterRepository,
  createPgEventRsvpRepository
} from './repositories/chapters.pg-repository.js';
import { createInMemoryConsentRepository } from './repositories/consent.repository.js';
import { createInMemoryCourseRepository } from './repositories/course.repository.js';
import { createInMemoryCreditProfileRepository } from './repositories/credit-profile.repository.js';
import { createInMemoryDeletionRequestRepository } from './repositories/deletion-request.repository.js';
import { createInMemoryDeliveryLogRepository } from './repositories/delivery-log.repository.js';
import { createInMemoryDocumentRepository } from './repositories/document.repository.js';
import { createInMemoryEnrolmentRepository } from './repositories/enrolment.repository.js';
import { createInMemoryEventRsvpRepository } from './repositories/event-rsvp.repository.js';
import { createInMemoryForumTopicRepository } from './repositories/forum-topic.repository.js';
import {
  createPgCreditProfileRepository,
  createPgDocumentRepository
} from './repositories/finance.pg-repository.js';
import {
  createPgCertificateRepository,
  createPgCourseRepository,
  createPgEnrolmentRepository
} from './repositories/learning.pg-repository.js';
import { createInMemoryListingRepository } from './repositories/listing.repository.js';
import {
  createPgListingRepository,
  createPgOrderRepository,
  createPgReviewRepository
} from './repositories/marketplace.pg-repository.js';
import { createInMemoryMentorRequestRepository } from './repositories/mentor-request.repository.js';
import { createInMemoryNotificationPreferenceRepository } from './repositories/notification-preference.repository.js';
import { createInMemoryNotificationRepository } from './repositories/notification.repository.js';
import {
  createPgDeliveryLogRepository,
  createPgNotificationPreferenceRepository,
  createPgNotificationRepository
} from './repositories/notifications.pg-repository.js';
import { createInMemoryOpportunityRepository } from './repositories/opportunity.repository.js';
import {
  createPgApplicationRepository,
  createPgOpportunityRepository
} from './repositories/opportunities.pg-repository.js';
import { createInMemoryOrderRepository } from './repositories/order.repository.js';
import { createInMemoryOutboxRepository } from './repositories/outbox.repository.js';
import { createInMemoryProfileRepository } from './repositories/profile.repository.js';
import { createPgProfileRepository } from './repositories/profile.pg-repository.js';
import {
  createPgConsentRepository,
  createPgDeletionRequestRepository
} from './repositories/privacy.pg-repository.js';
import {
  createPgAuditRepository,
  createPgOutboxRepository
} from './repositories/core.pg-repository.js';
import { createInMemoryReviewRepository } from './repositories/review.repository.js';
import {
  createPgForumTopicRepository,
  createPgMentorRequestRepository,
  createPgTopicFlagRepository
} from './repositories/community.pg-repository.js';
import { createInMemoryTopicFlagRepository } from './repositories/topic-flag.repository.js';
import { createInMemoryUserRepository } from './repositories/user.repository.js';
import { createPgUserRepository } from './repositories/user.pg-repository.js';

/**
 * Global persistence module. Repository tokens resolve to the pg
 * implementations when PG_POOL is live (DATABASE_URL configured) and to the
 * in-memory implementations otherwise. Services depend only on the port
 * interfaces.
 */
@Global()
@Module({
  providers: [
    PgPoolProvider,
    { provide: PG_POOL, useFactory: (provider: PgPoolProvider) => provider.pool, inject: [PgPoolProvider] },
    {
      provide: USER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgUserRepository(pool) : createInMemoryUserRepository()),
      inject: [PG_POOL]
    },
    {
      provide: PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgProfileRepository(pool) : createInMemoryProfileRepository()),
      inject: [PG_POOL]
    },
    {
      provide: CONSENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgConsentRepository(pool) : createInMemoryConsentRepository()),
      inject: [PG_POOL]
    },
    {
      provide: DELETION_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDeletionRequestRepository(pool) : createInMemoryDeletionRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: COURSE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgCourseRepository(pool) : createInMemoryCourseRepository()),
      inject: [PG_POOL]
    },
    {
      provide: ENROLMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null, certificates: unknown) =>
        pool
          ? createPgEnrolmentRepository(pool)
          : createInMemoryEnrolmentRepository(
              certificates as Parameters<typeof createInMemoryEnrolmentRepository>[0]
            ),
      inject: [PG_POOL, CERTIFICATE_REPOSITORY]
    },
    {
      provide: CERTIFICATE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCertificateRepository(pool) : createInMemoryCertificateRepository(),
      inject: [PG_POOL]
    },
    {
      provide: FORUM_TOPIC_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgForumTopicRepository(pool) : createInMemoryForumTopicRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MENTOR_REQUEST_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMentorRequestRepository(pool) : createInMemoryMentorRequestRepository(),
      inject: [PG_POOL]
    },
    {
      provide: TOPIC_FLAG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgTopicFlagRepository(pool) : createInMemoryTopicFlagRepository(),
      inject: [PG_POOL]
    },
    {
      provide: OPPORTUNITY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOpportunityRepository(pool) : createInMemoryOpportunityRepository(),
      inject: [PG_POOL]
    },
    {
      provide: APPLICATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null, opportunities: unknown) =>
        pool
          ? createPgApplicationRepository(pool)
          : createInMemoryApplicationRepository(
              opportunities as Parameters<typeof createInMemoryApplicationRepository>[0]
            ),
      inject: [PG_POOL, OPPORTUNITY_REPOSITORY]
    },
    {
      provide: CHAPTER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgChapterRepository(pool) : createInMemoryChapterRepository()),
      inject: [PG_POOL]
    },
    {
      provide: CHAPTER_EVENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgChapterEventRepository(pool) : createInMemoryChapterEventRepository(),
      inject: [PG_POOL]
    },
    {
      provide: EVENT_RSVP_REPOSITORY,
      useFactory: (pool: pg.Pool | null, events: unknown) =>
        pool
          ? createPgEventRsvpRepository(pool)
          : createInMemoryEventRsvpRepository(
              events as Parameters<typeof createInMemoryEventRsvpRepository>[0]
            ),
      inject: [PG_POOL, CHAPTER_EVENT_REPOSITORY]
    },
    {
      provide: ANNOUNCEMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAnnouncementRepository(pool) : createInMemoryAnnouncementRepository(),
      inject: [PG_POOL]
    },
    {
      provide: ADVISORY_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgAdvisoryRepository(pool) : createInMemoryAdvisoryRepository(),
      inject: [PG_POOL]
    },
    {
      provide: LISTING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgListingRepository(pool) : createInMemoryListingRepository()),
      inject: [PG_POOL]
    },
    {
      provide: ORDER_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgOrderRepository(pool) : createInMemoryOrderRepository()),
      inject: [PG_POOL]
    },
    {
      provide: REVIEW_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgReviewRepository(pool) : createInMemoryReviewRepository()),
      inject: [PG_POOL]
    },
    {
      provide: CREDIT_PROFILE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgCreditProfileRepository(pool) : createInMemoryCreditProfileRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DOCUMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDocumentRepository(pool) : createInMemoryDocumentRepository(),
      inject: [PG_POOL]
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      useFactory: (pool: pg.Pool | null, deliveryLog: unknown) =>
        pool
          ? createPgNotificationRepository(pool)
          : createInMemoryNotificationRepository(
              deliveryLog as Parameters<typeof createInMemoryNotificationRepository>[0]
            ),
      inject: [PG_POOL, DELIVERY_LOG_REPOSITORY]
    },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgNotificationPreferenceRepository(pool) : createInMemoryNotificationPreferenceRepository(),
      inject: [PG_POOL]
    },
    {
      provide: DELIVERY_LOG_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgDeliveryLogRepository(pool) : createInMemoryDeliveryLogRepository(),
      inject: [PG_POOL]
    },
    {
      provide: AUDIT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgAuditRepository(pool) : createInMemoryAuditRepository()),
      inject: [PG_POOL]
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (pool: pg.Pool | null) => (pool ? createPgOutboxRepository(pool) : createInMemoryOutboxRepository()),
      inject: [PG_POOL]
    }
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
