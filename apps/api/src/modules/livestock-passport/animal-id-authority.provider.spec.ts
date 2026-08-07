import { describe, expect, it } from 'vitest';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  createAnimalIdAuthorityProvider,
  HttpAnimalIdAuthorityProvider,
  StubAnimalIdAuthorityProvider,
  type TagCheckInput
} from './animal-id-authority.provider.js';

const INPUT: TagCheckInput = {
  animalId: 'NG-BOV-KD-000123',
  species: 'cattle',
  state: 'Kaduna',
  tagId: 'TAG-KD-0412'
};

describe('StubAnimalIdAuthorityProvider (default, honest labelling)', () => {
  const stub = new StubAnimalIdAuthorityProvider();

  it('is deterministic per tag', async () => {
    const first = await stub.checkTag(INPUT);
    const second = await stub.checkTag(INPUT);
    expect(second).toEqual(first);
  });

  it('labels every verdict basis:stub with a STUB-prefixed reference', async () => {
    const result = await stub.checkTag(INPUT);
    expect(result.basis).toBe('stub');
    expect(result.registryReference).toMatch(/^STUB-NAIS-/);
    expect(result.detail).toContain('STUB');
  });

  it('varies the verdict across tags so both paths exist', async () => {
    const verdicts = new Set<boolean>();
    for (let i = 0; i < 20; i += 1) {
      const result = await stub.checkTag({ ...INPUT, tagId: `TAG-${i}` });
      verdicts.add(result.registered);
    }
    expect(verdicts).toEqual(new Set([true, false]));
  });

  it('falls back to the eid, then the animal id, as the check subject', async () => {
    const byEid = await stub.checkTag({ ...INPUT, tagId: undefined, eid: 'EID-99' });
    const byAnimal = await stub.checkTag({ ...INPUT, tagId: undefined, eid: undefined });
    expect(byEid.detail).toContain('EID-99');
    expect(byAnimal.detail).toContain(INPUT.animalId);
  });

  it('reports an honest stub status', async () => {
    const status = await stub.status();
    expect(status.healthy).toBe(true);
    expect(status.detail).toContain('Stub provider');
  });
});

describe('createAnimalIdAuthorityProvider — fail-closed factory', () => {
  it('defaults to the stub when nothing is configured', () => {
    expect(createAnimalIdAuthorityProvider({}).name).toBe('stub');
    expect(createAnimalIdAuthorityProvider({ ANIMAL_ID_AUTHORITY_MODE: 'stub' }).name).toBe('stub');
  });

  it('throws at boot when the URL is set without the API key', () => {
    expect(() =>
      createAnimalIdAuthorityProvider({ ANIMAL_ID_AUTHORITY_URL: 'https://nais.example.gov.ng' })
    ).toThrow(ProviderConfigError);
  });

  it('throws at boot when MODE=live lacks the URL and key', () => {
    expect(() => createAnimalIdAuthorityProvider({ ANIMAL_ID_AUTHORITY_MODE: 'live' })).toThrow(
      ProviderConfigError
    );
    expect(() =>
      createAnimalIdAuthorityProvider({
        ANIMAL_ID_AUTHORITY_MODE: 'live',
        ANIMAL_ID_AUTHORITY_URL: 'https://nais.example.gov.ng'
      })
    ).toThrow(ProviderConfigError);
  });

  it('rejects an unknown mode (typo guard — never silently stub)', () => {
    expect(() => createAnimalIdAuthorityProvider({ ANIMAL_ID_AUTHORITY_MODE: 'liv' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds the http driver only with full configuration', () => {
    const provider = createAnimalIdAuthorityProvider({
      ANIMAL_ID_AUTHORITY_MODE: 'live',
      ANIMAL_ID_AUTHORITY_URL: 'https://nais.example.gov.ng/',
      ANIMAL_ID_AUTHORITY_API_KEY: 'key-123'
    });
    expect(provider).toBeInstanceOf(HttpAnimalIdAuthorityProvider);
    expect(provider.name).toBe('http');
  });

  it('reports unhealthy (never stub-substituted) when the live authority is unreachable', async () => {
    const provider = new HttpAnimalIdAuthorityProvider('http://127.0.0.1:1', 'key-123');
    const status = await provider.status();
    expect(status.configured).toBe(true);
    expect(status.healthy).toBe(false);
  });

  it('fails closed (throws) when a live checkTag cannot reach the authority', async () => {
    const provider = new HttpAnimalIdAuthorityProvider('http://127.0.0.1:1', 'key-123');
    await expect(provider.checkTag(INPUT)).rejects.toThrow();
  });
});
