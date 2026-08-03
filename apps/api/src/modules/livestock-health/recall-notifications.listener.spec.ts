import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository
} from '../../database/repositories/livestock.repository.js';
import {
  createInMemoryDiseaseFlagRepository,
  createInMemoryHealthRecordRepository,
  createInMemoryMovementPermitRepository,
  createInMemoryMovementRepository,
  createInMemoryRecallRepository
} from '../../database/repositories/livestock-health.repository.js';
import { LivestockHealthService } from './livestock-health.service.js';
import { RecallNotificationsListener } from './recall-notifications.listener.js';

type UserRef = Pick<User, 'id' | 'roles'>;

const asUser = (ref: UserRef): User => ({
  phone: '+2348000000000',
  fullName: 'Spec User',
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...ref
});

const farmer = asUser({ id: 'farmer-1', roles: ['farmer'] });
const otherFarmer = asUser({ id: 'farmer-2', roles: ['farmer'] });
const regulator = asUser({ id: 'reg-1', roles: ['regulator'] });

const makeAnimal = (overrides: Partial<Animal> = {}): Animal => ({
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: farmer.id,
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('RecallNotificationsListener', () => {
  const animalA = makeAnimal({ id: 'NG-BOV-KD-000001' });
  const animalC = makeAnimal({ id: 'NG-BOV-LA-000003', ownerUserId: otherFarmer.id, state: 'Lagos' });

  let recalls: ReturnType<typeof createInMemoryRecallRepository>;
  let notifications: { send: ReturnType<typeof vi.fn> };
  let service: LivestockHealthService;
  let listener: RecallNotificationsListener;
  let eventsRef: DomainEventsService;

  beforeEach(() => {
    const animals = createInMemoryAnimalRepository(undefined, [animalA, animalC]);
    recalls = createInMemoryRecallRepository();
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    eventsRef = events;
    service = new LivestockHealthService(
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      events,
      { notifyConfirmed: vi.fn() } as never,
      animals,
      createInMemoryLotRepository(),
      createInMemoryHealthRecordRepository(),
      createInMemoryMovementRepository(),
      createInMemoryMovementPermitRepository(),
      recalls,
      createInMemoryDiseaseFlagRepository()
    );
    notifications = { send: vi.fn().mockResolvedValue({ id: 'notification-1' }) };
    listener = new RecallNotificationsListener(events, notifications as never, service);
    listener.onModuleInit();
  });

  it('notifies every affected owner in-app and flips the recall to notified', async () => {
    const { recall } = await service.initiateRecall(regulator, {
      ownerUserId: farmer.id,
      reason: 'FMD-contaminated batch'
    });
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: farmer.id,
        channel: 'in_app',
        title: 'Livestock recall notice'
      })
    );
    const stored = await recalls.getById(recall.id);
    expect(stored.status).toBe('notified');
    expect(stored.notifiedAt).toBeDefined();
  });

  it('mentions the affected animal count and reason in the body', async () => {
    await service.initiateRecall(regulator, {
      animalId: animalA.id,
      reason: 'Anthrax suspicion'
    });
    await flush();
    const body = notifications.send.mock.calls[0][0].body as string;
    expect(body).toContain('1 animal(s)');
    expect(body).toContain('Anthrax suspicion');
  });

  it('fans out to multiple owners', async () => {
    await service.initiateRecall(regulator, { state: 'Kaduna', reason: 'Regional FMD scare' });
    await service.initiateRecall(regulator, { animalId: animalC.id, reason: 'Lagos scare' });
    await flush();
    const notified = notifications.send.mock.calls.map((call) => call[0].userId);
    expect(notified).toContain(farmer.id);
    expect(notified).toContain(otherFarmer.id);
  });

  it('a failed delivery does not block other owners or the lifecycle flip', async () => {
    notifications.send
      .mockRejectedValueOnce(new Error('channel disabled'))
      .mockResolvedValue({ id: 'notification-2' });
    const { recall } = await service.initiateRecall(regulator, {
      state: 'Kaduna',
      reason: 'Regional FMD scare'
    });
    await service.initiateRecall(regulator, { animalId: animalC.id, reason: 'Lagos scare' });
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(2);
    expect((await recalls.getById(recall.id)).status).toBe('notified');
  });

  it('ignores unrelated domain events', async () => {
    await service.reportDiseaseFlag(farmer, { disease: 'FMD', state: 'Kaduna' });
    await flush();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('deduplicates redelivered recall events (G17): owners are notified once', async () => {
    const { recall } = await service.initiateRecall(regulator, {
      ownerUserId: farmer.id,
      reason: 'FMD-contaminated batch'
    });
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(1);
    // Simulate an outbox-sweeper redelivery: the SAME event id is emitted
    // again. The dedup guard must suppress the second fan-out entirely.
    const redelivered = {
      id: `event-redelivery-${recall.id}`,
      name: 'livestock.recall.initiated',
      payload: {
        recallId: recall.id,
        reason: 'FMD-contaminated batch',
        animalIds: [animalA.id],
        ownerUserIds: [farmer.id]
      },
      occurredAt: new Date().toISOString()
    };
    // Re-emit the exact same event id twice to prove once-only semantics.
    eventsRef.emit(redelivered as never);
    eventsRef.emit(redelivered as never);
    await flush();
    expect(notifications.send).toHaveBeenCalledTimes(2); // +1, not +2
  });
});
