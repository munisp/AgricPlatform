import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createInMemoryApiKeyRepository,
  createInMemoryPartnerClientRepository
} from '../../database/repositories/partner-api.repository.js';
import { hashSecret, PartnerAuthService } from './partner-auth.service.js';

describe('PartnerAuthService', () => {
  let service: PartnerAuthService;

  beforeEach(() => {
    process.env.PARTNER_API_DRIVER = 'sandbox';
    delete process.env.PARTNER_API_SIGNING_SECRET;
    service = new PartnerAuthService(
      createInMemoryPartnerClientRepository(),
      createInMemoryApiKeyRepository()
    );
  });

  it('issues and verifies a client-credentials token with scope claims', async () => {
    const { client, clientSecret } = await service.registerClient({
      name: 'DFI Partner',
      scopes: ['impact:read', 'programmes:read']
    });
    const issued = await service.issueToken(client.clientId, clientSecret);
    expect(issued.tokenType).toBe('Bearer');
    expect(issued.expiresIn).toBeGreaterThan(0);
    expect(issued.sandbox).toBe(true);

    const identity = await service.verifyToken(issued.accessToken);
    expect(identity.clientId).toBe(client.clientId);
    expect(identity.scopes).toEqual(['impact:read', 'programmes:read']);
    expect(identity.sandbox).toBe(true);
  });

  it('rejects a bad client secret with 401', async () => {
    const { client } = await service.registerClient({ name: 'X', scopes: [] });
    await expect(service.issueToken(client.clientId, 'wrong-secret')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('rejects an unknown client id with 401', async () => {
    await expect(service.issueToken('pc_missing', 'whatever')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('rejects tampered tokens on verify', async () => {
    const { client, clientSecret } = await service.registerClient({ name: 'Y', scopes: ['a'] });
    const issued = await service.issueToken(client.clientId, clientSecret);
    const tampered = `${issued.accessToken.slice(0, -2)}xx`;
    await expect(service.verifyToken(tampered)).rejects.toThrow();
  });

  it('stores client secrets only as salted hashes', async () => {
    const { client, clientSecret } = await service.registerClient({ name: 'Z', scopes: [] });
    expect(client.clientSecretHash).not.toContain(clientSecret);
    expect(client.clientSecretHash).toBe(hashSecret(client.clientSecretSalt, clientSecret));
  });

  it('issues, verifies and revokes developer API keys (shown once)', async () => {
    const { apiKey, plaintext } = await service.issueApiKey({
      ownerUserId: 'user-1',
      scopes: ['profile:read']
    });
    expect(plaintext.startsWith('ak_sandbox_')).toBe(true);
    expect(apiKey.keyHash).not.toContain(plaintext);

    const verified = await service.verifyApiKey(plaintext);
    expect(verified?.id).toBe(apiKey.id);
    expect(verified?.scopes).toEqual(['profile:read']);

    await service.revokeApiKey(apiKey.id, 'user-1');
    expect(await service.verifyApiKey(plaintext)).toBeUndefined();
  });

  it('rejects revoked keys and unknown keys', async () => {
    expect(await service.verifyApiKey('ak_sandbox_nonexistent')).toBeUndefined();
  });

  it('lists keys for an owner only', async () => {
    await service.issueApiKey({ ownerUserId: 'user-1', scopes: [] });
    await service.issueApiKey({ ownerUserId: 'user-2', scopes: [] });
    expect(await service.apiKeysFor('user-1')).toHaveLength(1);
  });

  it('refuses to revoke a key owned by someone else', async () => {
    const { apiKey } = await service.issueApiKey({ ownerUserId: 'user-1', scopes: [] });
    await expect(service.revokeApiKey(apiKey.id, 'user-2')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});
