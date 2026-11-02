import { useEffect, useId, useRef, useState } from 'react';
import { ClockIcon } from '../../components/icons';
import { clock, FIVE_MINUTES, FIVE_MINUTES_LEFT, TIME_IS_UP } from './practice-utils';

/**
 * Counts down from the planned minutes and keeps going past zero, marked "over time". The visible
 * clock changes every second but is not a live region. A separate polite status region speaks only
 * twice: when 5 minutes are left and when the planned time is up. Resuming a session that is already
 * past a moment does not announce it again.
 */
export function Timer({
  startedAt,
  plannedMinutes,
}: {
  startedAt: string;
  plannedMinutes: number;
}) {
  const labelId = useId();
  const startMs = Date.parse(startedAt);
  const totalSeconds = plannedMinutes * 60;
  const remainingAt = (now: number) => totalSeconds - Math.floor((now - startMs) / 1000);

  const [remaining, setRemaining] = useState(() => remainingAt(Date.now()));
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef(remaining);

  useEffect(() => {
    const id = setInterval(() => {
      const next = totalSeconds - Math.floor((Date.now() - startMs) / 1000);
      const before = previous.current;
      previous.current = next;
      setRemaining(next);
      if (next <= 0 && before > 0) setAnnouncement(TIME_IS_UP);
      else if (next <= FIVE_MINUTES && before > FIVE_MINUTES) setAnnouncement(FIVE_MINUTES_LEFT);
    }, 1000);
    return () => clearInterval(id);
  }, [startMs, totalSeconds]);

  const over = remaining < 0;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className={over ? 'text-warn' : 'text-muted'}>
        <ClockIcon />
      </span>
      <p id={labelId} className="font-bold">
        {over ? 'Over time' : 'Time left'}
      </p>
      <p
        role="timer"
        aria-labelledby={labelId}
        className={`text-h2 font-bold tabular-nums ${over ? 'text-warn' : ''}`}
      >
        {over ? '+' : ''}
        {clock(remaining)}
      </p>
      <p className="text-muted">of {plannedMinutes} min planned</p>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
