import { HttpException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { MetricsService } from '../../common/metrics/metrics.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryPinProfileRepository } from '../../database/repositories/pin-profile.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import type { OtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { PinSessionService } from './pin-session.service.js';

const DEVICE = 'device-token-aaaa';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const events = { publish: vi.fn(async () => ({})) } as unknown as DomainEventsService;
  const metrics = {} as unknown as MetricsService;
  const otp = {} as unknown as OtpChallengeStore;
  const auth = new AuthService(users, events, metrics, otp);
  const profiles = createInMemoryPinProfileRepository();
  const service = new PinSessionService(profiles, users, auth, events);
  return { service, users, profiles, events };
}

async function makeUser(users: UsersService, phone: string, name: string): Promise<User> {
  return users.create({ phone, fullName: name, roles: ['farmer'], preferredLanguage: 'en' });
}

describe('PinSessionService', () => {
  it('stores only the salted hash, never the raw PIN', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234900', 'Parent One');
    await service.addProfile(user.id, DEVICE, '1234');
    const stored = await profiles.find(DEVICE, user.id);
    expect(stored?.pinHash).toBe(service.hashPin(DEVICE, user.id, '1234'));
    expect(JSON.stringify(stored)).not.toContain('1234');
  });

  it('salts the hash per device and user', async () => {
    const { service } = build();
    expect(service.hashPin('device-1', 'user-1', '1234')).not.toBe(service.hashPin('device-2', 'user-1', '1234'));
    expect(service.hashPin('device-1', 'user-1', '1234')).not.toBe(service.hashPin('device-1', 'user-2', '1234'));
  });

  it('enforces the 5-profiles-per-device cap', async () => {
    const { service, users } = build();
    for (let i = 0; i < 5; i += 1) {
      const user = await makeUser(users, `+23491${i}`, `Member ${i}`);
      await service.addProfile(user.id, DEVICE, '1234');
    }
    const sixth = await makeUser(users, '+234915', 'Member 6');
    await expect(service.addProfile(sixth.id, DEVICE, '1234')).rejects.toThrow(/maximum of 5 profiles/);
    // …but the cap does not follow the user to a different device.
    await expect(service.addProfile(sixth.id, 'device-token-bbbb', '1234')).resolves.toMatchObject({
      profilesOnDevice: 1
    });
  });

  it('re-pinning the same user updates the PIN without growing the device', async () => {
    const { service, users } = build();
    const user = await makeUser(users, '+234920', 'Re Pin');
    await service.addProfile(user.id, DEVICE, '1234');
    const view = await service.addProfile(user.id, DEVICE, '4321');
    expect(view.profilesOnDevice).toBe(1);
    await expect(service.switchProfile(DEVICE, user.id, '1234')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(service.switchProfile(DEVICE, user.id, '4321')).resolves.toMatchObject({
      user: { id: user.id }
    });
  });

  it('rejects malformed PINs', async () => {
    const { service, users } = build();
    const user = await makeUser(users, '+234921', 'Bad Pin');
    await expect(service.addProfile(user.id, DEVICE, '12345')).rejects.toThrow(/4 digits/);
    await expect(service.addProfile(user.id, DEVICE, 'abcd')).rejects.toThrow(/4 digits/);
    await expect(service.switchProfile(DEVICE, user.id, '12 4')).rejects.toThrow(/4 digits/);
  });

  it('issues a session on the correct PIN and resets attempts', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234922', 'Swap Me');
    await service.addProfile(user.id, DEVICE, '1234');
    await expect(service.switchProfile(DEVICE, user.id, '0000')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    expect((await profiles.find(DEVICE, user.id))?.attempts).toBe(1);
    const result = await service.switchProfile(DEVICE, user.id, '1234');
    expect(result.token).toMatch(/^stub-token\./);
    expect(result.user.id).toBe(user.id);
    expect((await profiles.find(DEVICE, user.id))?.attempts).toBe(0);
  });

  it('locks the profile after 5 wrong PINs for 15 minutes', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234923', 'Lock Me');
    await service.addProfile(user.id, DEVICE, '1234');
    for (let i = 0; i < 4; i += 1) {
      await expect(service.switchProfile(DEVICE, user.id, '9999')).rejects.toBeInstanceOf(
        UnauthorizedException
      );
    }
    // 5th wrong PIN trips the lockout with a 429.
    const fifth = await service.switchProfile(DEVICE, user.id, '9999').catch((error) => error);
    expect(fifth).toBeInstanceOf(HttpException);
    expect((fifth as HttpException).getStatus()).toBe(429);
    const locked = await profiles.find(DEVICE, user.id);
    expect(locked?.lockedUntil).toBeDefined();
    // Even the correct PIN is rejected while locked.
    const duringLock = await service.switchProfile(DEVICE, user.id, '1234').catch((error) => error);
    expect((duringLock as HttpException).getStatus()).toBe(429);
  });

  it('accepts the correct PIN again once the lock has expired', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234924', 'Unlock Me');
    await service.addProfile(user.id, DEVICE, '1234');
    for (let i = 0; i < 5; i += 1) {
      await service.switchProfile(DEVICE, user.id, '9999').catch(() => undefined);
    }
    // Simulate the lockout window passing.
    await profiles.update(DEVICE, user.id, {
      lockedUntil: new Date(Date.now() - 1000).toISOString()
    });
    await expect(service.switchProfile(DEVICE, user.id, '1234')).resolves.toMatchObject({
      user: { id: user.id }
    });
    const after = await profiles.find(DEVICE, user.id);
    expect(after?.lockedUntil).toBeUndefined();
    expect(after?.attempts).toBe(0);
  });

  it('rejects unknown device profiles', async () => {
    const { service } = build();
    await expect(service.switchProfile(DEVICE, 'user-nope', '1234')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('lists device profiles without exposing hashes', async () => {
    const { service, users } = build();
    const a = await makeUser(users, '+234925', 'List A');
    const b = await makeUser(users, '+234926', 'List B');
    await service.addProfile(a.id, DEVICE, '1234');
    await service.addProfile(b.id, DEVICE, '1234');
    const list = await service.listProfiles(DEVICE);
    expect(list.map((profile) => profile.userId).sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(list)).not.toContain('pinHash');
  });
});
