import type {
  AdvisoryItem,
  CampusClub,
  CampusClubMembership,
  Certificate,
  Chapter,
  ChapterEvent,
  CohortThread,
  CohortThreadPost,
  ConsentRecord,
  Course,
  CreditProfile,
  Enrolment,
  ForumTopic,
  JudgeAssignment,
  JudgeScore,
  KnowledgeResource,
  LocationRef,
  MarketplaceListing,
  MentorRequest,
  MilestoneProgress,
  NotificationMessage,
  NotificationPreference,
  Opportunity,
  OpportunityApplication,
  Order,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  PodcastEpisode,
  Profile,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeMilestone,
  RubricCriterion,
  SearchQueryEvent,
  ServiceBooking,
  ServiceOffering,
  ServiceReview,
  ServiceSupplier,
  StageProgress,
  VaultDocument,
  Webinar,
  WebinarRegistration
} from '@agric-platform/shared';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type { AuditEvent } from '@agric-platform/shared';
import type {
  ChapterAnnouncement,
  DeletionRequest,
  EventRsvp,
  OrderReview,
  TopicFlag
} from '../seed-data.js';
import type { DeliveryLogEntry } from '../repositories/delivery-log.repository.js';
import type { DeliveryResult } from '../../modules/integrations/adapters.js';
import type { RowMapper } from './pg-repository.base.js';
import { num, ts } from './pg-repository.base.js';

/**
 * Explicit snake_case ↔ camelCase row mappers (plan §3.1). No auto-casing
 * magic; jsonb columns round-trip whole. toRow only emits keys present on
 * the item so Partial<T> patches update exactly the patched columns;
 * present-but-undefined values become SQL NULL (field clearing).
 */

function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

function locationFromRow(row: Record<string, unknown>, prefix = 'location_'): LocationRef {
  return {
    state: (row[`${prefix}state`] as string) ?? '',
    lga: (row[`${prefix}lga`] as string) ?? '',
    ward: (row[`${prefix}ward`] as string) ?? undefined,
    latitude: row[`${prefix}latitude`] != null ? num(row[`${prefix}latitude`]) : undefined,
    longitude: row[`${prefix}longitude`] != null ? num(row[`${prefix}longitude`]) : undefined
  };
}

export const userMapper: RowMapper<import('@agric-platform/shared').User> = {
  columns: [
    'id',
    'phone',
    'email',
    'full_name',
    'preferred_language',
    'kyc_tier',
    'is_verified',
    'created_at',
    'last_active_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    phone: row.phone as string,
    email: (row.email as string) ?? undefined,
    fullName: row.full_name as string,
    roles: (row.roles as import('@agric-platform/shared').UserRole[]) ?? [],
    preferredLanguage: row.preferred_language as import('@agric-platform/shared').LanguageCode,
    kycTier: row.kyc_tier as import('@agric-platform/shared').KycTier,
    isVerified: row.is_verified as boolean,
    createdAt: ts(row.created_at),
    lastActiveAt: row.last_active_at ? ts(row.last_active_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      phone: 'phone',
      email: 'email',
      full_name: 'fullName',
      preferred_language: 'preferredLanguage',
      kyc_tier: 'kycTier',
      is_verified: 'isVerified',
      created_at: 'createdAt',
      last_active_at: 'lastActiveAt'
    })
};

export const profileMapper: RowMapper<Profile> = {
  columns: [
    'user_id',
    'state',
    'lga',
    'ward',
    'latitude',
    'longitude',
    'farm_size_hectares',
    'farming_interests',
    'value_chains',
    'bio',
    'years_experience',
    'completion_score',
    'badges'
  ],
  fromRow: (row) => ({
    userId: row.user_id as string,
    location: locationFromRow(row, ''),
    farmingInterests: (row.farming_interests as string[]) ?? [],
    valueChains: (row.value_chains as string[]) ?? [],
    bio: (row.bio as string) ?? undefined,
    farmSizeHectares: row.farm_size_hectares != null ? num(row.farm_size_hectares) : undefined,
    yearsExperience: row.years_experience != null ? num(row.years_experience) : undefined,
    completionScore: num(row.completion_score ?? 0),
    badges: (row.badges as string[]) ?? []
  }),
  toRow: (item) => ({
    user_id: item.userId,
    state: item.location?.state ?? null,
    lga: item.location?.lga ?? null,
    ward: item.location?.ward ?? null,
    latitude: item.location?.latitude ?? null,
    longitude: item.location?.longitude ?? null,
    farm_size_hectares: item.farmSizeHectares ?? null,
    farming_interests: item.farmingInterests ?? [],
    value_chains: item.valueChains ?? [],
    bio: item.bio ?? null,
    years_experience: item.yearsExperience ?? null,
    completion_score: item.completionScore ?? 0,
    badges: item.badges ?? []
  })
};

