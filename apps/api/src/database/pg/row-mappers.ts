import type {
  AdvisoryItem,
  Animal,
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
  CreditScoreResult,
  Enrolment,
  EquipmentBooking,
  EquipmentListing,
  EscrowRecord,
  ForumTopic,
  Invoice,
  JudgeAssignment,
  JudgeScore,
  KnowledgeResource,
  Lender,
  LivestockLot,
  LoanApplication,
  LocationRef,
  MarketplaceListing,
  MentorRequest,
  MilestoneProgress,
  NotificationMessage,
  NotificationPreference,
  Opportunity,
  OpportunityApplication,
  Order,
  OwnershipTransfer,
  PastoralistProfile,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  PodcastEpisode,
  Profile,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeMilestone,
  RepaymentInstallment,
  RubricCriterion,
  SearchQueryEvent,
  ServiceBooking,
  ServiceOffering,
  ServiceReview,
  ServiceSupplier,
  Shipment,
  StageProgress,
  VaultDocument,
  Webinar,
  WebinarRegistration
} from '@agric-platform/shared';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type { AuditEvent } from '@agric-platform/shared';
import type {
  AnimalHealthRecord,
  AnimalMovement,
  DiseaseFlag,
  LivestockRecall,
  MovementPermit
} from '@agric-platform/shared';
import type {
  ChapterAnnouncement,
  DeletionRequest,
  EventRsvp,
  OrderReview,
  TopicFlag
} from '../seed-data.js';
import type { DeliveryLogEntry } from '../repositories/delivery-log.repository.js';
import type { RecommendationFeedbackEvent } from '../repositories/recommendation-feedback.repository.js';
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
  columns: ['id', 'event_id', 'user_id', 'status', 'created_at', 'scanned_at', 'scanner_id'],
  fromRow: (row) => ({
    id: row.id as string,
    eventId: row.event_id as string,
    userId: row.user_id as string,
    status: row.status as EventRsvp['status'],
    createdAt: ts(row.created_at),
    ...(row.scanned_at ? { scannedAt: ts(row.scanned_at) } : {}),
    ...(row.scanner_id ? { scannerId: row.scanner_id as string } : {})
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      event_id: 'eventId',
      user_id: 'userId',
      status: 'status',
      created_at: 'createdAt',
      scanned_at: 'scannedAt',
      scanner_id: 'scannerId'
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
    'certified_listing_id',
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
    certifiedListingId: (row.certified_listing_id as string) ?? undefined,
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
      certified_listing_id: 'certifiedListingId',
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

export const escrowMapper: RowMapper<EscrowRecord> = {
  columns: [
    'id',
    'order_id',
    'amount_kobo',
    'status',
    'provider_reference',
    'held_at',
    'held_until',
    'resolved_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    orderId: row.order_id as string,
    amountKobo: num(row.amount_kobo),
    status: row.status as EscrowRecord['status'],
    providerReference: (row.provider_reference as string) ?? undefined,
    heldAt: ts(row.held_at),
    heldUntil: row.held_until ? ts(row.held_until) : undefined,
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
      held_until: 'heldUntil',
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
    'paid_at',
    'payment_reference',
    'declared_by',
    'declared_at'
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
    paidAt: row.paid_at ? ts(row.paid_at) : undefined,
    paymentReference: (row.payment_reference as string) ?? undefined,
    declaredBy: (row.declared_by as string) ?? undefined,
    declaredAt: row.declared_at ? ts(row.declared_at) : undefined
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
      paid_at: 'paidAt',
      payment_reference: 'paymentReference',
      declared_by: 'declaredBy',
      declared_at: 'declaredAt'
    })
};

// Wave P5c: recommendation feedback events (search.recommendation_feedback).
export const recommendationFeedbackMapper: RowMapper<RecommendationFeedbackEvent> = {
  columns: ['id', 'user_id', 'item_type', 'item_id', 'action', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    itemType: row.item_type as 'course' | 'opportunity' | 'listing' | 'knowledge',
    itemId: row.item_id as string,
    action: row.action as 'clicked' | 'dismissed',
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      item_type: 'itemType',
      item_id: 'itemId',
      action: 'action',
      created_at: 'createdAt'
    })
};

