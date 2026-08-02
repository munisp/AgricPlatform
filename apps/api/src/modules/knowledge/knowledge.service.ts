import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  ApiListResponse,
  KnowledgeFormat,
  KnowledgeResource,
  LanguageCode,
  PodcastEpisode,
  Webinar,
  WebinarRegistration,
  WebinarStatus
} from '@agric-platform/shared';
import { DEFAULT_WEBINAR_TIMEZONE, LANGUAGE_CODES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  KNOWLEDGE_RESOURCE_REPOSITORY,
  PODCAST_EPISODE_REPOSITORY,
  WEBINAR_REGISTRATION_REPOSITORY,
  WEBINAR_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  KnowledgeResourceCriteria,
  KnowledgeResourceRepository,
  PodcastEpisodeRepository
} from '../../database/repositories/knowledge.repository.js';
import type {
  WebinarRegistrationRepository,
  WebinarRepository
} from '../../database/repositories/webinar.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';

export interface CreateResourceInput {
  title: string;
  body: string;
  tags?: string[];
  language?: LanguageCode;
  format: KnowledgeFormat;
  offlineAvailable?: boolean;
}

export interface CreateEpisodeInput {
  title: string;
  showNotes: string;
  audioUrl: string;
  durationSeconds: number;
  transcript?: string;
}

export interface CreateWebinarInput {
  title: string;
  hostUserId: string;
  startsAt: string;
  timezone?: string;
}

const WEBINAR_TRANSITIONS: Readonly<Record<WebinarStatus, readonly WebinarStatus[]>> = {
  scheduled: ['live', 'cancelled'],
  live: ['completed'],
  completed: [],
  cancelled: []
};