export const consentMapper: RowMapper<ConsentRecord> = {
  columns: ['id', 'user_id', 'purpose', 'source', 'granted', 'granted_at', 'revoked_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    purpose: row.purpose as string,
    granted: row.granted as boolean,
    source: row.source as string,
    grantedAt: ts(row.granted_at),
    revokedAt: row.revoked_at ? ts(row.revoked_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      purpose: 'purpose',
      source: 'source',
      granted: 'granted',
      granted_at: 'grantedAt',
      revoked_at: 'revokedAt'
    })
};

export const deletionRequestMapper: RowMapper<DeletionRequest> = {
  columns: ['id', 'user_id', 'status', 'requested_at', 'completed_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    status: row.status as DeletionRequest['status'],
    requestedAt: ts(row.requested_at),
    completedAt: row.completed_at ? ts(row.completed_at) : undefined
  }),
  toRow: (item) => ({
    ...present(item, {
      id: 'id',
      user_id: 'userId',
      status: 'status',
      requested_at: 'requestedAt',
      completed_at: 'completedAt'
    }),
    request_type: 'deletion'
  })
};

export const courseMapper: RowMapper<Course> = {
  columns: [
    'id',
    'title',
    'category',
    'level',
    'duration_minutes',
    'language',
    'enrolment_count',
    'offline_available'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    category: row.category as string,
    level: row.level as Course['level'],
    durationMinutes: num(row.duration_minutes),
    language: row.language as Course['language'],
    enrolmentCount: num(row.enrolment_count),
    offlineAvailable: row.offline_available as boolean
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      title: 'title',
      category: 'category',
      level: 'level',
      duration_minutes: 'durationMinutes',
      language: 'language',
      enrolment_count: 'enrolmentCount',
      offline_available: 'offlineAvailable'
    })
};

export const enrolmentMapper: RowMapper<Enrolment> = {
  columns: ['id', 'user_id', 'course_id', 'status', 'progress_percent', 'enrolled_at', 'completed_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    courseId: row.course_id as string,
    status: row.status as Enrolment['status'],
    progressPercent: num(row.progress_percent),
    enrolledAt: ts(row.enrolled_at),
    completedAt: row.completed_at ? ts(row.completed_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      course_id: 'courseId',
      status: 'status',
      progress_percent: 'progressPercent',
      enrolled_at: 'enrolledAt',
      completed_at: 'completedAt'
    })
};

export const certificateMapper: RowMapper<Certificate> = {
  columns: ['id', 'user_id', 'course_id', 'verification_code', 'verification_url', 'issued_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    courseId: row.course_id as string,
    verificationCode: row.verification_code as string,
    issuedAt: ts(row.issued_at),
    verificationUrl: (row.verification_url as string) ?? ''
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      course_id: 'courseId',
      verification_code: 'verificationCode',
      verification_url: 'verificationUrl',
      issued_at: 'issuedAt'
    })
};

export const forumTopicMapper: RowMapper<ForumTopic> = {
  columns: ['id', 'title', 'category', 'author_id', 'state', 'crop', 'reply_count', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    category: row.category as string,
    authorId: row.author_id as string,
    state: (row.state as string) ?? undefined,
    crop: (row.crop as string) ?? undefined,
    replyCount: num(row.reply_count),
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      title: 'title',
      category: 'category',
      author_id: 'authorId',
      state: 'state',
      crop: 'crop',
      reply_count: 'replyCount',
      created_at: 'createdAt'
    })
};

export const mentorRequestMapper: RowMapper<MentorRequest> = {
  columns: ['id', 'user_id', 'crop', 'state', 'challenge', 'status', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    crop: row.crop as string,
    state: row.state as string,
    challenge: row.challenge as string,
    status: row.status as MentorRequest['status'],
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      crop: 'crop',
      state: 'state',
      challenge: 'challenge',
      status: 'status',
      created_at: 'createdAt'
    })
};

export const topicFlagMapper: RowMapper<TopicFlag> = {
  columns: ['id', 'topic_id', 'reporter_id', 'reason', 'status', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    topicId: row.topic_id as string,
    reporterId: row.reporter_id as string,
    reason: row.reason as string,
    status: row.status as TopicFlag['status'],
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      topic_id: 'topicId',
      reporter_id: 'reporterId',
      reason: 'reason',
      status: 'status',
      created_at: 'createdAt'
    })
};

