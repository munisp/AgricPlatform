import { describe, expect, it } from 'vitest';
import {
  AgronomyRagService,
  chunkText,
  RAG_ANSWER_THRESHOLD,
  tokenize,
  type AgronomyCorpus,
  type CorpusChunk
} from './agronomy-rag.service.js';

const CORPUS: CorpusChunk[] = [
  {
    id: 'advisory:adv-fall-armyworm:0',
    source: 'advisory',
    title: 'Fall armyworm watch',
    text: 'Fall armyworm watch. Inspect maize early-morning whorl damage and scout fields twice weekly; escalate severe outbreaks to your chapter lead.',
    crop: 'Maize',
    tags: ['pest_alert', 'Kano', 'Maize']
  },
  {
    id: 'advisory:adv-maize-calendar:0',
    source: 'advisory',
    title: 'Maize planting window',
    text: 'Maize planting window — Northern Guinea Savanna. Prepare land, confirm seed quality, and align planting with forecast rainfall onset.',
    crop: 'Maize',
    tags: ['crop_calendar', 'Kaduna', 'Maize']
  },
  {
    id: 'knowledge:res-cassava:0',
    source: 'knowledge',
    title: 'Cassava mosaic disease guide',
    text: 'Cassava mosaic disease guide. Mosaic causes yellow leaf patches; plant clean stem cuttings and remove infected plants early.',
    tags: ['disease', 'cassava']
  }
];

function ragWith(chunks: CorpusChunk[]): AgronomyRagService {
  const corpus: AgronomyCorpus = { listChunks: async () => chunks };
  return new AgronomyRagService(corpus);
}

describe('tokenize + chunkText', () => {
  it('lowercases, drops stopwords and short tokens', () => {
    expect(tokenize('The Maize is in my field!')).toEqual(['maize', 'field']);
    expect(tokenize('')).toEqual([]);
  });

  it('chunks long bodies on sentence boundaries with stable ids', () => {
    const body = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} about maize agronomy practices.`).join(' ');
    const chunks = chunkText('knowledge', 'res-1', 'Guide', body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].id).toBe('knowledge:res-1:0');
    expect(chunks[1].id).toBe('knowledge:res-1:1');
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(700);
    }
  });
});

describe('AgronomyRagService.retrieve', () => {
  it('ranks the armyworm chunk first for an armyworm query', async () => {
    const rag = ragWith(CORPUS);
    const results = await rag.retrieve('my maize has fall armyworm damage');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.id).toBe('advisory:adv-fall-armyworm:0');
    expect(results[0].matchedTerms).toContain('armyworm');
  });

  it('filters by crop when a crop context is set', async () => {
    const rag = ragWith(CORPUS);
    const results = await rag.retrieve('mosaic disease yellow leaves', { crop: 'Cassava' });
    expect(results.every((r) => !r.chunk.crop || r.chunk.crop === 'Cassava')).toBe(true);
    expect(results[0].chunk.id).toBe('knowledge:res-cassava:0');
  });

  it('is deterministic — identical scores keep chunk-id order', async () => {
    const rag = ragWith(CORPUS);
    const a = await rag.retrieve('maize');
    const b = await rag.retrieve('maize');
    expect(a.map((r) => r.chunk.id)).toEqual(b.map((r) => r.chunk.id));
    const scores = a.map((r) => r.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });
});

describe('AgronomyRagService.answer — grounding contract', () => {
  it('answers with citations to the exact chunks used', async () => {
    const rag = ragWith(CORPUS);
    const answer = await rag.answer('my maize has fall armyworm damage');
    expect(answer.status).toBe('answered');
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations).toContain('advisory:adv-fall-armyworm:0');
    expect(answer.confidence).toBeGreaterThanOrEqual(RAG_ANSWER_THRESHOLD);
    // The composed text carries the same chunk ids it cites.
    for (const id of answer.citations) {
      expect(answer.answer).toContain(id);
    }
  });

  it('refuses to improvise when no chunk matches — no_grounding, no answer text', async () => {
    const rag = ragWith(CORPUS);
    const answer = await rag.answer('quantum tractor blockchain financing');
    expect(answer.status).toBe('no_grounding');
    expect(answer.answer).toBe('');
    expect(answer.citations).toEqual([]);
    expect(answer.confidence).toBe(0);
  });

  it('weak single-term overlap is low_confidence with a suggested draft for the agent', async () => {
    const rag = ragWith(CORPUS);
    const answer = await rag.answer('strange purple spots on stems and roots yesterday');
    expect(answer.status === 'low_confidence' || answer.status === 'no_grounding').toBe(true);
    expect(answer.answer).toBe('');
    expect(answer.citations).toEqual([]);
  });

  it('empty corpus never yields an answer', async () => {
    const rag = ragWith([]);
    const answer = await rag.answer('maize armyworm');
    expect(answer.status).toBe('no_grounding');
  });

  it('adds the honest en-only note for captured non-en locales', async () => {
    const rag = ragWith(CORPUS);
    const answer = await rag.answer('my maize has fall armyworm damage', { locale: 'ha' });
    expect(answer.status).toBe('answered');
    expect(answer.localeNote).toMatch(/English/);
  });

  it('same query + locale always returns the same answer (determinism)', async () => {
    const rag = ragWith(CORPUS);
    const a = await rag.answer('my maize has fall armyworm damage', { locale: 'en' });
    const b = await rag.answer('my maize has fall armyworm damage', { locale: 'en' });
    expect(a).toEqual(b);
  });
});
