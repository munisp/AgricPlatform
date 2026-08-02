'use client';

import { useCallback, useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { listChapterEvents, listChapters, scanEventAttendance } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/errors';
import { demoEvents } from '@/lib/content';
import { Field, Select, TextArea } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice } from '@/components/api-state';
import { QrCameraScanner, isCameraSupported } from '@/components/qr-scanner';

/**
 * Event check-in by attendance code. The member can scan the lead's QR with
 * the device camera or paste/type the code manually — the paste-in flow is
 * the automatic fallback when the camera is denied or unavailable.
 * Duplicate scans return 409 and are displayed gracefully as
 * "already checked in" instead of an error.
 */
export function AttendanceCheckIn() {
  const { userId } = useAppState();
  const [eventId, setEventId] = useState('');
  const [code, setCode] = useState('');
  const [cameraMode, setCameraMode] = useState(false);
  const [cameraIssue, setCameraIssue] = useState<string | null>(null);

  const eventsQuery = useApiQuery(
    'check-in:events',
    async () => {
      const chapters = await listChapters({ pageSize: 5 }).then((res) => res.data);
      const batches = await Promise.all(
        chapters.slice(0, 3).map((chapter) => listChapterEvents(chapter.id).then((res) => res.data))
      );
      return batches.flat();
    },
    { fallbackData: demoEvents }
  );
  const events = eventsQuery.data ?? demoEvents;
  const selectedEventId = eventId || events[0]?.id || '';

  const mutation = useApiMutation<{ code: string }, unknown>({
    mutationFn: ({ code: scanned }) =>
      scanEventAttendance(selectedEventId, { code: scanned.trim() }).then((res) => res.data),
    onSuccess: () => setCode('')
  });

  const isDuplicate =
    mutation.status === 'error' &&
    mutation.error instanceof ApiError &&
    mutation.error.statusCode === 409;

  // Camera callbacks are stable so the scanner effect doesn't restart
  // (useApiMutation's mutate is referentially stable via useCallback).
  const { mutate } = mutation;
  const handleScan = useCallback(
    (value: string) => {
      const scanned = value.trim();
      setCode(scanned);
      setCameraMode(false);
      if (selectedEventId && scanned.length >= 10) {
        void mutate({ code: scanned });
      }
    },
    [selectedEventId, mutate]
  );
  const handleCameraUnavailable = useCallback((reason: string) => {
    setCameraIssue(reason);
    setCameraMode(false);
  }, []);

  return (
    <div className="card">
      <h3>Check in to an event</h3>
      <p className="small muted">
        Ask the event lead to show the attendance QR, then scan it with your camera or paste the
        code here.
      </p>
      {eventsQuery.source === 'fallback' ? <OfflineDataNotice /> : null}
      <div className="form-grid cols-2">
        <Field id="ci-event" label="Event">
          <Select id="ci-event" value={selectedEventId} onChange={(e) => setEventId(e.target.value)}>
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="ci-code" label="Attendance code" hint="The long code starting with v1.">
          <TextArea
            id="ci-code"
            value={code}
            rows={2}
            onChange={(e) => setCode(e.target.value)}
            placeholder="v1.event-…"
            autoComplete="off"
          />
        </Field>
      </div>

      {isCameraSupported() || cameraIssue ? (
        <div className="cluster" style={{ justifyContent: 'space-between' }}>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={!selectedEventId || mutation.status === 'pending'}
            aria-pressed={cameraMode}
            onClick={() => {
              setCameraIssue(null);
              setCameraMode((mode) => !mode);
            }}
          >
            {cameraMode ? 'Stop camera' : 'Scan with camera'}
          </button>
        </div>
      ) : null}
      {cameraMode ? (
        <QrCameraScanner onScan={handleScan} onUnavailable={handleCameraUnavailable} />
      ) : null}
      {cameraIssue ? (
        <p className="notice notice-info" role="status" data-testid="camera-fallback">
          <strong>Camera unavailable.</strong> {cameraIssue} You can still paste the code below.
        </p>
      ) : null}

      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!selectedEventId || code.trim().length < 10 || mutation.status === 'pending'}
          onClick={() => void mutation.mutate({ code })}
        >
          {mutation.status === 'pending' ? 'Checking in…' : 'Check in'}
        </button>
      </div>

      {mutation.status === 'success' ? (
        <div className="notice notice-success" role="status">
          <strong>You are checked in.</strong> Attendance recorded for {userId}.
        </div>
      ) : null}
      {isDuplicate ? (
        <div className="notice notice-info" role="status" data-testid="duplicate-scan">
          <strong>Already checked in.</strong> Your attendance for this event was recorded earlier —
          no need to scan again.
        </div>
      ) : null}
      {mutation.status === 'error' && !isDuplicate ? (
        <ApiErrorNotice error={mutation.error} />
      ) : null}
    </div>
  );
}