export const opportunityMapper: RowMapper<Opportunity> = {
  columns: [
    'id',
    'title',
    'type',
    'description',
    'states',
    'value_chains',
    'eligibility',
    'deadline',
    'partner_id',
    'is_active'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    type: row.type as Opportunity['type'],
    description: row.description as string,
    states: (row.states as string[]) ?? [],
    valueChains: (row.value_chains as string[]) ?? [],
    eligibility: (row.eligibility as string[]) ?? [],
    deadline: ts(row.deadline),
    partnerId: (row.partner_id as string) ?? undefined,
    isActive: row.is_active as boolean
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      title: 'title',
      type: 'type',
      description: 'description',
      states: 'states',
      value_chains: 'valueChains',
      eligibility: 'eligibility',
      deadline: 'deadline',
      partner_id: 'partnerId',
      is_active: 'isActive'
    })
};

export const applicationMapper: RowMapper<OpportunityApplication> = {
  columns: ['id', 'opportunity_id', 'user_id', 'status', 'submitted_at', 'notes'],
  fromRow: (row) => ({
    id: row.id as string,
    opportunityId: row.opportunity_id as string,
    userId: row.user_id as string,
    status: row.status as OpportunityApplication['status'],
    submittedAt: ts(row.submitted_at),
    notes: (row.notes as string) ?? undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      opportunity_id: 'opportunityId',
      user_id: 'userId',
      status: 'status',
      submitted_at: 'submittedAt',
      notes: 'notes'
    })
};

export const chapterMapper: RowMapper<Chapter> = {
  columns: [
    'id',
    'name',
    'level',
    'parent_id',
    'state',
    'lga',
    'lead_user_id',
    'member_count',
    'active'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    level: row.level as Chapter['level'],
    parentId: (row.parent_id as string) ?? undefined,
    state: row.state as string,
    lga: (row.lga as string) ?? undefined,
    leadUserId: (row.lead_user_id as string) ?? undefined,
    memberCount: num(row.member_count),
    active: row.active as boolean
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      level: 'level',
      parent_id: 'parentId',
      state: 'state',
      lga: 'lga',
      lead_user_id: 'leadUserId',
      member_count: 'memberCount',
      active: 'active'
    })
};

export const chapterEventMapper: RowMapper<ChapterEvent> = {
  columns: [
    'id',
    'chapter_id',
    'title',
    'type',
    'starts_at',
    'location',
    'rsvp_count',
    'attendance_count'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    chapterId: row.chapter_id as string,
    title: row.title as string,
    type: row.type as ChapterEvent['type'],
    startsAt: ts(row.starts_at),
    location: row.location as string,
    rsvpCount: num(row.rsvp_count),
    attendanceCount: num(row.attendance_count)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      chapter_id: 'chapterId',
      title: 'title',
      type: 'type',
      starts_at: 'startsAt',
      location: 'location',
      rsvp_count: 'rsvpCount',
      attendance_count: 'attendanceCount'
    })
};

export const eventRsvpMapper: RowMapper<EventRsvp> = {
  columns: ['id', 'event_id', 'user_id', 'status', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    eventId: row.event_id as string,
    userId: row.user_id as string,
    status: row.status as EventRsvp['status'],
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      event_id: 'eventId',
      user_id: 'userId',
      status: 'status',
      created_at: 'createdAt'
    })
};