/** Validates an IANA timezone name without any external dependency. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly domainEvents: DomainEventsService,
    @Inject(KNOWLEDGE_RESOURCE_REPOSITORY) private readonly resources: KnowledgeResourceRepository,
    @Inject(PODCAST_EPISODE_REPOSITORY) private readonly episodes: PodcastEpisodeRepository,
    @Inject(WEBINAR_REPOSITORY) private readonly webinars: WebinarRepository,
    @Inject(WEBINAR_REGISTRATION_REPOSITORY) private readonly registrations: WebinarRegistrationRepository
  ) {}

  // -- Resource library ---------------------------------------------------------

  async listResources(
    filter: KnowledgeResourceCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<KnowledgeResource>> {
    return this.resources.searchPage(
      {
        tag: filter.tag,
        language: filter.language,
        format: filter.format,
        offlineAvailable: filter.offlineAvailable
      },
      filter.page,
      filter.pageSize
    );
  }

  /** Reading a resource counts as a view. */
  async getResource(id: string): Promise<KnowledgeResource> {
    return this.resources.getById(id);
  }

  async recordView(id: string): Promise<KnowledgeResource> {
    return this.resources.incrementViewCount(id);
  }

  async createResource(input: CreateResourceInput, actorId: string): Promise<KnowledgeResource> {
    if (input.language && !LANGUAGE_CODES.includes(input.language)) {
      throw new BadRequestException(`Unsupported language code '${input.language}'`);
    }
    const resource: KnowledgeResource = {
      id: newId('resource'),
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      language: input.language ?? 'en',
      format: input.format,
      offlineAvailable: input.offlineAvailable ?? false,
      viewCount: 0,
      publishedAt: new Date().toISOString()
    };
    const created = await this.resources.create(resource);
    await this.domainEvents.publish('knowledge.resource.published', { resourceId: created.id }, actorId);
    return created;
  }

  // -- Podcast episodes -------------------------------------------------------------

  async listEpisodes(): Promise<PodcastEpisode[]> {
    return this.episodes.all();
  }

  async getEpisode(id: string): Promise<PodcastEpisode> {
    return this.episodes.getById(id);
  }

  async createEpisode(input: CreateEpisodeInput, actorId: string): Promise<PodcastEpisode> {
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds <= 0) {
      throw new BadRequestException('durationSeconds must be a positive integer');
    }
    const episode: PodcastEpisode = {
      id: newId('episode'),
      title: input.title,
      showNotes: input.showNotes,
      audioUrl: input.audioUrl,
      durationSeconds: input.durationSeconds,
      transcript: input.transcript,
      publishedAt: new Date().toISOString()
    };
    const created = await this.episodes.create(episode);
    await this.domainEvents.publish('knowledge.episode.published', { episodeId: created.id }, actorId);
    return created;
  }

  /** Transcripts are an accessibility requirement; they can be attached post-publication. */
  async setTranscript(id: string, transcript: string, actorId: string): Promise<PodcastEpisode> {
    if (!transcript || transcript.trim() === '') {
      throw new BadRequestException('Transcript must not be empty');
    }
    const updated = await this.episodes.update(id, { transcript });
    await this.domainEvents.publish('knowledge.episode.transcribed', { episodeId: id }, actorId);
    return updated;
  }

  // -- Webinars -----------------------------------------------------------------------

  async listWebinars(filter: { status?: WebinarStatus; hostUserId?: string }): Promise<Webinar[]> {
    return this.webinars.find(filter);
  }

  async getWebinar(id: string): Promise<Webinar> {
    return this.webinars.getById(id);
  }

  async createWebinar(input: CreateWebinarInput, actorId: string): Promise<Webinar> {
    const timezone = input.timezone ?? DEFAULT_WEBINAR_TIMEZONE;
    if (!isValidTimezone(timezone)) {
      throw new BadRequestException(`Unknown IANA timezone '${timezone}'`);
    }
    if (Number.isNaN(Date.parse(input.startsAt))) {
      throw new BadRequestException('startsAt must be a valid ISO-8601 timestamp');
    }
    const webinar: Webinar = {
      id: newId('webinar'),
      title: input.title,
      hostUserId: input.hostUserId,
      startsAt: new Date(input.startsAt).toISOString(),
      timezone,
      status: 'scheduled',
      createdAt: new Date().toISOString()
    };
    const created = await this.webinars.create(webinar);
    await this.domainEvents.publish('knowledge.webinar.scheduled', { webinarId: created.id }, actorId);
    return created;
  }

  async setWebinarStatus(id: string, status: WebinarStatus, actorId: string): Promise<Webinar> {
    const webinar = await this.webinars.getById(id);
    if (status === webinar.status) {
      return webinar;
    }
    if (!WEBINAR_TRANSITIONS[webinar.status].includes(status)) {
      throw new BadRequestException(
        `Invalid webinar transition from '${webinar.status}' to '${status}'`
      );
    }
    const updated = await this.webinars.update(id, { status });
    await this.domainEvents.publish('knowledge.webinar.status_changed', { webinarId: id, status }, actorId);
    return updated;
  }

  /** Recording URL is only attachable once the event has completed. */
  async attachRecording(id: string, recordingUrl: string, actorId: string): Promise<Webinar> {
    const webinar = await this.webinars.getById(id);
    if (webinar.status !== 'completed') {
      throw new ConflictException('Recording can only be attached after the webinar completes');
    }
    const updated = await this.webinars.update(id, { recordingUrl });
    await this.domainEvents.publish('knowledge.webinar.recording_attached', { webinarId: id }, actorId);
    return updated;
  }

  async registerForWebinar(webinarId: string, userId: string): Promise<WebinarRegistration> {
    const webinar = await this.webinars.getById(webinarId);
    if (webinar.status !== 'scheduled') {
      throw new ConflictException('Registration is only open for scheduled webinars');
    }
    if (await this.registrations.findOne({ webinarId, userId })) {
      throw new ConflictException('User is already registered for this webinar');
    }
    const registration: WebinarRegistration = {
      id: newId('registration'),
      webinarId,
      userId,
      registeredAt: new Date().toISOString()
    };
    const created = await this.registrations.create(registration);
    await this.domainEvents.publish('knowledge.webinar.registration_recorded', { webinarId, userId }, userId);
    return created;
  }

  async listRegistrations(webinarId: string): Promise<WebinarRegistration[]> {
    await this.webinars.getById(webinarId);
    return this.registrations.find({ webinarId });
  }
}
