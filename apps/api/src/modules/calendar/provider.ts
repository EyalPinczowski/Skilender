import type { CalendarEvent, CalendarEventTimeSchema } from '@upversion/shared';
import type { z } from 'zod';
import type { GuardedInsertTarget, GuardedTarget } from './guarded';

/**
 * The calendar seam (spec 12.3). Domain types only: nothing here is a Google shape, so another
 * provider can implement it. The write protection of spec 3.8 lives ABOVE this interface, in
 * `write-guard.ts`, so it applies to every provider.
 */

export type CalendarEventTime = z.infer<typeof CalendarEventTimeSchema>;

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  /** Whether the user can write to it; the app's own calendar is `owner`. */
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader' | 'unknown';
}

export interface ListEventsOptions {
  /** Resume an incremental sync. Providers ignore timeMin/timeMax when this is set. */
  syncToken?: string;
  pageToken?: string;
  /** Include cancelled events (needed to see deletions during a sync). */
  showDeleted?: boolean;
  /** Only events whose private tags equal all of these. */
  privateTags?: Record<string, string>;
}

export interface EventPage {
  events: CalendarEvent[];
  nextPageToken: string | null;
  /** Present on the last page of a listing; store it for the next incremental sync. */
  nextSyncToken: string | null;
}

/** What the app writes. The guard adds the tags; callers cannot supply them. */
export interface AppEventDraft {
  /**
   * Deterministic event id (see `eventIdFor`): a retried insert hits 409 instead of duplicating.
   * Google needs base32hex characters (a-v, 0-9), 5 to 1024 long.
   */
  id: string;
  summary: string;
  description?: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
}

/** The provider-level payload: a draft plus the private tags (forced by the guard). */
export type EventInsert = AppEventDraft & { privateTags: Record<string, string> };
export type EventPatch = Partial<Omit<AppEventDraft, 'id'>> & {
  /** Only used to restore an app event that was deleted (cancelled). */
  status?: 'confirmed';
  privateTags: Record<string, string>;
};

export type { GuardedInsertTarget, GuardedTarget } from './guarded';

export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(
    calendarId: string,
    timeMin: string | null,
    timeMax: string | null,
    options?: ListEventsOptions,
  ): Promise<EventPage>;
  /** Creates the app's secondary calendar. Not an event write; the caller stores the returned id. */
  createCalendar(name: string): Promise<CalendarInfo>;
  /** Null when the event does not exist (or was deleted). */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
  /** Event writes accept only guard-approved targets (see write-guard.ts). */
  insertEvent(target: GuardedInsertTarget, event: EventInsert): Promise<CalendarEvent>;
  patchEvent(target: GuardedTarget, patch: EventPatch): Promise<CalendarEvent>;
  deleteEvent(target: GuardedTarget): Promise<void>;
}