export const announcementMapper: RowMapper<ChapterAnnouncement> = {
  columns: ['id', 'chapter_id', 'title', 'body', 'published_by', 'published_at'],
  fromRow: (row) => ({
    id: row.id as string,
    chapterId: row.chapter_id as string,
    title: row.title as string,
    body: row.body as string,
    authorId: (row.published_by as string) ?? '',
    publishedAt: ts(row.published_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      chapter_id: 'chapterId',
      title: 'title',
      body: 'body',
      published_by: 'authorId',
      published_at: 'publishedAt'
    })
};

export const advisoryMapper: RowMapper<AdvisoryItem> = {
  columns: ['id', 'kind', 'title', 'summary', 'state', 'crop', 'severity', 'published_at'],
  fromRow: (row) => ({
    id: row.id as string,
    kind: row.kind as AdvisoryItem['kind'],
    title: row.title as string,
    summary: row.summary as string,
    state: (row.state as string) ?? undefined,
    crop: (row.crop as string) ?? undefined,
    severity: (row.severity as AdvisoryItem['severity']) ?? undefined,
    publishedAt: ts(row.published_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      kind: 'kind',
      title: 'title',
      summary: 'summary',
      state: 'state',
      crop: 'crop',
      severity: 'severity',
      published_at: 'publishedAt'
    })
};

export const listingMapper: RowMapper<MarketplaceListing> = {
  columns: [
    'id',
    'seller_id',
    'kind',
    'title',
    'crop',
    'quantity',
    'unit',
    'price_ngn',
    'location_state',
    'location_lga',
    'location_ward',
    'location_latitude',
    'location_longitude',
    'harvest_date',
    'is_active'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    sellerId: row.seller_id as string,
    kind: row.kind as MarketplaceListing['kind'],
    title: row.title as string,
    crop: (row.crop as string) ?? undefined,
    quantity: num(row.quantity),
    unit: row.unit as string,
    priceNaira: num(row.price_ngn),
    location: locationFromRow(row),
    harvestDate: row.harvest_date ? ts(row.harvest_date).slice(0, 10) : undefined,
    isActive: row.is_active as boolean
  }),
  toRow: (item) => ({
    ...present(item, {
      id: 'id',
      seller_id: 'sellerId',
      kind: 'kind',
      title: 'title',
      crop: 'crop',
      quantity: 'quantity',
      unit: 'unit',
      price_ngn: 'priceNaira',
      harvest_date: 'harvestDate',
      is_active: 'isActive'
    }),
    ...(item.location !== undefined
      ? {
          location_state: item.location.state ?? null,
          location_lga: item.location.lga ?? null,
          location_ward: item.location.ward ?? null,
          location_latitude: item.location.latitude ?? null,
          location_longitude: item.location.longitude ?? null
        }
      : {})
  })
};

export const orderMapper: RowMapper<Order> = {
  columns: [
    'id',
    'listing_id',
    'buyer_id',
    'seller_id',
    'quantity',
    'total_naira',
    'status',
    'escrow_required',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    listingId: row.listing_id as string,
    buyerId: row.buyer_id as string,
    sellerId: row.seller_id as string,
    quantity: num(row.quantity),
    totalNaira: num(row.total_naira),
    status: row.status as Order['status'],
    escrowRequired: row.escrow_required as boolean,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      listing_id: 'listingId',
      buyer_id: 'buyerId',
      seller_id: 'sellerId',
      quantity: 'quantity',
      total_naira: 'totalNaira',
      status: 'status',
      escrow_required: 'escrowRequired',
      created_at: 'createdAt'
    })
};

export const reviewMapper: RowMapper<OrderReview> = {
  columns: ['id', 'order_id', 'author_id', 'rating', 'comment', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    orderId: row.order_id as string,
    authorId: row.author_id as string,
    rating: num(row.rating),
    comment: (row.comment as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      order_id: 'orderId',
      author_id: 'authorId',
      rating: 'rating',
      comment: 'comment',
      created_at: 'createdAt'
    })
};

export const creditProfileMapper: RowMapper<CreditProfile> = {
  columns: [
    'user_id',
    'score',
    'training_signals',
    'transaction_signals',
    'production_signals',
    'document_count',
    'improvement_actions'
  ],
  fromRow: (row) => ({
    userId: row.user_id as string,
    score: num(row.score ?? 0),
    trainingSignals: num(row.training_signals),
    transactionSignals: num(row.transaction_signals),
    productionSignals: num(row.production_signals),
    documentCount: num(row.document_count),
    improvementActions: (row.improvement_actions as string[]) ?? []
  }),
  toRow: (item) => ({
    user_id: item.userId,
    score: item.score,
    training_signals: item.trainingSignals,
    transaction_signals: item.transactionSignals,
    production_signals: item.productionSignals,
    document_count: item.documentCount,
    improvement_actions: item.improvementActions
  })
};

export const documentMapper: RowMapper<VaultDocument> = {
  columns: ['id', 'user_id', 'kind', 'file_name', 'status', 'uploaded_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    kind: row.kind as VaultDocument['kind'],
    fileName: row.file_name as string,
    status: row.status as VaultDocument['status'],
    uploadedAt: ts(row.uploaded_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      kind: 'kind',
      file_name: 'fileName',
      status: 'status',
      uploaded_at: 'uploadedAt'
    })
};

