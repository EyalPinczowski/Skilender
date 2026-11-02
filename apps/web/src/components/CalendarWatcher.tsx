import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useCalendarStatus, useSyncCalendar } from '../api/calendar-hooks';
import { ConnectButton } from '../pages/settings/CalendarSettings';
import { AlertIcon } from './icons';

/**
 * Two small jobs for the optional calendar link, both silent when the feature is off (the status
 * answers 404) or when nothing is connected:
 * - once per session, when the status says "connected", ask for a sync (fire and forget; a failure
 *   changes nothing and shows nothing, the schedule never depends on the calendar);
 * - show the "Reconnect calendar" banner when Google no longer accepts the connection. The app
 *   keeps working on its own data meanwhile.
 */
export function CalendarWatcher() {
  const status = useCalendarStatus();
  const sync = useSyncCalendar();
  const synced = useRef(false);
  const state = status.data?.status;
  const { pathname } = useLocation();

  useEffect(() => {
    if (state !== 'connected' || synced.current) return;
    synced.current = true;
    sync.mutate(undefined, { onError: () => undefined });
    // `sync.mutate` is stable; the ref makes this once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Those two pages carry the same controls themselves.
  if (
    state !== 'needs_reconnect' ||
    pathname === '/calendar/callback' ||
    pathname === '/settings'
  ) {
    return null;
  }
  return (
    <div
      role="region"
      aria-label="Calendar connection"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-warn bg-warn-soft p-3"
    >
      <AlertIcon />
      <p className="grow font-bold">
        Google Calendar needs to be reconnected. Everything else keeps working.
      </p>
      <ConnectButton label="Reconnect calendar" primary />
    </div>
  );
}
