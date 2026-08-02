import { describe, expect, it } from 'vitest';
import { advisoryCriteriaSql } from '../../src/database/repositories/advisory.pg-repository.js';
import {
  chapterCriteriaSql,
  chapterEventCriteriaSql,
  eventRsvpCriteriaSql
} from '../../src/database/repositories/chapters.pg-repository.js';
import {
  forumTopicCriteriaSql,
  mentorRequestCriteriaSql,
  topicFlagCriteriaSql
} from '../../src/database/repositories/community.pg-repository.js';
import {
  certificateCriteriaSql,
  courseCriteriaSql,
  enrolmentCriteriaSql
} from '../../src/database/repositories/learning.pg-repository.js';
import {
  listingCriteriaSql,
  orderCriteriaSql,
  reviewCriteriaSql
} from '../../src/database/repositories/marketplace.pg-repository.js';
import {
  applicationCriteriaSql,
  opportunityCriteriaSql
} from '../../src/database/repositories/opportunities.pg-repository.js';
import {
  consentCriteriaSql,
  deletionRequestCriteriaSql
} from '../../src/database/repositories/privacy.pg-repository.js';
import { documentCriteriaSql } from '../../src/database/repositories/finance.pg-repository.js';
import { notificationCriteriaSql } from '../../src/database/repositories/notifications.pg-repository.js';
import { userCriteriaSql } from '../../src/database/repositories/user.pg-repository.js';
import { mapPgError } from '../../src/database/pg/pg-repository.base.js';
import { ConflictException, BadRequestException } from '@nestjs/common';

/**
 * Snapshot tests for the criteria → SQL builders (plan §9.3 task 13). Pure
 * functions — no DATABASE_URL required. Any change to a generated fragment
 * must be reviewed via the snapshot diff.
 */
describe('criteria SQL builders', () => {
  it('user criteria (roles EXISTS + ILIKE q)', () => {
    expect(userCriteriaSql({})).toMatchSnapshot();
    expect(userCriteriaSql({ role: 'farmer' })).toMatchSnapshot();
    expect(userCriteriaSql({ q: 'adamu' })).toMatchSnapshot();
    expect(userCriteriaSql({ role: 'buyer', q: 'aisha' })).toMatchSnapshot();
  });

  it('course criteria', () => {
    expect(courseCriteriaSql({})).toMatchSnapshot();
    expect(
      courseCriteriaSql({ category: 'agronomy', level: 'beginner', language: 'en', q: 'maize' })
    ).toMatchSnapshot();
  });

  it('enrolment + certificate criteria', () => {
    expect(enrolmentCriteriaSql({ userId: 'u1', status: 'completed' })).toMatchSnapshot();
    expect(certificateCriteriaSql({ verificationCode: 'NYFN-CERT-2026-0001' })).toMatchSnapshot();
  });

  it('community criteria', () => {
    expect(forumTopicCriteriaSql({ category: 'crops', state: 'Kano', q: 'maize' })).toMatchSnapshot();
    expect(mentorRequestCriteriaSql({ userId: 'u1', status: 'requested' })).toMatchSnapshot();
    expect(topicFlagCriteriaSql({ status: 'open' })).toMatchSnapshot();
  });

  it('opportunity criteria (array containment)', () => {
    expect(opportunityCriteriaSql({})).toMatchSnapshot();
    expect(
      opportunityCriteriaSql({ type: 'grant', state: 'Kano', valueChain: 'maize', active: true })
    ).toMatchSnapshot();
    expect(applicationCriteriaSql({ userId: 'u1', status: 'submitted' })).toMatchSnapshot();
  });

  it('chapter criteria', () => {
    expect(chapterCriteriaSql({ level: 'state', state: 'Kano' })).toMatchSnapshot();
    expect(chapterEventCriteriaSql({ chapterId: 'chapter-kano' })).toMatchSnapshot();
    expect(eventRsvpCriteriaSql({ eventId: 'e1', userId: 'u1' })).toMatchSnapshot();
  });

  it('advisory + marketplace criteria', () => {
    expect(advisoryCriteriaSql({ kind: 'price', state: 'Kano', crop: 'maize' })).toMatchSnapshot();
    expect(
      listingCriteriaSql({ kind: 'produce', state: 'Kano', crop: 'maize', active: true, q: 'maize' })
    ).toMatchSnapshot();
    expect(orderCriteriaSql({ buyerId: 'u1', status: 'confirmed' })).toMatchSnapshot();
    expect(reviewCriteriaSql({ orderId: 'o1' })).toMatchSnapshot();
  });

  it('privacy + finance + notification criteria', () => {
    expect(consentCriteriaSql({ userId: 'u1' })).toMatchSnapshot();
    expect(deletionRequestCriteriaSql({ userId: 'u1', status: 'pending' })).toMatchSnapshot();
    expect(documentCriteriaSql({ userId: 'u1', status: 'uploaded' })).toMatchSnapshot();
    expect(notificationCriteriaSql({ userId: 'u1', status: 'queued' })).toMatchSnapshot();
  });

  it('never interpolates user input into SQL text', () => {
    const malicious = `x' OR '1'='1`;
    const clause = listingCriteriaSql({ q: malicious });
    expect(clause.where).not.toContain(malicious);
    expect(clause.params).toEqual([`%${malicious}%`]);
  });
});

describe('mapPgError', () => {
  it('maps 23505 to ConflictException', () => {
    expect(() => mapPgError({ code: '23505' })).toThrowError(ConflictException);
  });
  it('maps 23503 to BadRequestException', () => {
    expect(() => mapPgError({ code: '23503' })).toThrowError(BadRequestException);
  });
  it('rethrows unknown errors untouched', () => {
    const error = new Error('connection lost');
    expect(() => mapPgError(error)).toThrowError(error);
  });
});
