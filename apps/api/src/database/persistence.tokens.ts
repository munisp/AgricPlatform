/**
 * DI tokens for the persistence wave. Repositories are provided by the
 * global DatabaseModule; stores and the Redis client by the global
 * RedisModule. Services inject the port interfaces behind these tokens so
 * the in-memory and PostgreSQL implementations stay swappable by config.
 */
export const PG_POOL = Symbol('PG_POOL');

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');
export const CONSENT_REPOSITORY = Symbol('CONSENT_REPOSITORY');
export const DELETION_REQUEST_REPOSITORY = Symbol('DELETION_REQUEST_REPOSITORY');
export const COURSE_REPOSITORY = Symbol('COURSE_REPOSITORY');
export const ENROLMENT_REPOSITORY = Symbol('ENROLMENT_REPOSITORY');
export const CERTIFICATE_REPOSITORY = Symbol('CERTIFICATE_REPOSITORY');
export const FORUM_TOPIC_REPOSITORY = Symbol('FORUM_TOPIC_REPOSITORY');
export const MENTOR_REQUEST_REPOSITORY = Symbol('MENTOR_REQUEST_REPOSITORY');
export const TOPIC_FLAG_REPOSITORY = Symbol('TOPIC_FLAG_REPOSITORY');
export const OPPORTUNITY_REPOSITORY = Symbol('OPPORTUNITY_REPOSITORY');
export const APPLICATION_REPOSITORY = Symbol('APPLICATION_REPOSITORY');
export const CHAPTER_REPOSITORY = Symbol('CHAPTER_REPOSITORY');
export const CHAPTER_EVENT_REPOSITORY = Symbol('CHAPTER_EVENT_REPOSITORY');
export const EVENT_RSVP_REPOSITORY = Symbol('EVENT_RSVP_REPOSITORY');
export const ANNOUNCEMENT_REPOSITORY = Symbol('ANNOUNCEMENT_REPOSITORY');
export const ADVISORY_REPOSITORY = Symbol('ADVISORY_REPOSITORY');
export const LISTING_REPOSITORY = Symbol('LISTING_REPOSITORY');
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const REVIEW_REPOSITORY = Symbol('REVIEW_REPOSITORY');
export const CREDIT_PROFILE_REPOSITORY = Symbol('CREDIT_PROFILE_REPOSITORY');
export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NOTIFICATION_PREFERENCE_REPOSITORY');
export const DELIVERY_LOG_REPOSITORY = Symbol('DELIVERY_LOG_REPOSITORY');
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const KEY_VALUE_STORE = Symbol('KEY_VALUE_STORE');
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
export const OTP_STORE = Symbol('OTP_STORE');
