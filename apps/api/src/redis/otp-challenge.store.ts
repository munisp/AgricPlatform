import type { KeyValueStore } from './key-value-store.js';

export interface OtpChallenge {
  id: string;
  phone: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const CHALLENGE_PREFIX = 'otp:challenge:';
const PHONE_PREFIX = 'otp:phone:';
const PHONE_FAILURE_PREFIX = 'otp:phone-failures:';

/**
 * OTP challenge store (plan §7). Challenges are keyed by id with a phone
 * index so requesting a new code invalidates outstanding challenges for the
 * same number. `consume` is an atomic GETDEL, making a successful
 * verification single-use even across replicas. The attempt-counter and
 * lockout logic itself stays in AuthService (security wave).
 */
export interface OtpChallengeStore {
  save(challenge: OtpChallenge, ttlMs: number): Promise<void>;
  get(id: string): Promise<OtpChallenge | undefined>;
  delete(id: string): Promise<void>;
  /** Atomic single-use read; undefined when the challenge is gone/expired. */
  consume(id: string): Promise<OtpChallenge | undefined>;
  invalidateForPhone(phone: string): Promise<void>;
  /**
   * Per-phone rolling failure counter (audit C3): reissuing a challenge must
   * not reset the guessing budget, so failed verifications are counted per
   * phone in a fixed window anchored at the first failure.
   */
  phoneFailureCount(phone: string): Promise<number>;
  /** Atomically increments the per-phone failure counter; returns the new count. */
  registerPhoneFailure(phone: string, windowMs: number): Promise<number>;
}

export class KeyValueOtpChallengeStore implements OtpChallengeStore {
  constructor(private readonly kv: KeyValueStore) {}

  async save(challenge: OtpChallenge, ttlMs: number): Promise<void> {
    await this.kv.set(
      `${CHALLENGE_PREFIX}${challenge.id}`,
      JSON.stringify(challenge),
      ttlMs
    );
    await this.kv.set(`${PHONE_PREFIX}${challenge.phone}`, challenge.id, ttlMs);
  }

  async get(id: string): Promise<OtpChallenge | undefined> {
    const raw = await this.kv.get(`${CHALLENGE_PREFIX}${id}`);
    return raw === undefined ? undefined : (JSON.parse(raw) as OtpChallenge);
  }

  async delete(id: string): Promise<void> {
    const challenge = await this.get(id);
    await this.kv.delete(`${CHALLENGE_PREFIX}${id}`);
    if (challenge) {
      // Only clear the phone index when it still points at this challenge.
      const current = await this.kv.get(`${PHONE_PREFIX}${challenge.phone}`);
      if (current === id) {
        await this.kv.delete(`${PHONE_PREFIX}${challenge.phone}`);
      }
    }
  }

  async consume(id: string): Promise<OtpChallenge | undefined> {
    const raw = await this.kv.getdel(`${CHALLENGE_PREFIX}${id}`);
    if (raw === undefined) {
      return undefined;
    }
    const challenge = JSON.parse(raw) as OtpChallenge;
    const current = await this.kv.get(`${PHONE_PREFIX}${challenge.phone}`);
    if (current === id) {
      await this.kv.delete(`${PHONE_PREFIX}${challenge.phone}`);
    }
    return challenge;
  }

  async invalidateForPhone(phone: string): Promise<void> {
    const id = await this.kv.get(`${PHONE_PREFIX}${phone}`);
    if (id !== undefined) {
      await this.kv.delete(`${CHALLENGE_PREFIX}${id}`);
      await this.kv.delete(`${PHONE_PREFIX}${phone}`);
    }
  }

  async phoneFailureCount(phone: string): Promise<number> {
    const raw = await this.kv.get(`${PHONE_FAILURE_PREFIX}${phone}`);
    const count = raw === undefined ? 0 : Number.parseInt(raw, 10);
    return Number.isNaN(count) ? 0 : count;
  }

  async registerPhoneFailure(phone: string, windowMs: number): Promise<number> {
    return this.kv.incr(`${PHONE_FAILURE_PREFIX}${phone}`, windowMs);
  }
}
