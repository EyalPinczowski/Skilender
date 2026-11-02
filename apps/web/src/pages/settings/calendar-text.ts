import type { CalendarStatus } from '../../api/calendar-hooks';

/** The last sync error in plain words. Unknown codes get a general sentence, never the raw code. */
export function lastErrorText(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case 'calendar_reconnect_required':
    case 'invalid_grant':
      return 'Google no longer accepts the connection, so it needs to be set up again.';
    case 'google_unavailable':
    case 'calendar_unavailable':
      return 'Google could not be reached on the last try.';
    default:
      return 'The last sync did not finish.';
  }
}

export const STATUS_TEXT: Record<CalendarStatus['status'], string> = {
  disconnected: 'Not connected.',
  connected: 'Connected.',
  needs_reconnect: 'Needs to be reconnected.',
};