// ---------------------------------------------------------------------------
// Wave L1a: ALTP livestock core (livestock schema, infra/postgres/012).
// PK columns are domain-named (animal_id/lot_id), so the pg repositories
// override the id-keyed base methods.

export const animalMapper: RowMapper<Animal> = {
  columns: [
    'animal_id',
    'species',
    'breed',
    'sex',
    'birth_date',
    'tag_id',
    'eid',
    'owner_user_id',
    'state',
    'lga',
    'status',
    'sire_id',
    'dam_id',
    'notes',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.animal_id as string,
    species: row.species as Animal['species'],
    breed: row.breed as string,
    sex: row.sex as Animal['sex'],
    birthDate: row.birth_date ? ts(row.birth_date) : undefined,
    tagId: (row.tag_id as string) ?? undefined,
    eid: (row.eid as string) ?? undefined,
    ownerUserId: row.owner_user_id as string,
    state: row.state as string,
    lga: (row.lga as string) ?? undefined,
    status: row.status as Animal['status'],
    sireId: (row.sire_id as string) ?? undefined,
    damId: (row.dam_id as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      animal_id: 'id',
      species: 'species',
      breed: 'breed',
      sex: 'sex',
      birth_date: 'birthDate',
      tag_id: 'tagId',
      eid: 'eid',
      owner_user_id: 'ownerUserId',
      state: 'state',
      lga: 'lga',
      status: 'status',
      sire_id: 'sireId',
      dam_id: 'damId',
      notes: 'notes',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const lotMapper: RowMapper<LivestockLot> = {
  columns: [
    'lot_id',
    'species',
    'quantity',
    'owner_user_id',
    'state',
    'lga',
    'formation_rule',
    'status',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.lot_id as string,
    species: row.species as LivestockLot['species'],
    quantity: num(row.quantity),
    ownerUserId: row.owner_user_id as string,
    state: row.state as string,
    lga: (row.lga as string) ?? undefined,
    formationRule: (row.formation_rule as string) ?? undefined,
    status: row.status as LivestockLot['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      lot_id: 'id',
      species: 'species',
      quantity: 'quantity',
      owner_user_id: 'ownerUserId',
      state: 'state',
      lga: 'lga',
      formation_rule: 'formationRule',
      status: 'status',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const ownershipTransferMapper: RowMapper<OwnershipTransfer> = {
  columns: [
    'id',
    'animal_id',
    'from_user_id',
    'to_user_id',
    'transfer_type',
    'effective_at',
    'recorded_by',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    animalId: row.animal_id as string,
    fromUserId: row.from_user_id as string,
    toUserId: row.to_user_id as string,
    transferType: row.transfer_type as OwnershipTransfer['transferType'],
    effectiveAt: ts(row.effective_at),
    recordedBy: row.recorded_by as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      animal_id: 'animalId',
      from_user_id: 'fromUserId',
      to_user_id: 'toUserId',
      transfer_type: 'transferType',
      effective_at: 'effectiveAt',
      recorded_by: 'recordedBy',
      created_at: 'createdAt'
    })
};

export const pastoralistProfileMapper: RowMapper<PastoralistProfile> = {
  columns: ['user_id', 'grazing_zone_id', 'migration_pattern', 'primary_species', 'updated_at'],
  fromRow: (row) => ({
    userId: row.user_id as string,
    grazingZoneId: (row.grazing_zone_id as string) ?? undefined,
    migrationPattern: (row.migration_pattern as string) ?? undefined,
    primarySpecies: (row.primary_species as PastoralistProfile['primarySpecies']) ?? [],
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      user_id: 'userId',
      grazing_zone_id: 'grazingZoneId',
      migration_pattern: 'migrationPattern',
      primary_species: 'primarySpecies',
      updated_at: 'updatedAt'
    })
};

// ---------------------------------------------------------------------------
// Wave L1b: ALTP animal-health ledger, movement traceability, recall and
// disease surveillance (appended — infra/postgres/013).

export const healthRecordMapper: RowMapper<AnimalHealthRecord> = {
  columns: [
    'id',
    'animal_id',
    'record_type',
    'product',
    'batch_number',
    'dose',
    'administered_at',
    'withdrawal_until',
    'vet_user_id',
    'notes',
    'signature',
    'signed_at',
    'reversal_of_id',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    animalId: row.animal_id as string,
    recordType: row.record_type as AnimalHealthRecord['recordType'],
    product: row.product as string,
    batchNumber: row.batch_number as string,
    dose: row.dose as string,
    administeredAt: ts(row.administered_at),
    withdrawalUntil: row.withdrawal_until ? ts(row.withdrawal_until) : undefined,
    vetUserId: row.vet_user_id as string,
    notes: (row.notes as string) ?? undefined,
    signature: row.signature as string,
    signedAt: ts(row.signed_at),
    reversalOfId: (row.reversal_of_id as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      animal_id: 'animalId',
      record_type: 'recordType',
      product: 'product',
      batch_number: 'batchNumber',
      dose: 'dose',
      administered_at: 'administeredAt',
      withdrawal_until: 'withdrawalUntil',
      vet_user_id: 'vetUserId',
      notes: 'notes',
      signature: 'signature',
      signed_at: 'signedAt',
      reversal_of_id: 'reversalOfId',
      created_at: 'createdAt'
    })
};

export const movementMapper: RowMapper<AnimalMovement> = {
  columns: [
    'id',
    'animal_id',
    'lot_id',
    'from_state',
    'from_lga',
    'to_state',
    'to_lga',
    'departed_at',
    'arrived_at',
    'transport_mode',
    'purpose',
    'permit_id',
    'recorded_by',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    animalId: (row.animal_id as string) ?? undefined,
    lotId: (row.lot_id as string) ?? undefined,
    fromState: row.from_state as string,
    fromLga: (row.from_lga as string) ?? undefined,
    toState: row.to_state as string,
    toLga: (row.to_lga as string) ?? undefined,
    departedAt: ts(row.departed_at),
    arrivedAt: row.arrived_at ? ts(row.arrived_at) : undefined,
    transportMode: row.transport_mode as AnimalMovement['transportMode'],
    purpose: row.purpose as AnimalMovement['purpose'],
    permitId: (row.permit_id as string) ?? undefined,
    recordedBy: row.recorded_by as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      animal_id: 'animalId',
      lot_id: 'lotId',
      from_state: 'fromState',
      from_lga: 'fromLga',
      to_state: 'toState',
      to_lga: 'toLga',
      departed_at: 'departedAt',
      arrived_at: 'arrivedAt',
      transport_mode: 'transportMode',
      purpose: 'purpose',
      permit_id: 'permitId',
      recorded_by: 'recordedBy',
      created_at: 'createdAt'
    })
};

export const movementPermitMapper: RowMapper<MovementPermit> = {
  columns: [
    'id',
    'permit_number',
    'from_state',
    'to_state',
    'valid_from',
    'valid_until',
    'status',
    'issued_by',
    'revoked_reason',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    permitNumber: row.permit_number as string,
    fromState: row.from_state as string,
    toState: row.to_state as string,
    validFrom: ts(row.valid_from),
    validUntil: ts(row.valid_until),
    status: row.status as MovementPermit['status'],
    issuedBy: row.issued_by as string,
    revokedReason: (row.revoked_reason as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      permit_number: 'permitNumber',
      from_state: 'fromState',
      to_state: 'toState',
      valid_from: 'validFrom',
      valid_until: 'validUntil',
      status: 'status',
      issued_by: 'issuedBy',
      revoked_reason: 'revokedReason',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const recallMapper: RowMapper<LivestockRecall> = {
  columns: [
    'id',
    'scope',
    'animal_id',
    'lot_id',
    'owner_user_id',
    'state',
    'from_date',
    'to_date',
    'batch_number',
    'reason',
    'status',
    'initiated_by',
    'created_at',
    'notified_at',
    'resolved_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    scope: row.scope as LivestockRecall['scope'],
    animalId: (row.animal_id as string) ?? undefined,
    lotId: (row.lot_id as string) ?? undefined,
    ownerUserId: (row.owner_user_id as string) ?? undefined,
    state: (row.state as string) ?? undefined,
    fromDate: row.from_date ? ts(row.from_date) : undefined,
    toDate: row.to_date ? ts(row.to_date) : undefined,
    batchNumber: (row.batch_number as string) ?? undefined,
    reason: row.reason as string,
    status: row.status as LivestockRecall['status'],
    initiatedBy: row.initiated_by as string,
    createdAt: ts(row.created_at),
    notifiedAt: row.notified_at ? ts(row.notified_at) : undefined,
    resolvedAt: row.resolved_at ? ts(row.resolved_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      scope: 'scope',
      animal_id: 'animalId',
      lot_id: 'lotId',
      owner_user_id: 'ownerUserId',
      state: 'state',
      from_date: 'fromDate',
      to_date: 'toDate',
      batch_number: 'batchNumber',
      reason: 'reason',
      status: 'status',
      initiated_by: 'initiatedBy',
      created_at: 'createdAt',
      notified_at: 'notifiedAt',
      resolved_at: 'resolvedAt'
    })
};

export const diseaseFlagMapper: RowMapper<DiseaseFlag> = {
  columns: [
    'id',
    'disease',
    'state',
    'lga',
    'suspected_species',
    'reporter_user_id',
    'status',
    'confirmed_by',
    'retracted_reason',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    disease: row.disease as string,
    state: row.state as string,
    lga: (row.lga as string) ?? undefined,
    suspectedSpecies: (row.suspected_species as DiseaseFlag['suspectedSpecies']) ?? undefined,
    reporterUserId: row.reporter_user_id as string,
    status: row.status as DiseaseFlag['status'],
    confirmedBy: (row.confirmed_by as string) ?? undefined,
    retractedReason: (row.retracted_reason as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      disease: 'disease',
      state: 'state',
      lga: 'lga',
      suspected_species: 'suspectedSpecies',
      reporter_user_id: 'reporterUserId',
      status: 'status',
      confirmed_by: 'confirmedBy',
      retracted_reason: 'retractedReason',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
// Wave L1c: ALTP trade/finance entities (appended).
import type {
  AggregationPoint,
  CertifiedListing,
  ColdChainLog,
  DonorDisbursement,
  ExportDocument,
  InsuranceClaim,
  InsurancePolicy,
  LivestockLien,
  OfftakeContract,
  OfftakeTemplate
} from '@agric-platform/shared';
// ---------------------------------------------------------------------------
// Wave L1c: ALTP trade/finance mappers (appended).
export const certifiedListingMapper: RowMapper<CertifiedListing> = {
  columns: [
    'id',
    'subject_type',
    'subject_id',
    'seller_user_id',
    'species',
    'breed',
    'quantity',
    'asking_price_kobo',
    'status',
    'provenance',
    'revoked_by_user_id',
    'revoked_at',
    'revocation_reason',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    subjectType: row.subject_type as CertifiedListing['subjectType'],
    subjectId: row.subject_id as string,
    sellerUserId: row.seller_user_id as string,
    species: row.species as string,
    breed: (row.breed as string) ?? undefined,
    quantity: row.quantity === null || row.quantity === undefined ? undefined : num(row.quantity),
    askingPriceKobo:
      row.asking_price_kobo === null || row.asking_price_kobo === undefined
        ? undefined
        : num(row.asking_price_kobo),
    status: row.status as CertifiedListing['status'],
    provenance: row.provenance as CertifiedListing['provenance'],
    revokedByUserId: (row.revoked_by_user_id as string) ?? undefined,
    revokedAt: row.revoked_at ? ts(row.revoked_at) : undefined,
    revocationReason: (row.revocation_reason as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      subject_type: 'subjectType',
      subject_id: 'subjectId',
      seller_user_id: 'sellerUserId',
      species: 'species',
      breed: 'breed',
      quantity: 'quantity',
      asking_price_kobo: 'askingPriceKobo',
      status: 'status',
      provenance: 'provenance',
      revoked_by_user_id: 'revokedByUserId',
      revoked_at: 'revokedAt',
      revocation_reason: 'revocationReason',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const offtakeTemplateMapper: RowMapper<OfftakeTemplate> = {
  columns: [
    'id',
    'name',
    'description',
    'species',
    'default_quantity',
    'default_price_per_unit_kobo',
    'delivery_window_days',
    'default_quality_grade',
    'status',
    'created_by_user_id',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    species: row.species as string,
    defaultQuantity:
      row.default_quantity === null || row.default_quantity === undefined
        ? undefined
        : num(row.default_quantity),
    defaultPricePerUnitKobo:
      row.default_price_per_unit_kobo === null || row.default_price_per_unit_kobo === undefined
        ? undefined
        : num(row.default_price_per_unit_kobo),
    deliveryWindowDays: num(row.delivery_window_days),
    defaultQualityGrade: (row.default_quality_grade as string) ?? undefined,
    status: row.status as OfftakeTemplate['status'],
    createdByUserId: row.created_by_user_id as string,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      description: 'description',
      species: 'species',
      default_quantity: 'defaultQuantity',
      default_price_per_unit_kobo: 'defaultPricePerUnitKobo',
      delivery_window_days: 'deliveryWindowDays',
      default_quality_grade: 'defaultQualityGrade',
      status: 'status',
      created_by_user_id: 'createdByUserId',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const offtakeContractMapper: RowMapper<OfftakeContract> = {
  columns: [
    'id',
    'template_id',
    'farmer_user_id',
    'buyer_user_id',
    'species',
    'quantity',
    'price_per_unit_kobo',
    'total_kobo',
    'delivery_window_start',
    'delivery_window_end',
    'quality_grade',
    'status',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    templateId: row.template_id as string,
    farmerUserId: row.farmer_user_id as string,
    buyerUserId: row.buyer_user_id as string,
    species: row.species as string,
    quantity: num(row.quantity),
    pricePerUnitKobo: num(row.price_per_unit_kobo),
    totalKobo: num(row.total_kobo),
    deliveryWindowStart: ts(row.delivery_window_start),
    deliveryWindowEnd: ts(row.delivery_window_end),
    qualityGrade: (row.quality_grade as string) ?? undefined,
    status: row.status as OfftakeContract['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      template_id: 'templateId',
      farmer_user_id: 'farmerUserId',
      buyer_user_id: 'buyerUserId',
      species: 'species',
      quantity: 'quantity',
      price_per_unit_kobo: 'pricePerUnitKobo',
      total_kobo: 'totalKobo',
      delivery_window_start: 'deliveryWindowStart',
      delivery_window_end: 'deliveryWindowEnd',
      quality_grade: 'qualityGrade',
      status: 'status',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const exportDocumentMapper: RowMapper<ExportDocument> = {
  columns: [
    'id',
    'document_type',
    'subject_type',
    'subject_id',
    'version',
    'status',
    'payload',
    'created_by_user_id',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    documentType: row.document_type as ExportDocument['documentType'],
    subjectType: row.subject_type as ExportDocument['subjectType'],
    subjectId: row.subject_id as string,
    version: num(row.version),
    status: row.status as ExportDocument['status'],
    payload: row.payload as ExportDocument['payload'],
    createdByUserId: row.created_by_user_id as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      document_type: 'documentType',
      subject_type: 'subjectType',
      subject_id: 'subjectId',
      version: 'version',
      status: 'status',
      payload: 'payload',
      created_by_user_id: 'createdByUserId',
      created_at: 'createdAt'
    })
};
export const lienMapper: RowMapper<LivestockLien> = {
  columns: [
    'id',
    'subject_type',
    'subject_id',
    'lender_user_id',
    'borrower_user_id',
    'principal_kobo',
    'terms',
    'status',
    'registered_at',
    'discharged_at',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    subjectType: row.subject_type as LivestockLien['subjectType'],
    subjectId: row.subject_id as string,
    lenderUserId: row.lender_user_id as string,
    borrowerUserId: row.borrower_user_id as string,
    principalKobo: num(row.principal_kobo),
    terms: row.terms as string,
    status: row.status as LivestockLien['status'],
    registeredAt: ts(row.registered_at),
    dischargedAt: row.discharged_at ? ts(row.discharged_at) : undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      subject_type: 'subjectType',
      subject_id: 'subjectId',
      lender_user_id: 'lenderUserId',
      borrower_user_id: 'borrowerUserId',
      principal_kobo: 'principalKobo',
      terms: 'terms',
      status: 'status',
      registered_at: 'registeredAt',
      discharged_at: 'dischargedAt',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const insurancePolicyMapper: RowMapper<InsurancePolicy> = {
  columns: [
    'id',
    'holder_user_id',
    'insurer_user_id',
    'subject_type',
    'subject_id',
    'species',
    'premium_kobo',
    'coverage_kobo',
    'status',
    'starts_at',
    'ends_at',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    holderUserId: row.holder_user_id as string,
    insurerUserId: (row.insurer_user_id as string) ?? undefined,
    subjectType: row.subject_type as InsurancePolicy['subjectType'],
    subjectId: row.subject_id as string,
    species: row.species as string,
    premiumKobo: num(row.premium_kobo),
    coverageKobo: num(row.coverage_kobo),
    status: row.status as InsurancePolicy['status'],
    startsAt: row.starts_at ? ts(row.starts_at) : undefined,
    endsAt: row.ends_at ? ts(row.ends_at) : undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      holder_user_id: 'holderUserId',
      insurer_user_id: 'insurerUserId',
      subject_type: 'subjectType',
      subject_id: 'subjectId',
      species: 'species',
      premium_kobo: 'premiumKobo',
      coverage_kobo: 'coverageKobo',
      status: 'status',
      starts_at: 'startsAt',
      ends_at: 'endsAt',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const insuranceClaimMapper: RowMapper<InsuranceClaim> = {
  columns: [
    'id',
    'policy_id',
    'claimant_user_id',
    'trigger',
    'recall_id',
    'animal_ids',
    'amount_kobo',
    'status',
    'notes',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    policyId: row.policy_id as string,
    claimantUserId: row.claimant_user_id as string,
    trigger: row.trigger as InsuranceClaim['trigger'],
    recallId: (row.recall_id as string) ?? undefined,
    animalIds: (row.animal_ids as string[]) ?? [],
    amountKobo:
      row.amount_kobo === null || row.amount_kobo === undefined
        ? undefined
        : num(row.amount_kobo),
    status: row.status as InsuranceClaim['status'],
    notes: (row.notes as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      policy_id: 'policyId',
      claimant_user_id: 'claimantUserId',
      trigger: 'trigger',
      recall_id: 'recallId',
      animal_ids: 'animalIds',
      amount_kobo: 'amountKobo',
      status: 'status',
      notes: 'notes',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const disbursementMapper: RowMapper<DonorDisbursement> = {
  columns: [
    'id',
    'donor_user_id',
    'programme_id',
    'milestone',
    'amount_kobo',
    'beneficiary_user_id',
    'status',
    'released_at',
    'confirmed_at',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    donorUserId: row.donor_user_id as string,
    programmeId: row.programme_id as string,
    milestone: row.milestone as DonorDisbursement['milestone'],
    amountKobo: num(row.amount_kobo),
    beneficiaryUserId: row.beneficiary_user_id as string,
    status: row.status as DonorDisbursement['status'],
    releasedAt: row.released_at ? ts(row.released_at) : undefined,
    confirmedAt: row.confirmed_at ? ts(row.confirmed_at) : undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      donor_user_id: 'donorUserId',
      programme_id: 'programmeId',
      milestone: 'milestone',
      amount_kobo: 'amountKobo',
      beneficiary_user_id: 'beneficiaryUserId',
      status: 'status',
      released_at: 'releasedAt',
      confirmed_at: 'confirmedAt',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const aggregationPointMapper: RowMapper<AggregationPoint> = {
  columns: [
    'id',
    'name',
    'state',
    'lga',
    'manager_user_id',
    'capacity',
    'lot_ids',
    'status',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    state: row.state as string,
    lga: row.lga as string,
    managerUserId: row.manager_user_id as string,
    capacity:
      row.capacity === null || row.capacity === undefined ? undefined : num(row.capacity),
    lotIds: (row.lot_ids as string[]) ?? [],
    status: row.status as AggregationPoint['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      name: 'name',
      state: 'state',
      lga: 'lga',
      manager_user_id: 'managerUserId',
      capacity: 'capacity',
      lot_ids: 'lotIds',
      status: 'status',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
export const coldChainLogMapper: RowMapper<ColdChainLog> = {
  columns: [
    'id',
    'point_id',
    'recorded_at',
    'temperature_celsius',
    'humidity_percent',
    'source',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    pointId: row.point_id as string,
    recordedAt: ts(row.recorded_at),
    temperatureCelsius: Number(row.temperature_celsius),
    humidityPercent:
      row.humidity_percent === null || row.humidity_percent === undefined
        ? undefined
        : Number(row.humidity_percent),
    source: row.source as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      point_id: 'pointId',
      recorded_at: 'recordedAt',
      temperature_celsius: 'temperatureCelsius',
      humidity_percent: 'humidityPercent',
      source: 'source',
      created_at: 'createdAt'
    })
};

// ---------------------------------------------------------------------------
// Wave MECHANIZATION: equipment hire marketplace (mechanization schema, 033).
// ---------------------------------------------------------------------------

export const equipmentListingMapper: RowMapper<EquipmentListing> = {
  columns: [
    'id',
    'owner_user_id',
    'owner_type',
    'type',
    'title',
    'description',
    'specs',
    'base_lat',
    'base_long',
    'service_area_h3',
    'service_area_resolution',
    'rates',
    'availability',
    'operator_license_ref',
    'operator_verification',
    'status',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    ownerType: row.owner_type as EquipmentListing['ownerType'],
    type: row.type as EquipmentListing['type'],
    title: row.title as string,
    description: row.description as string,
    specs: (row.specs as EquipmentListing['specs']) ?? {},
    baseLat: num(row.base_lat),
    baseLong: num(row.base_long),
    serviceAreaH3: (row.service_area_h3 as string[]) ?? [],
    serviceAreaResolution: num(row.service_area_resolution),
    rates: row.rates as EquipmentListing['rates'],
    availability: (row.availability as EquipmentListing['availability']) ?? [],
    operatorLicenseRef: (row.operator_license_ref as string) ?? undefined,
    operatorVerification: row.operator_verification as EquipmentListing['operatorVerification'],
    status: row.status as EquipmentListing['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) => {
    const row = present(item, {
      id: 'id',
      owner_user_id: 'ownerUserId',
      owner_type: 'ownerType',
      type: 'type',
      title: 'title',
      description: 'description',
      specs: 'specs',
      base_lat: 'baseLat',
      base_long: 'baseLong',
      service_area_h3: 'serviceAreaH3',
      service_area_resolution: 'serviceAreaResolution',
      rates: 'rates',
      availability: 'availability',
      operator_license_ref: 'operatorLicenseRef',
      operator_verification: 'operatorVerification',
      status: 'status',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    });
    // jsonb object columns: node-pg serialises plain objects but turns JS
    // arrays into Postgres array literals — serialise explicitly.
    if ('specs' in row) {
      row.specs = row.specs === null ? null : JSON.stringify(row.specs);
    }
    if ('rates' in row) {
      row.rates = row.rates === null ? null : JSON.stringify(row.rates);
    }
    if ('availability' in row) {
      row.availability = row.availability === null ? null : JSON.stringify(row.availability);
    }
    return row;
  }
};

export const equipmentBookingMapper: RowMapper<EquipmentBooking> = {
  columns: [
    'id',
    'listing_id',
    'owner_user_id',
    'farmer_id',
    'plot_id',
    'plot_lat',
    'plot_long',
    'plot_h3',
    'area_ha',
    'estimated_hours',
    'window_start',
    'window_end',
    'status',
    'quote',
    'advisory',
    'hold_entry_id',
    'farmer_confirmed_completion_at',
    'owner_confirmed_completion_at',
    'rating',
    'review_comment',
    'cancelled_by',
    'cancel_reason',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    listingId: row.listing_id as string,
    ownerUserId: row.owner_user_id as string,
    farmerId: row.farmer_id as string,
    plotId: (row.plot_id as string) ?? undefined,
    plotLat: num(row.plot_lat),
    plotLong: num(row.plot_long),
    plotH3: row.plot_h3 as string,
    areaHa: num(row.area_ha),
    estimatedHours: row.estimated_hours != null ? num(row.estimated_hours) : undefined,
    windowStart: ts(row.window_start),
    windowEnd: ts(row.window_end),
    status: row.status as EquipmentBooking['status'],
    quote: (row.quote as EquipmentBooking['quote']) ?? undefined,
    advisory: (row.advisory as EquipmentBooking['advisory']) ?? undefined,
    holdEntryId: (row.hold_entry_id as string) ?? undefined,
    farmerConfirmedCompletionAt:
      row.farmer_confirmed_completion_at != null
        ? ts(row.farmer_confirmed_completion_at)
        : undefined,
    ownerConfirmedCompletionAt:
      row.owner_confirmed_completion_at != null ? ts(row.owner_confirmed_completion_at) : undefined,
    rating: row.rating != null ? num(row.rating) : undefined,
    reviewComment: (row.review_comment as string) ?? undefined,
    cancelledBy: (row.cancelled_by as EquipmentBooking['cancelledBy']) ?? undefined,
    cancelReason: (row.cancel_reason as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) => {
    const row = present(item, {
      id: 'id',
      listing_id: 'listingId',
      owner_user_id: 'ownerUserId',
      farmer_id: 'farmerId',
      plot_id: 'plotId',
      plot_lat: 'plotLat',
      plot_long: 'plotLong',
      plot_h3: 'plotH3',
      area_ha: 'areaHa',
      estimated_hours: 'estimatedHours',
      window_start: 'windowStart',
      window_end: 'windowEnd',
      status: 'status',
      quote: 'quote',
      advisory: 'advisory',
      hold_entry_id: 'holdEntryId',
      farmer_confirmed_completion_at: 'farmerConfirmedCompletionAt',
      owner_confirmed_completion_at: 'ownerConfirmedCompletionAt',
      rating: 'rating',
      review_comment: 'reviewComment',
      cancelled_by: 'cancelledBy',
      cancel_reason: 'cancelReason',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    });
    if ('quote' in row) {
      row.quote = row.quote === null ? null : JSON.stringify(row.quote);
    }
    if ('advisory' in row) {
      row.advisory = row.advisory === null ? null : JSON.stringify(row.advisory);
    }
    return row;
  }
};