export const notificationMapper: RowMapper<NotificationMessage> = {
  columns: ['id', 'user_id', 'channel', 'title', 'body', 'status', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    channel: row.channel as NotificationMessage['channel'],
    title: row.title as string,
    body: row.body as string,
    status: row.status as NotificationMessage['status'],
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      channel: 'channel',
      title: 'title',
      body: 'body',
      status: 'status',
      created_at: 'createdAt'
    })
};

export const notificationPreferenceMapper: RowMapper<NotificationPreference> = {
  columns: ['user_id', 'channel', 'enabled'],
  fromRow: (row) => ({
    userId: row.user_id as string,
    channel: row.channel as NotificationPreference['channel'],
    enabled: row.enabled as boolean
  }),
  toRow: (item) => ({
    user_id: item.userId,
    channel: item.channel,
    enabled: item.enabled
  })
};

export const deliveryLogMapper: RowMapper<DeliveryLogEntry & { id: string }> = {
  columns: ['id', 'notification_id', 'provider', 'provider_ref', 'status', 'detail', 'attempted_at'],
  fromRow: (row) => ({
    id: row.id as string,
    notificationId: row.notification_id as string,
    result: row.detail as DeliveryResult,
    at: ts(row.attempted_at)
  }),
  toRow: (item) => ({
    id: item.id,
    notification_id: item.notificationId,
    provider: item.result.provider,
    provider_ref: item.result.providerRef,
    status: item.result.delivered ? 'delivered' : 'failed',
    detail: item.result,
    attempted_at: item.at
  })
};

export const auditMapper: RowMapper<AuditEvent> = {
  columns: [
    'id',
    'actor_id',
    'action',
    'entity_type',
    'entity_id',
    'metadata',
    'created_at',
    'prev_hash',
    'hash',
    'request_id'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    actorId: row.actor_id as string,
    action: row.action as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: ts(row.created_at),
    prevHash: (row.prev_hash as string) ?? undefined,
    hash: (row.hash as string) ?? undefined,
    requestId: (row.request_id as string) ?? undefined
  }),
  toRow: (item) => ({
    id: item.id,
    actor_id: item.actorId,
    action: item.action,
    entity_type: item.entityType,
    entity_id: item.entityId,
    metadata: item.metadata,
    created_at: item.createdAt,
    prev_hash: item.prevHash ?? null,
    hash: item.hash ?? null,
    request_id: item.requestId ?? null
  })
};

export const outboxMapper: RowMapper<DomainEvent> = {
  columns: ['id', 'name', 'payload', 'actor_id', 'occurred_at'],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    payload: row.payload,
    actorId: (row.actor_id as string) ?? undefined,
    occurredAt: ts(row.occurred_at)
  }),
  toRow: (item) => ({
    id: item.id,
    name: item.name,
    payload: item.payload ?? {},
    actor_id: item.actorId ?? null,
    occurred_at: item.occurredAt
  })
};

// ---------------------------------------------------------------------------
// Engagement wave (P2b) mappers: services marketplace, programmes, pathways,
// knowledge base, search depth. Same snake_case ↔ camelCase conventions.
// ---------------------------------------------------------------------------

export const serviceSupplierMapper: RowMapper<ServiceSupplier> = {
  columns: [
    'id',
    'owner_user_id',
    'business_name',
    'categories',
    'states_covered',
    'lgas_covered',
    'verification_status',
    'average_rating',
    'rating_count',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    businessName: row.business_name as string,
    categories: (row.categories as ServiceSupplier['categories']) ?? [],
    statesCovered: (row.states_covered as string[]) ?? [],
    lgasCovered: (row.lgas_covered as string[]) ?? [],
    verificationStatus: row.verification_status as ServiceSupplier['verificationStatus'],
    averageRating: num(row.average_rating),
    ratingCount: num(row.rating_count),
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      owner_user_id: 'ownerUserId',
      business_name: 'businessName',
      categories: 'categories',
      states_covered: 'statesCovered',
      lgas_covered: 'lgasCovered',
      verification_status: 'verificationStatus',
      average_rating: 'averageRating',
      rating_count: 'ratingCount',
      created_at: 'createdAt'
    })
};

export const serviceOfferingMapper: RowMapper<ServiceOffering> = {
  columns: [
    'id',
    'supplier_id',
    'category',
    'title',
    'description',
    'price_naira',
    'pricing_unit',
    'is_active',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    supplierId: row.supplier_id as string,
    category: row.category as ServiceOffering['category'],
    title: row.title as string,
    description: row.description as string,
    priceNaira: num(row.price_naira),
    pricingUnit: row.pricing_unit as ServiceOffering['pricingUnit'],
    isActive: row.is_active as boolean,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      supplier_id: 'supplierId',
      category: 'category',
      title: 'title',
      description: 'description',
      price_naira: 'priceNaira',
      pricing_unit: 'pricingUnit',
      is_active: 'isActive',
      created_at: 'createdAt'
    })
};

