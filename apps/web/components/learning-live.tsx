'use client';

import { useState } from 'react';
import { seedCourses } from '@agric-platform/shared';
import type { Course } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  enrolInCourse,
  listCertificates,
  listCourses,
  listEnrolments,
  updateEnrolmentProgress
} from '@/lib/api/endpoints';
import { demoCertificates } from '@/lib/content';
import { useFormDraft } from '@/lib/drafts';
import { AutoBadge, Card, ProgressBar, StatusBadge } from '@/components/ui';
import { DraftRestoredNotice, Field, TextInput } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/courses,
// GET /api/v1/users/:id/enrolments and GET /api/v1/users/:id/certificates.
const FALLBACK_COURSES: Course[] = seedCourses;
const FALLBACK_CERTIFICATES = demoCertificates;

function courseTitle(courses: Course[], courseId: string): string {
  return courses.find((course) => course.id === courseId)?.title ?? courseId;
}

export function EnrolmentProgress() {
  const { userId, hydrated } = useAppState();
  const coursesQuery = useApiQuery(
    'courses:list',
    () => listCourses({ pageSize: 100 }).then((res) => res.data),
    { fallbackData: FALLBACK_COURSES, enabled: hydrated }
  );
  const enrolmentsQuery = useApiQuery(
    hydrated ? `enrolments:${userId}` : null,
    () => listEnrolments(userId).then((res) => res.data),
    { fallbackData: [], enabled: hydrated }
  );

  const progressMutation = useApiMutation<
    { enrolmentId: string; progressPercent: number },
    unknown
  >({
    mutationFn: ({ enrolmentId, progressPercent }) =>
      updateEnrolmentProgress(enrolmentId, progressPercent).then((res) => res.data),
    queue: {
      kind: 'learning.progress.updated',
      label: ({ progressPercent }) => `Learning progress: ${progressPercent}%`,
      method: 'PATCH',
      path: ({ enrolmentId }) => `/enrolments/${enrolmentId}/progress`,
      payload: ({ progressPercent }) => ({ progressPercent })
    },
    onSuccess: () => enrolmentsQuery.refresh(),
    onQueued: () => enrolmentsQuery.refresh()
  });

  return (
    <QueryState
      isLoading={enrolmentsQuery.isLoading}
      error={enrolmentsQuery.error}
      data={enrolmentsQuery.data}
      onRetry={enrolmentsQuery.refresh}
      empty={
        <p className="small muted">
          No enrolments yet — pick a course from the catalogue below to get started.
        </p>
      }
    >
      <div className="grid grid-3">
        {(enrolmentsQuery.data ?? []).map((enrolment) => (
          <Card
            key={enrolment.id}
            title={courseTitle(coursesQuery.data ?? FALLBACK_COURSES, enrolment.courseId)}
          >
            <div className="cluster" style={{ marginBottom: '0.6rem' }}>
              <AutoBadge value={enrolment.status} />
            </div>
            <ProgressBar value={enrolment.progressPercent} label="Progress" />
            {enrolment.status !== 'completed' ? (
              <div className="cluster" style={{ marginTop: '0.6rem', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={progressMutation.status === 'pending'}
                  onClick={() =>
                    void progressMutation.mutate({
                      enrolmentId: enrolment.id,
                      progressPercent: Math.min(100, enrolment.progressPercent + 15)
                    })
                  }
                >
                  Log +15% progress
                </button>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
      {progressMutation.status === 'error' ? <ApiErrorNotice error={progressMutation.error} /> : null}
    </QueryState>
  );
}

export function CourseCatalogue() {
  const { userId, hydrated } = useAppState();
  const coursesQuery = useApiQuery(
    'courses:list',
    () => listCourses({ pageSize: 100 }).then((res) => res.data),
    { fallbackData: FALLBACK_COURSES, enabled: hydrated }
  );
  const enrolmentsQuery = useApiQuery(
    hydrated ? `enrolments:${userId}` : null,
    () => listEnrolments(userId).then((res) => res.data),
    { fallbackData: [], enabled: hydrated }
  );

  const enrolMutation = useApiMutation<{ course: Course }, unknown>({
    mutationFn: ({ course }) => enrolInCourse(course.id, userId).then((res) => res.data),
    queue: {
      kind: 'learning.enrolment.created',
      label: ({ course }) => `Enrolment: ${course.title}`,
      method: 'POST',
      path: ({ course }) => `/courses/${course.id}/enrol`,
      payload: () => ({ userId })
    },
    onSuccess: () => enrolmentsQuery.refresh(),
    onQueued: () => enrolmentsQuery.refresh()
  });

  const enrolledIds = new Set((enrolmentsQuery.data ?? []).map((e) => e.courseId));

  return (
    <>
      {coursesQuery.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={coursesQuery.isLoading}
        error={coursesQuery.source === 'fallback' ? undefined : coursesQuery.error}
        data={coursesQuery.data}
        onRetry={coursesQuery.refresh}
      >
        <div className="grid grid-3">
          {(coursesQuery.data ?? []).map((course) => (
            <Card key={course.id} title={course.title}>
              <p className="small muted">
                {course.category} · {course.level} · {course.durationMinutes} minutes ·{' '}
                {course.enrolmentCount.toLocaleString('en-NG')} enrolled
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <span className="cluster">
                  <StatusBadge tone={course.offlineAvailable ? 'success' : 'neutral'}>
                    {course.offlineAvailable ? 'offline-ready' : 'online only'}
                  </StatusBadge>
                  <StatusBadge tone="info">{course.level}</StatusBadge>
                </span>
                {enrolledIds.has(course.id) ? (
                  <StatusBadge tone="success">Enrolled</StatusBadge>
                ) : (
                  <EnrolWithGoal
                    course={course}
                    pending={enrolMutation.status === 'pending'}
                    onConfirm={() => void enrolMutation.mutate({ course })}
                  />
                )}
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
      {enrolMutation.status === 'error' ? <ApiErrorNotice error={enrolMutation.error} /> : null}
    </>
  );
}

/**
 * Enrol action with an optional "learning goal" note. The note is a
 * keystroke-autosaved IndexedDB draft (Appendix F Phase-1) so an interrupted
 * enrolment never loses the typed goal; it clears on successful enrolment.
 */
function EnrolWithGoal({
  course,
  pending,
  onConfirm
}: {
  course: Course;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { draft, setDraft, restored, clearDraft } = useFormDraft<{ goal: string }>(
    `course-enrol-${course.id}`,
    { goal: '' },
    (value) => value.goal.trim() === ''
  );

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-primary btn-small"
        disabled={pending}
        onClick={() => setOpen(true)}
        aria-label={`Enrol in ${course.title}`}
      >
        Enrol
      </button>
    );
  }

  return (
    <div className="stack" style={{ width: '100%' }}>
      {restored ? <DraftRestoredNotice onDismiss={clearDraft} /> : null}
      <Field id={`goal-${course.id}`} label="Your goal for this course (optional)">
        <TextInput
          id={`goal-${course.id}`}
          value={draft.goal}
          onChange={(e) => setDraft({ goal: e.target.value })}
          placeholder="e.g. Learn dry-season irrigation"
        />
      </Field>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={pending}
          onClick={() => {
            clearDraft();
            onConfirm();
          }}
        >
          {pending ? 'Enrolling…' : 'Confirm enrolment'}
        </button>
      </div>
    </div>
  );
}

export function CertificateTable() {
  const { userId, hydrated } = useAppState();
  const coursesQuery = useApiQuery(
    'courses:list',
    () => listCourses({ pageSize: 100 }).then((res) => res.data),
    { fallbackData: FALLBACK_COURSES, enabled: hydrated }
  );
  const query = useApiQuery(
    hydrated ? `certificates:${userId}` : null,
    () => listCertificates(userId).then((res) => res.data),
    { fallbackData: FALLBACK_CERTIFICATES, enabled: hydrated }
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<p className="small muted">No certificates yet — complete a course to earn one.</p>}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Course</th>
                <th>Verification code</th>
                <th>Issued</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(query.data ?? []).map((cert) => (
                <tr key={cert.id}>
                  <td>{courseTitle(coursesQuery.data ?? FALLBACK_COURSES, cert.courseId)}</td>
                  <td>
                    <code>{cert.verificationCode}</code>
                  </td>
                  <td>{new Date(cert.issuedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                  <td>
                    <StatusBadge tone="success">verifiable</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </>
  );
}
