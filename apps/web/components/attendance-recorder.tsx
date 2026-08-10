'use client';

import { useMemo, useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import {
  listChapterEvents,
  listChapters,
  listEventRoster,
  recordAttendance,
  type EventRosterEntry
} from '@/lib/api/endpoints';
import { NetworkError, TimeoutError } from '@/lib/api/errors';
import { usePersistentState } from '@/lib/use-persistent-state';
import { demoEvents, demoRoster } from '@/lib/content';
import { QueuedNotice, Select, Field } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice } from '@/components/api-state';

// Offline fallbacks only — the real roster comes from GET /events/:id/roster
// (RSVP list). Rendered only behind source === 'fallback' + OfflineDataNotice.
const FALLBACK_ROSTER: EventRosterEntry[] = demoRoster.map((member) => ({
  userId: member.id,
  fullName: `${member.name} (demo)`,
  status: 'rsvp'
}));

export function AttendanceRecorder() {
  const { enqueue } = useAppState();
  // Events come from the API; demo events are the labelled offline fallback.
  const eventsQuery = useApiQuery(
    'attendance:events',
    async () => {
      const chapters = await listChapters({ pageSize: 5 }).then((res) => res.data);
      const batches = await Promise.all(
        chapters.slice(0, 3).map((chapter) => listChapterEvents(chapter.id).then((res) => res.data))
      );
      return batches.flat();
    },
    { fallbackData: demoEvents }
  );
  // Demo events appear only via `eventsQuery.data` after an actual failure
  // (source === 'fallback'), never during the load window.
  const events = eventsQuery.data ?? [];

  const [eventId, setEventId] = useState('');
  const selectedEventId = eventId || events[0]?.id || '';
  const [records, setRecords] = usePersistentState<Record<string, string[]>>('agric.attendance', {});
  const [notice, setNotice] = useState<{ title: string; queued: boolean } | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [saving, setSaving] = useState(false);

  // Real roster: members who RSVPed to the selected event (chapter leads /
  // admins). The demo roster appears only when the API is unreachable, and is
  // clearly labelled via OfflineDataNotice.
  const rosterQuery = useApiQuery(
    selectedEventId ? `attendance:roster:${selectedEventId}` : null,
    () => listEventRoster(selectedEventId).then((res) => res.data),
    { fallbackData: FALLBACK_ROSTER, enabled: Boolean(selectedEventId) }
  );
  // The "(demo)" fallback roster arrives via `rosterQuery.data` on failure
  // only — an empty roster during load, never fabricated names.
  const roster = rosterQuery.data ?? [];

  const present = useMemo(() => records[selectedEventId] ?? [], [records, selectedEventId]);
  const event = events.find((item) => item.id === selectedEventId);

  const toggle = (memberId: string) => {
    setRecords((current) => {
      const list = current[selectedEventId] ?? [];
      const next = list.includes(memberId)
        ? list.filter((id) => id !== memberId)
        : [...list, memberId];
      return { ...current, [selectedEventId]: next };
    });
    setNotice(null);
    setError(undefined);
  };

  const queueAll = () => {
    if (!event) return;
    for (const memberId of present) {
      const member = roster.find((m) => m.userId === memberId);
      enqueue({
        kind: 'chapter.event.attendance_recorded',
        label: `Attendance: ${member?.fullName ?? memberId} at "${event.title}"`,
        method: 'POST',
        path: `/events/${event.id}/attendance`,
        payload: { userId: memberId }
      });
    }
    setNotice({ title: event.title, queued: true });
  };

  const save = async () => {
    if (!event) return;
    setSaving(true);
    setError(undefined);
    try {
      await Promise.all(present.map((memberId) => recordAttendance(event.id, memberId)));
      setNotice({ title: event.title, queued: false });
    } catch (err) {
      if (err instanceof NetworkError || err instanceof TimeoutError) {
        queueAll();
      } else {
        // e.g. 403 — attendance capture is restricted to chapter leads/admin.
        setError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <Field id="att-event" label="Chapter event">
        <Select id="att-event" value={selectedEventId} onChange={(e) => setEventId(e.target.value)}>
          {events.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
      </Field>
      {eventsQuery.source === 'fallback' ? (
        <OfflineDataNotice>Live events unavailable — showing reference events.</OfflineDataNotice>
      ) : null}
      {rosterQuery.source === 'fallback' ? (
        <OfflineDataNotice>Live roster unavailable — showing reference members.</OfflineDataNotice>
      ) : null}

      <ul className="row-list" aria-label="Attendance roster">
        {roster.map((member) => {
          const isPresent = present.includes(member.userId);
          return (
            <li className="row-item" key={member.userId}>
              <span className="avatar-dot" aria-hidden="true">
                {member.fullName
                  .split(' ')
                  .map((part) => part[0])
                  .join('')}
              </span>
              <div className="row-main">
                <div className="row-title">{member.fullName}</div>
                <div className="small muted">
                  {member.status === 'attended' ? 'Already checked in' : 'RSVP confirmed'}
                </div>
              </div>
              <button
                type="button"
                className="chip"
                aria-pressed={isPresent}
                onClick={() => toggle(member.userId)}
              >
                {isPresent ? 'Present' : 'Mark present'}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span className="small muted" role="status">
          {present.length} of {roster.length} marked present
        </span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={!event || saving}
        >
          {saving ? 'Saving…' : 'Save attendance'}
        </button>
      </div>

      {notice?.queued ? <QueuedNotice label={`Attendance for "${notice.title}"`} /> : null}
      {notice && !notice.queued ? (
        <div className="notice notice-success" role="status">
          <strong>Attendance saved.</strong> {present.length} present at &quot;{notice.title}&quot;.
        </div>
      ) : null}
      {error ? <ApiErrorNotice error={error} /> : null}
    </div>
  );
}
