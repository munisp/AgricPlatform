import { Global, Logger, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { resolveCacheMode } from '../config/persistence.config.js';
import {
  IDEMPOTENCY_STORE,
  KEY_VALUE_STORE,
  OTP_STORE,
  REDIS_CLIENT
} from '../database/persistence.tokens.js';
import { KeyValueIdempotencyStore, type IdempotencyStore } from './idempotency.store.js';
import { InMemoryKeyValueStore, RedisKeyValueStore, type KeyValueStore } from './key-value-store.js';
import { KeyValueOtpChallengeStore, type OtpChallengeStore } from './otp-challenge.store.js';

const logger = new Logger('RedisModule');

/**
 * Cache infrastructure (plan §7). REDIS_URL selects the Redis backend;
 * otherwise an in-memory store preserves Phase 1 semantics with a startup
 * warning. Production fails closed in resolveCacheMode unless the operator
 * opts into in-memory cache explicitly.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis | null => {
        if (resolveCacheMode() !== 'redis') {
          logger.warn(
            'REDIS_URL not set — using in-memory idempotency/OTP stores (single-instance only).'
          );
          return null;
        }
        return new Redis(process.env.REDIS_URL as string, {
          lazyConnect: true,
          maxRetriesPerRequest: 2
        });
      }
    },
    {
      provide: KEY_VALUE_STORE,
      useFactory: (redis: Redis | null): KeyValueStore =>
        redis ? new RedisKeyValueStore(redis) : new InMemoryKeyValueStore(),
      inject: [REDIS_CLIENT]
    },
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (kv: KeyValueStore): IdempotencyStore => new KeyValueIdempotencyStore(kv),
      inject: [KEY_VALUE_STORE]
    },
    {
      provide: OTP_STORE,
      useFactory: (kv: KeyValueStore): OtpChallengeStore => new KeyValueOtpChallengeStore(kv),
      inject: [KEY_VALUE_STORE]
    }
  ],
  exports: [REDIS_CLIENT, KEY_VALUE_STORE, IDEMPOTENCY_STORE, OTP_STORE]
})
export class RedisModule {}