export const serviceBookingMapper: RowMapper<ServiceBooking> = {
  columns: [
    'id',
    'offering_id',
    'supplier_id',
    'customer_id',
    'quantity',
    'total_naira',
    'scheduled_start',
    'scheduled_end',
    'status',
    'notes',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    offeringId: row.offering_id as string,
    supplierId: row.supplier_id as string,
    customerId: row.customer_id as string,
    quantity: num(row.quantity),
    totalNaira: row.total_naira != null ? num(row.total_naira) : undefined,
    scheduledStart: ts(row.scheduled_start),
    scheduledEnd: ts(row.scheduled_end),
    status: row.status as ServiceBooking['status'],
    notes: (row.notes as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      offering_id: 'offeringId',
      supplier_id: 'supplierId',
      customer_id: 'customerId',
      quantity: 'quantity',
      total_naira: 'totalNaira',
      scheduled_start: 'scheduledStart',
      scheduled_end: 'scheduledEnd',
      status: 'status',
      notes: 'notes',
      created_at: 'createdAt'
    })
};

export const serviceReviewMapper: RowMapper<ServiceReview> = {
  columns: ['id', 'booking_id', 'supplier_id', 'author_id', 'rating', 'comment', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    bookingId: row.booking_id as string,
    supplierId: row.supplier_id as string,
    authorId: row.author_id as string,
    rating: num(row.rating),
    comment: (row.comment as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      booking_id: 'bookingId',
      supplier_id: 'supplierId',
      author_id: 'authorId',
      rating: 'rating',
      comment: 'comment',
      created_at: 'createdAt'
    })
};

export const programmeCohortMapper: RowMapper<ProgrammeCohort> = {
  columns: [
    'id',
    'name',
    'programme_type',
    'capacity',
    'enrolment_opens_at',
    'enrolment_closes_at',
    'status',
    'moderator_ids',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    programmeType: row.programme_type as ProgrammeCohort['programmeType'],
    capacity: num(row.capacity),
    enrolmentOpensAt: ts(row.enrolment_opens_at),
    enrolmentClosesAt: ts(row.enrolment_closes_at),
    status: row.status as ProgrammeCohort['status'],
    moderatorIds: (row.moderator_ids as string[]) ?? [],
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      programme_type: 'programmeType',
      capacity: 'capacity',
      enrolment_opens_at: 'enrolmentOpensAt',
      enrolment_closes_at: 'enrolmentClosesAt',
      status: 'status',
      moderator_ids: 'moderatorIds',
      created_at: 'createdAt'
    })
};

