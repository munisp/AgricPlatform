import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { newId } from '../../common/async-repository.js';
import {
  API_KEY_REPOSITORY,
  PARTNER_CLIENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ApiKeyRepository,
  DeveloperApiKey,
  PartnerClient,
  PartnerClientRepository
} from '../../database/repositories/partner-api.repository.js';
import { loadPartnerApiConfig, type PartnerApiConfig } from './partner-api.config.js';

/** Audience claim for partner access tokens (separates them from OIDC user tokens). */
export const PARTNER_TOKEN_AUDIENCE = 'partner';

export interface PartnerTokenIdentity {
  clientId: string;
  scopes: string[];
  sandbox: boolean;
}

export interface IssuedPartnerToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
  sandbox: boolean;
}

/** sha256(salt + secret) — secrets are never stored or logged in plaintext. */
export function hashSecret(salt: string, secret: string): string {
  return createHash('sha256').update(`${salt}:${secret}`).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Partner client-credentials authentication (wave P5d). Issues short-lived
 * HS256 JWTs (audience `partner`, scope claims) via the existing jose
 * dependency; secrets are verified against salted sha256 hashes at rest.
 */
@Injectable()
export class PartnerAuthService {
  private readonly config: PartnerApiConfig;
  private readonly key: Uint8Array;

  constructor(
    @Inject(PARTNER_CLIENT_REPOSITORY) private readonly clients: PartnerClientRepository,
    @Inject(API_KEY_REPOSITORY) private readonly apiKeys: ApiKeyRepository
  ) {
    this.config = loadPartnerApiConfig();
    this.key = new TextEncoder().encode(this.config.signingSecret);
  }

  get sandbox(): boolean {
    return this.config.sandbox;
  }

  /** Registers a partner client; returns the plaintext secret exactly once. */
  async registerClient(input: {
    name: string;
    scopes: string[];
    rateLimitPerMin?: number;
  }): Promise<{ client: PartnerClient; clientSecret: string }> {
    const clientSecret = `pcs_${randomBytes(24).toString('base64url')}`;
    const salt = randomBytes(16).toString('hex');
    const client = await this.clients.create({
      id: newId('pclient'),
      name: input.name,
      clientId: `pc_${randomBytes(9).toString('hex')}`,
      clientSecretHash: hashSecret(salt, clientSecret),
      clientSecretSalt: salt,
      scopes: input.scopes,
      status: 'active',
      rateLimitPerMin: input.rateLimitPerMin ?? 1000,
      createdAt: new Date().toISOString()
    });
    return { client, clientSecret };
  }

  /** Client-credentials grant: verifies the secret hash and issues a scoped JWT. */
  async issueToken(clientId: string, clientSecret: string): Promise<IssuedPartnerToken> {
    const client = await this.clients.findOne({ clientId });
    if (!client || client.status !== 'active') {
      throw new UnauthorizedException('Invalid client credentials');
    }
    const candidate = hashSecret(client.clientSecretSalt, clientSecret);
    if (!safeEqualHex(candidate, client.clientSecretHash)) {
      throw new UnauthorizedException('Invalid client credentials');
    }
    const accessToken = await new SignJWT({
      scope: client.scopes.join(' '),
      sandbox: this.config.sandbox
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(client.clientId)
      .setAudience(PARTNER_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.tokenTtlSeconds}s`)
      .sign(this.key);
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.tokenTtlSeconds,
      scope: client.scopes.join(' '),
      sandbox: this.config.sandbox
    };
  }

  /** Verifies a partner access token and returns the client identity. */
  async verifyToken(token: string): Promise<PartnerTokenIdentity> {
    const { payload } = await jwtVerify(token, this.key, {
      audience: PARTNER_TOKEN_AUDIENCE
    });
    if (!payload.sub) {
      throw new Error('Partner token is missing the sub claim');
    }
    return {
      clientId: payload.sub,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      sandbox: payload.sandbox === true
    };
  }

  /**
   * Issues a developer API key (developer portal sandbox flow). The
   * plaintext key is returned exactly once; only the salted hash persists.
   */
  async issueApiKey(input: {
    ownerUserId: string;
    scopes: string[];
  }): Promise<{ apiKey: DeveloperApiKey; plaintext: string }> {
    const plaintext = `ak_${this.config.sandbox ? 'sandbox_' : 'live_'}${randomBytes(24).toString('base64url')}`;
    const salt = randomBytes(16).toString('hex');
    const apiKey = await this.apiKeys.create({
      id: newId('apikey'),
      ownerUserId: input.ownerUserId,
      keyHash: hashSecret(salt, plaintext),
      keySalt: salt,
      prefix: plaintext.slice(0, 12),
      scopes: input.scopes,
      sandbox: this.config.sandbox,
      createdAt: new Date().toISOString()
    });
    return { apiKey, plaintext };
  }

  /** Verifies a developer API key presented as `x-api-key`. */
  async verifyApiKey(plaintext: string): Promise<DeveloperApiKey | undefined> {
    const prefix = plaintext.slice(0, 12);
    const candidates = await this.apiKeys.find({ prefix });
    for (const candidate of candidates) {
      if (candidate.revokedAt) continue;
      if (safeEqualHex(hashSecret(candidate.keySalt, plaintext), candidate.keyHash)) {
        return candidate;
      }
    }
    return undefined;
  }

  async apiKeysFor(ownerUserId: string): Promise<DeveloperApiKey[]> {
    return this.apiKeys.find({ ownerUserId });
  }

  async revokeApiKey(id: string, ownerUserId: string): Promise<DeveloperApiKey> {
    const key = await this.apiKeys.getById(id);
    if (key.ownerUserId !== ownerUserId) {
      throw new UnauthorizedException('API key belongs to a different owner');
    }
    return this.apiKeys.update(id, { revokedAt: new Date().toISOString() });
  }
}
