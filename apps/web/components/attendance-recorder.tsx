'use client';

import { useMemo, useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { usePersistentState } from '@/lib/use-persistent-state';
import { demoEvents, demoRoster } from '@/lib/content';
import { QueuedNotice, Select, Field } from '@/components/forms';

export function AttendanceRecorder() {
  const { enqueue } = useAppState();
  const [eventId, setEventId] = useState(demoEvents[0]?.id ?? '');
  const [records, setRecords] = usePersistentState<Record<string, string[]>>('agric.attendance', {});
  const [notice, setNotice] = useState<string | null>(null);

  const present = useMemo(() => records[eventId] ?? [], [records, eventId]);
  const event = demoEvents.find((item) => item.id === eventId);

  const toggle = (memberId: string) => {
    setRecords((current) => {
      const list = current[eventId] ?? [];
      const next = list.includes(memberId)
        ? list.filter((id) => id !== memberId)
        : [...list, memberId];
      return { ...current, [eventId]: next };
    });
    setNotice(null);
  };

  const save = () => {
    if (!event) return;
    enqueue(
      'chapter.event.attendance_recorded',
      `Attendance for "${event.title}" (${present.length}/${demoRoster.length} present)`
    );
    setNotice(event.title);
  };

  return (
    <div className="stack">
      <Field id="att-event" label="Chapter event">
        <Select id="att-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
          {demoEvents.map((item) => (
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
        <button type="button" className="btn btn-primary" onClick={save} disabled={!event}>
          Save attendance
        </button>
      </div>

      {notice ? <QueuedNotice label={`Attendance for "${notice}"`} /> : null}
    </div>
  );
}