export const programmeEnrolmentMapper: RowMapper<ProgrammeEnrolment> = {
  columns: ['id', 'cohort_id', 'user_id', 'declared_age', 'declared_gender', 'status', 'enrolled_at'],
  fromRow: (row) => ({
    id: row.id as string,
    cohortId: row.cohort_id as string,
    userId: row.user_id as string,
    declaredAge: row.declared_age != null ? num(row.declared_age) : undefined,
    declaredGender: (row.declared_gender as ProgrammeEnrolment['declaredGender']) ?? undefined,
    status: row.status as ProgrammeEnrolment['status'],
    enrolledAt: ts(row.enrolled_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cohort_id: 'cohortId',
      user_id: 'userId',
      declared_age: 'declaredAge',
      declared_gender: 'declaredGender',
      status: 'status',
      enrolled_at: 'enrolledAt'
    })
};

export const programmeMilestoneMapper: RowMapper<ProgrammeMilestone> = {
  columns: ['id', 'cohort_id', 'title', 'sequence', 'due_at'],
  fromRow: (row) => ({
    id: row.id as string,
    cohortId: row.cohort_id as string,
    title: row.title as string,
    sequence: num(row.sequence),
    dueAt: row.due_at ? ts(row.due_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cohort_id: 'cohortId',
      title: 'title',
      sequence: 'sequence',
      due_at: 'dueAt'
    })
};

export const milestoneProgressMapper: RowMapper<MilestoneProgress> = {
  columns: ['id', 'milestone_id', 'user_id', 'status', 'completed_at'],
  fromRow: (row) => ({
    id: row.id as string,
    milestoneId: row.milestone_id as string,
    userId: row.user_id as string,
    status: row.status as MilestoneProgress['status'],
    completedAt: row.completed_at ? ts(row.completed_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      milestone_id: 'milestoneId',
      user_id: 'userId',
      status: 'status',
      completed_at: 'completedAt'
    })
};

export const rubricCriterionMapper: RowMapper<RubricCriterion> = {
  columns: ['id', 'cohort_id', 'name', 'max_score'],
  fromRow: (row) => ({
    id: row.id as string,
    cohortId: row.cohort_id as string,
    name: row.name as string,
    maxScore: num(row.max_score)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cohort_id: 'cohortId',
      name: 'name',
      max_score: 'maxScore'
    })
};

export const judgeAssignmentMapper: RowMapper<JudgeAssignment> = {
  columns: ['id', 'cohort_id', 'judge_user_id', 'assigned_at'],
  fromRow: (row) => ({
    id: row.id as string,
    cohortId: row.cohort_id as string,
    judgeUserId: row.judge_user_id as string,
    assignedAt: ts(row.assigned_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cohort_id: 'cohortId',
      judge_user_id: 'judgeUserId',
      assigned_at: 'assignedAt'
    })
};

export const judgeScoreMapper: RowMapper<JudgeScore> = {
  columns: ['id', 'cohort_id', 'judge_user_id', 'entry_user_id', 'criterion_id', 'score', 'submitted_at'],
  fromRow: (row) => ({
    id: row.id as string,
    cohortId: row.cohort_id as string,
    judgeUserId: row.judge_user_id as string,
    entryUserId: row.entry_user_id as string,
    criterionId: row.criterion_id as string,
    score: num(row.score),
    submittedAt: ts(row.submitted_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cohort_id: 'cohortId',
      judge_user_id: 'judgeUserId',
      entry_user_id: 'entryUserId',
      criterion_id: 'criterionId',
      score: 'score',
      submitted_at: 'submittedAt'
    })
};

export const cohortThreadMapper: RowMapper<CohortThread> = {
  columns: ['id', 'cohort_id', 'title', 'author_id', 'reply_count', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    cohortId: row.cohort_id as string,
    title: row.title as string,
    authorId: row.author_id as string,
    replyCount: num(row.reply_count),
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cohort_id: 'cohortId',
      title: 'title',
      author_id: 'authorId',
      reply_count: 'replyCount',
      created_at: 'createdAt'
    })
};

export const cohortThreadPostMapper: RowMapper<CohortThreadPost> = {
  columns: ['id', 'thread_id', 'author_id', 'body', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    threadId: row.thread_id as string,
    authorId: row.author_id as string,
    body: row.body as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      thread_id: 'threadId',
      author_id: 'authorId',
      body: 'body',
      created_at: 'createdAt'
    })
};

export const pathwayTemplateMapper: RowMapper<PathwayTemplate> = {
  columns: ['id', 'track', 'name', 'description', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    track: row.track as PathwayTemplate['track'],
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      track: 'track',
      name: 'name',
      description: 'description',
      created_at: 'createdAt'
    })
};

export const pathwayStageMapper: RowMapper<PathwayStage> = {
  columns: ['id', 'template_id', 'title', 'sequence', 'required_actions'],
  fromRow: (row) => ({
    id: row.id as string,
    templateId: row.template_id as string,
    title: row.title as string,
    sequence: num(row.sequence),
    requiredActions: (row.required_actions as string[]) ?? []
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      template_id: 'templateId',
      title: 'title',
      sequence: 'sequence',
      required_actions: 'requiredActions'
    })
};

export const pathwayEnrolmentMapper: RowMapper<PathwayEnrolment> = {
  columns: ['id', 'template_id', 'user_id', 'status', 'current_stage_id', 'enrolled_at', 'completed_at'],
  fromRow: (row) => ({
    id: row.id as string,
    templateId: row.template_id as string,
    userId: row.user_id as string,
    status: row.status as PathwayEnrolment['status'],
    currentStageId: (row.current_stage_id as string) ?? undefined,
    enrolledAt: ts(row.enrolled_at),
    completedAt: row.completed_at ? ts(row.completed_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      template_id: 'templateId',
      user_id: 'userId',
      status: 'status',
      current_stage_id: 'currentStageId',
      enrolled_at: 'enrolledAt',
      completed_at: 'completedAt'
    })
};

export const stageProgressMapper: RowMapper<StageProgress> = {
  columns: ['id', 'enrolment_id', 'stage_id', 'status', 'evidence', 'completed_at'],
  fromRow: (row) => ({
    id: row.id as string,
    enrolmentId: row.enrolment_id as string,
    stageId: row.stage_id as string,
    status: row.status as StageProgress['status'],
    evidence: (row.evidence as string) ?? undefined,
    completedAt: row.completed_at ? ts(row.completed_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      enrolment_id: 'enrolmentId',
      stage_id: 'stageId',
      status: 'status',
      evidence: 'evidence',
      completed_at: 'completedAt'
    })
};

export const campusClubMapper: RowMapper<CampusClub> = {
  columns: [
    'id',
    'name',
    'institution',
    'state',
    'coordinator_user_id',
    'is_nysc_cds_group',
    'member_count',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    institution: row.institution as string,
    state: row.state as string,
    coordinatorUserId: row.coordinator_user_id as string,
    isNyscCdsGroup: row.is_nysc_cds_group as boolean,
    memberCount: num(row.member_count),
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      institution: 'institution',
      state: 'state',
      coordinator_user_id: 'coordinatorUserId',
      is_nysc_cds_group: 'isNyscCdsGroup',
      member_count: 'memberCount',
      created_at: 'createdAt'
    })
};

export const campusClubMembershipMapper: RowMapper<CampusClubMembership> = {
  columns: ['id', 'club_id', 'user_id', 'role', 'joined_at'],
  fromRow: (row) => ({
    id: row.id as string,
    clubId: row.club_id as string,
    userId: row.user_id as string,
    role: row.role as CampusClubMembership['role'],
    joinedAt: ts(row.joined_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      club_id: 'clubId',
      user_id: 'userId',
      role: 'role',
      joined_at: 'joinedAt'
    })
};

export const knowledgeResourceMapper: RowMapper<KnowledgeResource> = {
  columns: ['id', 'title', 'body', 'tags', 'language', 'format', 'offline_available', 'view_count', 'published_at'],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    tags: (row.tags as string[]) ?? [],
    language: row.language as KnowledgeResource['language'],
    format: row.format as KnowledgeResource['format'],
    offlineAvailable: row.offline_available as boolean,
    viewCount: num(row.view_count),
    publishedAt: ts(row.published_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      title: 'title',
      body: 'body',
      tags: 'tags',
      language: 'language',
      format: 'format',
      offline_available: 'offlineAvailable',
      view_count: 'viewCount',
      published_at: 'publishedAt'
    })
};

export const podcastEpisodeMapper: RowMapper<PodcastEpisode> = {
  columns: ['id', 'title', 'show_notes', 'audio_url', 'duration_seconds', 'transcript', 'published_at'],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    showNotes: row.show_notes as string,
    audioUrl: row.audio_url as string,
    durationSeconds: num(row.duration_seconds),
    transcript: (row.transcript as string) ?? undefined,
    publishedAt: ts(row.published_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      title: 'title',
      show_notes: 'showNotes',
      audio_url: 'audioUrl',
      duration_seconds: 'durationSeconds',
      transcript: 'transcript',
      published_at: 'publishedAt'
    })
};

export const webinarMapper: RowMapper<Webinar> = {
  columns: ['id', 'title', 'host_user_id', 'starts_at', 'timezone', 'recording_url', 'status', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    title: row.title as string,
    hostUserId: row.host_user_id as string,
    startsAt: ts(row.starts_at),
    timezone: row.timezone as string,
    recordingUrl: (row.recording_url as string) ?? undefined,
    status: row.status as Webinar['status'],
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      title: 'title',
      host_user_id: 'hostUserId',
      starts_at: 'startsAt',
      timezone: 'timezone',
      recording_url: 'recordingUrl',
      status: 'status',
      created_at: 'createdAt'
    })
};

export const webinarRegistrationMapper: RowMapper<WebinarRegistration> = {
  columns: ['id', 'webinar_id', 'user_id', 'registered_at'],
  fromRow: (row) => ({
    id: row.id as string,
    webinarId: row.webinar_id as string,
    userId: row.user_id as string,
    registeredAt: ts(row.registered_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      webinar_id: 'webinarId',
      user_id: 'userId',
      registered_at: 'registeredAt'
    })
};

export const searchQueryMapper: RowMapper<SearchQueryEvent> = {
  columns: ['id', 'query', 'occurred_at'],
  fromRow: (row) => ({
    id: row.id as string,
    query: row.query as string,
    occurredAt: ts(row.occurred_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      query: 'query',
      occurred_at: 'occurredAt'
    })
};
