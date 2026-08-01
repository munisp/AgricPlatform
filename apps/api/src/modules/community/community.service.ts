import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApiListResponse, ForumTopic, MentorRequest } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  seedForumTopics,
  seedMentorRequests,
  type TopicFlag
} from '../../database/seed-data.js';

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
  private readonly topics = new InMemoryRepository<ForumTopic>(seedForumTopics);
  private readonly mentorRequests = new InMemoryRepository<MentorRequest>(seedMentorRequests);
  private readonly flags = new InMemoryRepository<TopicFlag>([]);

  constructor(private readonly events: DomainEventsService) {}

  listTopics(filter: {
    category?: string;
    state?: string;
    crop?: string;
    q?: string;
    page?: number;
    pageSize?: number;
  }): ApiListResponse<ForumTopic> {
    let items = this.topics.all();
    if (filter.category) items = items.filter((t) => t.category === filter.category);
    if (filter.state) items = items.filter((t) => t.state === filter.state);
    if (filter.crop) items = items.filter((t) => t.crop === filter.crop);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      items = items.filter((t) => t.title.toLowerCase().includes(q));
    }
    return paginate(items, filter.page, filter.pageSize);
  }

  allTopics(): ForumTopic[] {
    return this.topics.all();
  }

  getTopic(id: string): ForumTopic {
    return this.topics.getById(id);
  }

  createTopic(input: CreateTopicInput): ForumTopic {
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
    const created = this.topics.create(topic);
    this.events.publish('community.topic.created', { topicId: created.id }, input.authorId);
    return created;
  }

  reply(topicId: string, authorId: string): ForumTopic {
    const topic = this.topics.getById(topicId);
    const updated = this.topics.update(topicId, { replyCount: topic.replyCount + 1 });
    this.events.publish('community.topic.replied', { topicId }, authorId);
    return updated;
  }

  flag(topicId: string, reporterId: string, reason: string): TopicFlag {
    this.topics.getById(topicId);
    const flag: TopicFlag = {
      id: newId('flag'),
      topicId,
      reporterId,
      reason,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    const created = this.flags.create(flag);
    this.events.publish('community.topic.flagged', { topicId, flagId: created.id }, reporterId);
    return created;
  }

  openFlags(): TopicFlag[] {
    return this.flags.find((f) => f.status === 'open');
  }

  createMentorRequest(input: CreateMentorRequestInput): MentorRequest {
    const request: MentorRequest = {
      id: newId('mentor'),
      userId: input.userId,
      crop: input.crop,
      state: input.state,
      challenge: input.challenge,
      status: 'requested',
      createdAt: new Date().toISOString()
    };
    const created = this.mentorRequests.create(request);
    this.events.publish('community.mentorship.requested', { requestId: created.id }, input.userId);
    return created;
  }

  listMentorRequests(filter: { userId?: string; status?: MentorRequest['status'] }): MentorRequest[] {
    return this.mentorRequests.find(
      (r) => (!filter.userId || r.userId === filter.userId) && (!filter.status || r.status === filter.status)
    );
  }

  updateMentorRequestStatus(id: string, status: MentorRequest['status']): MentorRequest {
    const request = this.mentorRequests.findById(id);
    if (!request) {
      throw new NotFoundException(`Mentor request '${id}' not found`);
    }
    const updated = this.mentorRequests.update(id, { status });
    this.events.publish('community.mentorship.updated', { requestId: id, status }, request.userId);
    return updated;
  }
}
