import { Injectable } from '@nestjs/common';
import type { LanguageCode } from '@agric-platform/shared';
import type { AdvisoryService } from '../advisory/advisory.service.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import type { LearningService } from '../learning/learning.service.js';

/**
 * Agronomy RAG core (wave VOICE). Retrieval over the repo's own advisory /
 * knowledge / learning content — chunked in-process and scored with a
 * BM25-ish term-weighting in TypeScript. No vector DB, no external LLM:
 * answers are COMPOSED from retrieved chunks and must cite the chunk ids
 * they are grounded in. When no chunk clears the grounding threshold the
 * service refuses to improvise agronomy and reports `no_grounding` (or
 * `low_confidence` for weak matches) so the caller can safely fall back and
 * escalate to a human agronomist.
 *
 * Determinism: scoring uses only corpus statistics and the query; every
 * sort has a chunk-id tie-break, so the same query + corpus always yields
 * the same answer.
 */

/** One retrievable unit of the agronomy corpus. */
export interface CorpusChunk {
  /** Stable id: `${source}:${sourceRecordId}:${chunkIndex}`. */
  id: string;
  source: 'advisory' | 'knowledge' | 'learning';
  title: string;
  text: string;
  crop?: string;
  tags: string[];
}

/** Port the RAG service reads its corpus from (repository-backed). */
export interface AgronomyCorpus {
  listChunks(): Promise<CorpusChunk[]>;
}

export interface RetrievedChunk {
  chunk: CorpusChunk;
  score: number;
  /** Distinct query terms present in this chunk. */
  matchedTerms: string[];
}

export type RagAnswerStatus = 'answered' | 'low_confidence' | 'no_grounding';

export interface RagAnswer {
  status: RagAnswerStatus;
  /** Composed answer text; empty unless status === 'answered'. */
  answer: string;
  /** Chunk ids the answer is grounded in; empty unless answered. */
  citations: string[];
  /** Best-effort draft for the human agent (set when not answered). */
  suggestedAnswer?: string;
  /** 0-1 grounding confidence (matched-term share of the top chunk). */
  confidence: number;
  /** Honest locale note: non-en locales get en text + this note. */
  localeNote?: string;
}

/** Minimum matched-term share for an answer to be served as grounded. */
export const RAG_ANSWER_THRESHOLD = 0.5;
/** Maximum chunks cited in one answer. */
export const RAG_MAX_CITATIONS = 3;
/** Chunk target size for knowledge-resource bodies. */
const CHUNK_TARGET_CHARS = 600;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'what', 'when', 'how', 'why', 'which',
  'can', 'could', 'should', 'would', 'my', 'your', 'our', 'their', 'his',
  'her', 'its', 'you', 'your', 'about', 'into', 'onto', 'out', 'use', 'using'
]);

/**
 * Lowercases, strips punctuation, drops stopwords and tokens < 3 chars, then
 * applies a naive deterministic plural stem (trailing 's' on tokens > 3
 * chars) so menu labels like "pests" match corpus tags like "pest_alert".
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token));
}

function distinct(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

/** Splits a body into ≤target-char chunks on sentence boundaries. */
export function chunkText(
  source: CorpusChunk['source'],
  recordId: string,
  title: string,
  body: string,
  extra: { crop?: string; tags?: string[] } = {}
): CorpusChunk[] {
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences.length > 0 ? sentences : [body]) {
    if (current.length > 0 && current.length + sentence.length + 1 > CHUNK_TARGET_CHARS) {
      parts.push(current);
      current = sentence;
    } else {
      current = current.length > 0 ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    parts.push(title);
  }
  return parts.map((text, index) => ({
    id: `${source}:${recordId}:${index}`,
    source,
    title,
    text,
    ...(extra.crop ? { crop: extra.crop } : {}),
    tags: extra.tags ?? []
  }));
}

/**
 * Corpus adapter over the repo's learning/advisory content: advisory items
 * (advisory module), knowledge resources (knowledge module) and course
 * catalogue entries (learning module).
 */
export class RepositoryAgronomyCorpus implements AgronomyCorpus {
  constructor(
    private readonly advisory: AdvisoryService,
    private readonly knowledge: KnowledgeService,
    private readonly learning: LearningService
  ) {}

  async listChunks(): Promise<CorpusChunk[]> {
    const chunks: CorpusChunk[] = [];

    const advisories = await this.advisory.all();
    for (const item of advisories) {
      chunks.push(
        ...chunkText('advisory', item.id, item.title, `${item.title}. ${item.summary}`, {
          crop: item.crop,
          tags: [item.kind, item.state, item.crop].filter(
            (tag): tag is string => typeof tag === 'string' && tag.length > 0
          )
        })
      );
    }

    const resources = await this.knowledge.listResources({ page: 1, pageSize: 100 });
    for (const resource of resources.data) {
      chunks.push(
        ...chunkText('knowledge', resource.id, resource.title, `${resource.title}. ${resource.body}`, {
          tags: resource.tags ?? []
        })
      );
    }

    const courses = await this.learning.allCourses();
    for (const course of courses) {
      chunks.push(
        ...chunkText(
          'learning',
          course.id,
          course.title,
          `${course.title}. A ${course.level} ${course.category} course (${course.durationMinutes} minutes).`,
          { tags: [course.category, course.level] }
        )
      );
    }

    // Deterministic corpus order regardless of source ordering.
    return chunks.sort((a, b) => a.id.localeCompare(b.id));
  }
}

