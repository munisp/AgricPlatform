import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryKnowledgeResourceRepository,
  createInMemoryPodcastEpisodeRepository
} from '../../database/repositories/knowledge.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryWebinarRegistrationRepository,
  createInMemoryWebinarRepository
} from '../../database/repositories/webinar.repository.js';
import { isValidTimezone, KnowledgeService } from './knowledge.service.js';

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  return new KnowledgeService(
    events,
    createInMemoryKnowledgeResourceRepository(),
    createInMemoryPodcastEpisodeRepository(),
    createInMemoryWebinarRepository(),
    createInMemoryWebinarRegistrationRepository()
  );
}

describe('KnowledgeService resources', () => {
  it('publishes resources with tags and language defaults', async () => {
    const service = makeService();
    const resource = await service.createResource(
      { title: 'Maize spacing guide', body: '…', format: 'article', tags: ['maize', 'agronomy'] },
      'user-admin'
    );
    expect(resource.language).toBe('en');
    expect(resource.viewCount).toBe(0);
    expect((await service.listResources({ tag: 'maize' })).total).toBe(1);
    expect((await service.listResources({ tag: 'rice' })).total).toBe(0);
  });

  it('rejects unsupported language codes', async () => {
    const service = makeService();
    await expect(
      service.createResource(
        { title: 'x', body: 'y', format: 'pdf', language: 'fr' as never },
        'user-admin'
      )
    ).rejects.toThrowError(BadRequestException);
  });

  it('increments the view count atomically', async () => {
    const service = makeService();
    const resource = await service.createResource(
      { title: 'Cold chain video', body: '…', format: 'video', offlineAvailable: true },
      'user-admin'
    );
    await service.recordView(resource.id);
    expect((await service.recordView(resource.id)).viewCount).toBe(2);
    expect((await service.listResources({ offlineAvailable: true })).total).toBe(1);
  });
});

describe('KnowledgeService podcast episodes', () => {
  it('publishes episodes with transcripts for accessibility', async () => {
    const service = makeService();
    const episode = await service.createEpisode(
      {
        title: 'Episode 1',
        showNotes: 'Intro',
        audioUrl: 'https://cdn.example.ng/ep1.mp3',
        durationSeconds: 600,
        transcript: 'Welcome to the show.'
      },
      'user-admin'
    );
    expect(episode.transcript).toBeDefined();
  });

  it('allows attaching a transcript later and rejects empty transcripts', async () => {
    const service = makeService();
    const episode = await service.createEpisode(
      { title: 'Episode 2', showNotes: 'n', audioUrl: 'https://cdn.example.ng/ep2.mp3', durationSeconds: 60 },
      'user-admin'
    );
    expect(episode.transcript).toBeUndefined();
    expect((await service.setTranscript(episode.id, 'Full transcript', 'user-admin')).transcript).toBe(
      'Full transcript'
    );
    await expect(service.setTranscript(episode.id, '  ', 'user-admin')).rejects.toThrowError(
      BadRequestException
    );
  });

  it('validates duration', async () => {
    const service = makeService();
    await expect(
      service.createEpisode(
        { title: 'x', showNotes: 'n', audioUrl: 'https://cdn.example.ng/e.mp3', durationSeconds: 0 },
        'user-admin'
      )
    ).rejects.toThrowError(BadRequestException);
  });
});

describe('KnowledgeService webinars', () => {
  it('validates IANA timezones and defaults to Africa/Lagos', async () => {
    expect(isValidTimezone('Africa/Lagos')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    const service = makeService();
    const webinar = await service.createWebinar(
      { title: 'Dry season prep', hostUserId: 'user-admin', startsAt: '2026-10-01T10:00:00+01:00' },
      'user-admin'
    );
    expect(webinar.timezone).toBe('Africa/Lagos');
    await expect(
      service.createWebinar(
        { title: 'x', hostUserId: 'user-admin', startsAt: '2026-10-01T10:00:00Z', timezone: 'Mars/Olympus' },
        'user-admin'
      )
    ).rejects.toThrowError(/timezone/);
  });

  it('walks scheduled → live → completed and gates recordings post-event', async () => {
    const service = makeService();
    const webinar = await service.createWebinar(
      { title: 'w', hostUserId: 'user-admin', startsAt: '2026-10-01T10:00:00+01:00' },
      'user-admin'
    );
    await expect(
      service.attachRecording(webinar.id, 'https://cdn.example.ng/rec.mp4', 'user-admin')
    ).rejects.toThrowError(ConflictException);
    await expect(service.setWebinarStatus(webinar.id, 'completed', 'user-admin')).rejects.toThrowError(
      /Invalid webinar transition/
    );
    await service.setWebinarStatus(webinar.id, 'live', 'user-admin');
    await service.setWebinarStatus(webinar.id, 'completed', 'user-admin');
    const recorded = await service.attachRecording(webinar.id, 'https://cdn.example.ng/rec.mp4', 'user-admin');
    expect(recorded.recordingUrl).toBeDefined();
  });

  it('registers attendees once and only while scheduled', async () => {
    const service = makeService();
    const webinar = await service.createWebinar(
      { title: 'w', hostUserId: 'user-admin', startsAt: '2026-10-01T10:00:00+01:00' },
      'user-admin'
    );
    await service.registerForWebinar(webinar.id, 'user-aisha');
    await expect(service.registerForWebinar(webinar.id, 'user-aisha')).rejects.toThrowError(
      ConflictException
    );
    expect(await service.listRegistrations(webinar.id)).toHaveLength(1);
    await service.setWebinarStatus(webinar.id, 'cancelled', 'user-admin');
    await expect(service.registerForWebinar(webinar.id, 'user-adamu')).rejects.toThrowError(
      ConflictException
    );
  });

  it('lists only the requesting user\'s own registrations', async () => {
    const service = makeService();
    const webinar = await service.createWebinar(
      { title: 'w', hostUserId: 'user-admin', startsAt: '2026-10-01T10:00:00+01:00' },
      'user-admin'
    );
    const mine = await service.registerForWebinar(webinar.id, 'user-aisha');
    await service.registerForWebinar(webinar.id, 'user-adamu');

    const registrations = await service.listMyRegistrations('user-aisha');
    expect(registrations.map((entry) => entry.id)).toEqual([mine.id]);
    expect(registrations.every((entry) => entry.userId === 'user-aisha')).toBe(true);
    expect(await service.listMyRegistrations('user-unknown')).toEqual([]);
  });
});
