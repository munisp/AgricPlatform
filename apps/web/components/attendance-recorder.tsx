'use client';

import { useMemo, useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import { listChapterEvents, listChapters, recordAttendance } from '@/lib/api/endpoints';
import { NetworkError, TimeoutError } from '@/lib/api/errors';
import { usePersistentState } from '@/lib/use-persistent-state';
import { demoEvents, demoRoster } from '@/lib/content';
import { QueuedNotice, Select, Field } from '@/components/forms';
import { ApiErrorNotice } from '@/components/api-state';

export function AttendanceRecorder() {
  const { enqueue } = useAppState();
  // Events come from the API; demo events are the offline placeholder.
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
  const events = eventsQuery.data ?? demoEvents;

  const [eventId, setEventId] = useState('');
  const selectedEventId = eventId || events[0]?.id || '';
  const [records, setRecords] = usePersistentState<Record<string, string[]>>('agric.attendance', {});
  const [notice, setNotice] = useState<{ title: string; queued: boolean } | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [saving, setSaving] = useState(false);

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
      const member = demoRoster.find((m) => m.id === memberId);
      enqueue({
        kind: 'chapter.event.attendance_recorded',
        label: `Attendance: ${member?.name ?? memberId} at "${event.title}"`,
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

      <ul className="row-list" aria-label="Attendance roster">
        {demoRoster.map((member) => {
          const isPresent = present.includes(member.id);
          return (
            <li className="row-item" key={member.id}>
              <span className="avatar-dot" aria-hidden="true">
                {member.name
                  .split(' ')
                  .map((part) => part[0])
                  .join('')}
              </span>
              <div className="row-main">
                <div className="row-title">{member.name}</div>
                <div className="small muted">{member.state} chapter</div>
              </div>
              <button
                type="button"
                className="chip"
                aria-pressed={isPresent}
                onClick={() => toggle(member.id)}
              >
                {isPresent ? 'Present' : 'Mark present'}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span className="small muted" role="status">
          {present.length} of {demoRoster.length} marked present
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