@Injectable()
export class AgronomyRagService {
  constructor(private readonly corpus: AgronomyCorpus) {}

  /**
   * BM25-ish scoring: idf = ln(1 + (N - df + 0.5) / (df + 0.5)),
   * tf saturation with k1 = 1.5, b = 0.75 against the corpus average
   * document length. Results are filtered to score > 0 and sorted by
   * (-score, chunk.id) for full determinism.
   */
  async retrieve(
    query: string,
    options: { crop?: string; limit?: number } = {}
  ): Promise<RetrievedChunk[]> {
    const queryTerms = distinct(tokenize(query));
    if (queryTerms.length === 0) {
      return [];
    }
    const corpus = await this.corpus.listChunks();
    if (corpus.length === 0) {
      return [];
    }

    const docTokens = new Map<string, string[]>();
    const docFreq = new Map<string, number>();
    let totalLength = 0;
    for (const chunk of corpus) {
      const tokens = tokenize(`${chunk.title} ${chunk.text} ${chunk.tags.join(' ')}`);
      docTokens.set(chunk.id, tokens);
      totalLength += tokens.length;
      for (const term of new Set(tokens)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    const avgLength = totalLength / corpus.length || 1;
    const k1 = 1.5;
    const b = 0.75;

    const scored: RetrievedChunk[] = [];
    for (const chunk of corpus) {
      const tokens = docTokens.get(chunk.id) ?? [];
      if (options.crop && chunk.crop && chunk.crop.toLowerCase() !== options.crop.toLowerCase()) {
        continue;
      }
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      let score = 0;
      const matched: string[] = [];
      for (const term of queryTerms) {
        const freq = tf.get(term) ?? 0;
        if (freq === 0) {
          continue;
        }
        matched.push(term);
        const df = docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5));
        score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * tokens.length) / avgLength)));
      }
      if (score > 0) {
        scored.push({ chunk, score, matchedTerms: matched.sort() });
      }
    }
    scored.sort(
      (a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)
    );
    return scored.slice(0, options.limit ?? RAG_MAX_CITATIONS);
  }

  /**
   * Grounded answer composition. The answer cites every chunk it uses; when
   * the top chunk does not clear RAG_ANSWER_THRESHOLD the service returns a
   * non-answered status (never improvised agronomy). `suggestedAnswer`
   * carries the best-effort draft for the human agent on weak matches.
   */
  async answer(
    query: string,
    options: { locale?: LanguageCode; crop?: string } = {}
  ): Promise<RagAnswer> {
    const queryTerms = distinct(tokenize(query));
    const localeNote =
      options.locale && options.locale !== 'en'
        ? 'This response is in English. Hausa, Yoruba and Igbo voice responses are pending professional translation.'
        : undefined;
    if (queryTerms.length === 0) {
      return {
        status: 'no_grounding',
        answer: '',
        citations: [],
        confidence: 0,
        ...(localeNote ? { localeNote } : {})
      };
    }

    const retrieved = await this.retrieve(query, { crop: options.crop });
    const top = retrieved[0];
    if (!top) {
      return {
        status: 'no_grounding',
        answer: '',
        citations: [],
        confidence: 0,
        ...(localeNote ? { localeNote } : {})
      };
    }

    const confidence =
      Math.round((top.matchedTerms.length / queryTerms.length) * 100) / 100;
    const used = retrieved.slice(0, RAG_MAX_CITATIONS);
    const draft = this.compose(used);

    if (confidence < RAG_ANSWER_THRESHOLD) {
      return {
        status: confidence > 0 ? 'low_confidence' : 'no_grounding',
        answer: '',
        citations: [],
        suggestedAnswer: draft.text,
        confidence,
        ...(localeNote ? { localeNote } : {})
      };
    }

    return {
      status: 'answered',
      answer: draft.text,
      // The answer cites exactly the chunks it was composed from.
      citations: used.map((entry) => entry.chunk.id).sort(),
      confidence,
      ...(localeNote ? { localeNote } : {})
    };
  }

  /** Deterministic composition from retrieved chunks (no generative text). */
  private compose(entries: RetrievedChunk[]): { text: string } {
    const lines = entries.map(
      (entry, index) => `${index + 1}) ${entry.chunk.title} — ${entry.chunk.text}`
    );
    const sources = entries.map((entry) => entry.chunk.id).sort();
    return {
      text:
        `Based on the AgricPlatform advisory library:\n${lines.join('\n')}\n` +
        `Sources: ${sources.join(', ')}.`
    };
  }
}
