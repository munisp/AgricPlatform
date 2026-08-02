import type {
  AdvisoryItem,
  Certificate,
  Chapter,
  ChapterEvent,
  ConsentRecord,
  Course,
  CreditProfile,
  CreditScoreResult,
  Enrolment,
  EscrowRecord,
  ForumTopic,
  Invoice,
  Lender,
  LoanApplication,
  LocationRef,
  MarketplaceListing,
  MentorRequest,
  NotificationMessage,
  NotificationPreference,
  Opportunity,
  OpportunityApplication,
  Order,
  Profile,
  RepaymentInstallment,
  Shipment,
  VaultDocument
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

/* ---------------------------------------------------------------------------
 * Wave P2a mappers: escrow, invoices, shipments, credit scores, lenders,
 * loan applications, repayment installments. Money columns are bigint kobo.
 * ------------------------------------------------------------------------- */

export const escrowMapper: RowMapper<EscrowRecord> = {
  columns: [
    'id',
    'order_id',
    'amount_kobo',
    'status',
    'provider_reference',
    'held_at',
    'resolved_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    orderId: row.order_id as string,
    amountKobo: num(row.amount_kobo),
    status: row.status as EscrowRecord['status'],
    providerReference: (row.provider_reference as string) ?? undefined,
    heldAt: ts(row.held_at),
    resolvedAt: row.resolved_at ? ts(row.resolved_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      order_id: 'orderId',
      amount_kobo: 'amountKobo',
      status: 'status',
      provider_reference: 'providerReference',
      held_at: 'heldAt',
      resolved_at: 'resolvedAt'
    })
};

export const invoiceMapper: RowMapper<Invoice> = {
  columns: [
    'id',
    'invoice_number',
    'order_id',
    'seller_id',
    'buyer_id',
    'status',
    'currency',
    'subtotal_kobo',
    'vat_kobo',
    'total_kobo',
    'line_items',
    'issued_at',
    'paid_at',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    invoiceNumber: row.invoice_number as string,
    orderId: row.order_id as string,
    sellerId: row.seller_id as string,
    buyerId: row.buyer_id as string,
    status: row.status as Invoice['status'],
    currency: row.currency as Invoice['currency'],
    subtotalKobo: num(row.subtotal_kobo),
    vatKobo: num(row.vat_kobo),
    totalKobo: num(row.total_kobo),
    lineItems: (row.line_items as Invoice['lineItems']) ?? [],
    issuedAt: row.issued_at ? ts(row.issued_at) : undefined,
    paidAt: row.paid_at ? ts(row.paid_at) : undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) => {
    const row = present(item, {
      id: 'id',
      invoice_number: 'invoiceNumber',
      order_id: 'orderId',
      seller_id: 'sellerId',
      buyer_id: 'buyerId',
      status: 'status',
      currency: 'currency',
      subtotal_kobo: 'subtotalKobo',
      vat_kobo: 'vatKobo',
      total_kobo: 'totalKobo',
      line_items: 'lineItems',
      issued_at: 'issuedAt',
      paid_at: 'paidAt',
      created_at: 'createdAt'
    });
    // jsonb array-of-objects: node-pg would emit a Postgres array literal for
    // JS arrays, so serialise explicitly.
    if ('line_items' in row) {
      row.line_items = row.line_items === null ? null : JSON.stringify(row.line_items);
    }
    return row;
  }
};

export const shipmentMapper: RowMapper<Shipment> = {
  columns: [
    'id',
    'order_id',
    'status',
    'carrier',
    'tracking_reference',
    'scheduled_pickup_at',
    'picked_up_at',
    'delivered_at',
    'confirmed_at',
    'failure_reason',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    orderId: row.order_id as string,
    status: row.status as Shipment['status'],
    carrier: (row.carrier as string) ?? undefined,
    trackingReference: (row.tracking_reference as string) ?? undefined,
    scheduledPickupAt: row.scheduled_pickup_at ? ts(row.scheduled_pickup_at) : undefined,
    pickedUpAt: row.picked_up_at ? ts(row.picked_up_at) : undefined,
    deliveredAt: row.delivered_at ? ts(row.delivered_at) : undefined,
    confirmedAt: row.confirmed_at ? ts(row.confirmed_at) : undefined,
    failureReason: (row.failure_reason as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      order_id: 'orderId',
      status: 'status',
      carrier: 'carrier',
      tracking_reference: 'trackingReference',
      scheduled_pickup_at: 'scheduledPickupAt',
      picked_up_at: 'pickedUpAt',
      delivered_at: 'deliveredAt',
      confirmed_at: 'confirmedAt',
      failure_reason: 'failureReason',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const creditScoreMapper: RowMapper<CreditScoreResult> = {
  columns: ['user_id', 'version', 'score', 'components', 'computed_at'],
  fromRow: (row) => ({
    userId: row.user_id as string,
    version: row.version as string,
    score: num(row.score),
    components: (row.components as Record<string, number>) ?? {},
    computedAt: ts(row.computed_at)
  }),
  toRow: (item) =>
    present(item, {
      user_id: 'userId',
      version: 'version',
      score: 'score',
      components: 'components',
      computed_at: 'computedAt'
    })
};

export const lenderMapper: RowMapper<Lender> = {
  columns: [
    'id',
    'name',
    'product',
    'min_ticket_kobo',
    'max_ticket_kobo',
    'min_score',
    'criteria',
    'is_active'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    product: row.product as string,
    minTicketKobo: num(row.min_ticket_kobo),
    maxTicketKobo: num(row.max_ticket_kobo),
    minScore: num(row.min_score),
    criteria: (row.criteria as string[]) ?? [],
    isActive: row.is_active as boolean
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      product: 'product',
      min_ticket_kobo: 'minTicketKobo',
      max_ticket_kobo: 'maxTicketKobo',
      min_score: 'minScore',
      criteria: 'criteria',
      is_active: 'isActive'
    })
};

export const loanApplicationMapper: RowMapper<LoanApplication> = {
  columns: [
    'id',
    'applicant_id',
    'lender_id',
    'product_name',
    'amount_kobo',
    'term_months',
    'annual_rate_bps',
    'purpose',
    'status',
    'submitted_at',
    'decided_at',
    'disbursed_at',
    'closed_at',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    applicantId: row.applicant_id as string,
    lenderId: row.lender_id as string,
    productName: (row.product_name as string) ?? undefined,
    amountKobo: num(row.amount_kobo),
    termMonths: num(row.term_months),
    annualRateBps: num(row.annual_rate_bps),
    purpose: (row.purpose as string) ?? undefined,
    status: row.status as LoanApplication['status'],
    submittedAt: row.submitted_at ? ts(row.submitted_at) : undefined,
    decidedAt: row.decided_at ? ts(row.decided_at) : undefined,
    disbursedAt: row.disbursed_at ? ts(row.disbursed_at) : undefined,
    closedAt: row.closed_at ? ts(row.closed_at) : undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      applicant_id: 'applicantId',
      lender_id: 'lenderId',
      product_name: 'productName',
      amount_kobo: 'amountKobo',
      term_months: 'termMonths',
      annual_rate_bps: 'annualRateBps',
      purpose: 'purpose',
      status: 'status',
      submitted_at: 'submittedAt',
      decided_at: 'decidedAt',
      disbursed_at: 'disbursedAt',
      closed_at: 'closedAt',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const installmentMapper: RowMapper<RepaymentInstallment> = {
  columns: [
    'id',
    'loan_id',
    'sequence',
    'due_date',
    'principal_kobo',
    'interest_kobo',
    'total_kobo',
    'status',
    'paid_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    loanId: row.loan_id as string,
    sequence: num(row.sequence),
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : (row.due_date as string),
    principalKobo: num(row.principal_kobo),
    interestKobo: num(row.interest_kobo),
    totalKobo: num(row.total_kobo),
    status: row.status as RepaymentInstallment['status'],
    paidAt: row.paid_at ? ts(row.paid_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      loan_id: 'loanId',
      sequence: 'sequence',
      due_date: 'dueDate',
      principal_kobo: 'principalKobo',
      interest_kobo: 'interestKobo',
      total_kobo: 'totalKobo',
      status: 'status',
      paid_at: 'paidAt'
    })
};
