import { APP_EVENT_SOURCE, type CalendarEvent } from '@upversion/shared';
import { CalendarConflictError, CalendarPreconditionFailedError } from './errors';
import { mintInsertTarget, mintTarget, type GuardedTarget } from './guarded';
import type { AppEventDraft, CalendarProvider, EventPatch } from './provider';

/**
 * The calendar write guard (spec 3.8). This is the ONLY code that may write events:
 *  - the provider's write methods take a branded target that only this file can create, so
 *    bypassing the guard does not compile;
 *  - an ESLint rule forbids calling them from any other file.
 * A write goes ahead only when the event is in the app's own calendar AND is tagged as the app's
 * (`source=<APP_EVENT_SOURCE value>` plus a `task_id`). The event is fetched fresh from the provider for every
 * patch or delete, never trusted from a caller or a cache.
 */

export type WriteRefusal =
  | 'not_app_calendar'
  | 'event_not_found'
  | 'not_tagged_as_app_event'
  | 'missing_task_id'
  | 'invalid_task_id'
  | 'invalid_event_id'
  | 'event_id_taken'
  | 'changed_concurrently';

export class CalendarWriteRefused extends Error {
  constructor(public readonly reason: WriteRefusal) {
    super(`Calendar write refused (${reason})`);
    this.name = 'CalendarWriteRefused';
  }
}

const SOURCE_KEY = 'source';
const TASK_KEY = 'task_id';

// Google's rule for client-chosen event ids: base32hex characters, 5 to 1024 long.
const EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;

const isNonEmpty = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** Returns the event's task id, or throws unless the event carries the app's tags. */
function ownTaskId(event: CalendarEvent): string {
  const tags = event.extendedProperties?.private;
  if (tags?.[SOURCE_KEY] !== APP_EVENT_SOURCE) {
    throw new CalendarWriteRefused('not_tagged_as_app_event');
  }
  const taskId = tags[TASK_KEY];
  if (!isNonEmpty(taskId)) throw new CalendarWriteRefused('missing_task_id');
  return taskId;
}

export interface WriteGuard {
  /** Creates an event in the app calendar with the app's tags forced on. Returns the created event. */
  insertAppEvent(calendarId: string, taskId: string, draft: AppEventDraft): Promise<CalendarEvent>;
  /** Changes an app-created event. Its tags cannot be changed. */
  patchAppEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<Omit<AppEventDraft, 'id'>>,
  ): Promise<CalendarEvent>;
  /** Deletes an app-created event. Returns false (and writes nothing) when it is already gone. */
  deleteAppEvent(calendarId: string, eventId: string): Promise<boolean>;
  /**
   * For disconnect and account deletion: deletes every event in the app calendar that is tagged as
   * ours. Never deletes the calendar itself and never touches untagged events. Returns how many.
   */
  deleteAllAppEvents(calendarId: string): Promise<number>;
}

/**
 * @param provider the calendar backend
 * @param appCalendarId the stored id of the app's own calendar (never the user's primary one)
 */
export function createWriteGuard(provider: CalendarProvider, appCalendarId: string): WriteGuard {
  if (!isNonEmpty(appCalendarId)) throw new CalendarWriteRefused('not_app_calendar');

  const assertAppCalendar = (calendarId: string) => {
    if (calendarId !== appCalendarId) throw new CalendarWriteRefused('not_app_calendar');
  };

  /** Re-fetches the event and approves it, or throws. Null means it is gone. */
  async function approve(
    calendarId: string,
    eventId: string,
  ): Promise<{ target: GuardedTarget; taskId: string } | null> {
    assertAppCalendar(calendarId);
    const event = await provider.getEvent(calendarId, eventId);
    if (!event || event.status === 'cancelled') return null;
    const taskId = ownTaskId(event);
    return { target: mintTarget(calendarId, eventId, event.etag), taskId };
  }

  async function patchChecked(target: GuardedTarget, patch: EventPatch): Promise<CalendarEvent> {
    try {
      return await provider.patchEvent(target, patch);
    } catch (error) {
      if (error instanceof CalendarPreconditionFailedError) {
        throw new CalendarWriteRefused('changed_concurrently');
      }
      throw error;
    }
  }

  async function remove(calendarId: string, eventId: string): Promise<boolean> {
    const approved = await approve(calendarId, eventId);
    if (!approved) return false;
    try {
      await provider.deleteEvent(approved.target);
    } catch (error) {
      if (error instanceof CalendarPreconditionFailedError) {
        throw new CalendarWriteRefused('changed_concurrently');
      }
      throw error;
    }
    return true;
  }

  return {
    async insertAppEvent(calendarId, taskId, draft) {
      assertAppCalendar(calendarId);
      if (!isNonEmpty(taskId)) throw new CalendarWriteRefused('invalid_task_id');
      if (!EVENT_ID_PATTERN.test(draft.id ?? ''))
        throw new CalendarWriteRefused('invalid_event_id');
      const target = mintInsertTarget(calendarId);
      const tags = { [SOURCE_KEY]: APP_EVENT_SOURCE, [TASK_KEY]: taskId };
      try {
        // Tags are set last, so nothing a caller passes can override them.
        return await provider.insertEvent(target, { ...draft, privateTags: tags });
      } catch (error) {
        if (!(error instanceof CalendarConflictError)) throw error;
        // The id exists: a retry of an insert that landed, or an event of ours that was deleted
        // (Google keeps the id of a deleted event). Only an event of THIS task is ever reused.
        const existing = await provider.getEvent(calendarId, draft.id);
        if (!existing) throw new CalendarWriteRefused('event_id_taken');
        if (ownTaskId(existing) !== taskId) throw new CalendarWriteRefused('event_id_taken');
        if (existing.status !== 'cancelled') return existing;
        return patchChecked(mintTarget(calendarId, draft.id, existing.etag), {
          summary: draft.summary,
          description: draft.description,
          colorId: draft.colorId,
          start: draft.start,
          end: draft.end,
          status: 'confirmed',
          privateTags: tags,
        });
      }
    },

    async patchAppEvent(calendarId, eventId, patch) {
      const approved = await approve(calendarId, eventId);
      if (!approved) throw new CalendarWriteRefused('event_not_found');
      return patchChecked(approved.target, {
        ...patch,
        privateTags: { [SOURCE_KEY]: APP_EVENT_SOURCE, [TASK_KEY]: approved.taskId },
      });
    },

    deleteAppEvent: remove,

    async deleteAllAppEvents(calendarId) {
      assertAppCalendar(calendarId);
      let deleted = 0;
      let pageToken: string | undefined;
      do {
        const page = await provider.listEvents(calendarId, null, null, {
          pageToken,
          privateTags: { [SOURCE_KEY]: APP_EVENT_SOURCE },
        });
        for (const event of page.events) {
          // The tag filter is asked of the provider but never relied on: remove() re-checks, and
          // an event that is not fully ours is skipped rather than aborting the cleanup.
          const tags = event.extendedProperties?.private;
          if (tags?.[SOURCE_KEY] !== APP_EVENT_SOURCE || !isNonEmpty(tags[TASK_KEY])) continue;
          if (await remove(calendarId, event.id)) deleted += 1;
        }
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
      return deleted;
    },
  };
}
