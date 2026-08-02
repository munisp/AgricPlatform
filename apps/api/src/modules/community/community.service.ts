import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiListResponse, ForumTopic, MentorRequest } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  FORUM_TOPIC_REPOSITORY,
  MENTOR_REQUEST_REPOSITORY,
  TOPIC_FLAG_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ForumTopicCriteria,
  ForumTopicRepository
} from '../../database/repositories/forum-topic.repository.js';
import type { MentorRequestRepository } from '../../database/repositories/mentor-request.repository.js';
import type { TopicFlagRepository } from '../../database/repositories/topic-flag.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import type { TopicFlag } from '../../database/seed-data.js';

export interface CreateTopicInput {
  title: string;
  category: string;
  authorId: string;
  state?: string;
  crop?: string;
}

export interface CreateMentorRequestInput {
  userId: string;
  crop: string;
  state: string;
  challenge: string;
}

@Injectable()
export class CommunityService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(FORUM_TOPIC_REPOSITORY) private readonly topics: ForumTopicRepository,
    @Inject(MENTOR_REQUEST_REPOSITORY) private readonly mentorRequests: MentorRequestRepository,
    @Inject(TOPIC_FLAG_REPOSITORY) private readonly flags: TopicFlagRepository
  ) {}

  async listTopics(
    filter: ForumTopicCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<ForumTopic>> {
    return this.topics.searchPage(
      { category: filter.category, state: filter.state, crop: filter.crop, q: filter.q },
      filter.page,
      filter.pageSize
    );
  }

  async allTopics(): Promise<ForumTopic[]> {
    return this.topics.all();
  }

  async getTopic(id: string): Promise<ForumTopic> {
    return this.topics.getById(id);
  }

  async createTopic(input: CreateTopicInput): Promise<ForumTopic> {
    const topic: ForumTopic = {
      id: newId('topic'),
      title: input.title,
      category: input.category,
      authorId: input.authorId,
      state: input.state,
      crop: input.crop,
      replyCount: 0,
      createdAt: new Date().toISOString()
    };
    const created = await this.topics.create(topic);
    await this.events.publish('community.topic.created', { topicId: created.id }, input.authorId);
    return created;
  }

  async reply(topicId: string, authorId: string): Promise<ForumTopic> {
    const updated = await this.topics.incrementReplyCount(topicId);
    await this.events.publish('community.topic.replied', { topicId }, authorId);
    return updated;
  }

  async flag(topicId: string, reporterId: string, reason: string): Promise<TopicFlag> {
    await this.topics.getById(topicId);
    const flag: TopicFlag = {
      id: newId('flag'),
      topicId,
      reporterId,
      reason,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    const created = await this.flags.create(flag);
    await this.events.publish('community.topic.flagged', { topicId, flagId: created.id }, reporterId);
    return created;
  }

  async openFlags(): Promise<TopicFlag[]> {
    return this.flags.find({ status: 'open' });
  }

  async createMentorRequest(input: CreateMentorRequestInput): Promise<MentorRequest> {
    const request: MentorRequest = {
      id: newId('mentor'),
      userId: input.userId,
      crop: input.crop,
      state: input.state,
      challenge: input.challenge,
      status: 'requested',
      createdAt: new Date().toISOString()
    };
    const created = await this.mentorRequests.create(request);
    await this.events.publish('community.mentorship.requested', { requestId: created.id }, input.userId);
    return created;
  }

  async listMentorRequests(filter: {
    userId?: string;
    status?: MentorRequest['status'];
  }): Promise<MentorRequest[]> {
    return this.mentorRequests.find({ userId: filter.userId, status: filter.status });
  }

  async updateMentorRequestStatus(
    id: string,
    status: MentorRequest['status']
  ): Promise<MentorRequest> {
    const request = await this.mentorRequests.findById(id);
    if (!request) {
      throw new NotFoundException(`Mentor request '${id}' not found`);
    }
    const updated = await this.mentorRequests.update(id, { status });
    await this.events.publish('community.mentorship.updated', { requestId: id, status }, request.userId);
    return updated;
  }
}
