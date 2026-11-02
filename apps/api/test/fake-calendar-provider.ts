import type { CalendarEvent } from '@skillstack/shared';
import type {
  CalendarInfo,
  CalendarProvider,
  EventInsert,
  EventPage,
  EventPatch,
  GuardedInsertTarget,
  GuardedTarget,
  ListEventsOptions,
} from '../src/modules/calendar/provider';

/** In-memory CalendarProvider. Records every write so tests can assert none happened. */
export class FakeCalendarProvider implements CalendarProvider {
  readonly calendars = new Map<string, CalendarInfo>();
  readonly events = new Map<string, Map<string, CalendarEvent>>();
  /** One entry per write that reached the provider. */
  readonly writes: { op: 'insert' | 'patch' | 'delete'; calendarId: string; eventId?: string }[] =
    [];
  pageSize = 100;
  private seq = 0;

  /** Test setup: puts an event in place without going through any write path. */
  seed(calendarId: string, event: CalendarEvent): void {
    if (!this.events.has(calendarId)) this.events.set(calendarId, new Map());
    this.events.get(calendarId)!.set(event.id, event);
  }

  private bucket(calendarId: string) {
    if (!this.events.has(calendarId)) this.events.set(calendarId, new Map());
    return this.events.get(calendarId)!;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [...this.calendars.values()];
  }

  async listEvents(
    calendarId: string,
    _timeMin: string | null,
    _timeMax: string | null,
    options: ListEventsOptions = {},
  ): Promise<EventPage> {
    const tags = Object.entries(options.privateTags ?? {});
    const all = [...this.bucket(calendarId).values()].filter((e) =>
      tags.every(([k, v]) => e.extendedProperties?.private?.[k] === v),
    );
    // The page token is the last event id returned, so deleting while paging skips nothing.
    const from = options.pageToken ? all.findIndex((e) => e.id === options.pageToken) + 1 : 0;
    const slice = all.slice(from, from + this.pageSize);
    const more = from + this.pageSize < all.length;
    return {
      events: slice,
      nextPageToken: more ? (slice[slice.length - 1]?.id ?? null) : null,
      nextSyncToken: null,
    };
  }

  async createCalendar(name: string): Promise<CalendarInfo> {
    const info: CalendarInfo = {
      id: `cal-${(this.seq += 1)}`,
      name,
      primary: false,
      accessRole: 'owner',
    };
    this.calendars.set(info.id, info);
    return info;
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    return this.bucket(calendarId).get(eventId) ?? null;
  }

  async insertEvent(target: GuardedInsertTarget, event: EventInsert): Promise<CalendarEvent> {
    const { privateTags, ...rest } = event;
    const created: CalendarEvent = {
      id: `ev-${(this.seq += 1)}`,
      status: 'confirmed',
      ...rest,
      extendedProperties: { private: privateTags },
    };
    this.bucket(target.calendarId).set(created.id, created);
    this.writes.push({ op: 'insert', calendarId: target.calendarId, eventId: created.id });
    return created;
  }

  async patchEvent(target: GuardedTarget, patch: EventPatch): Promise<CalendarEvent> {
    const current = this.bucket(target.calendarId).get(target.eventId);
    if (!current) throw new Error('fake: no such event');
    const { privateTags, ...rest } = patch;
    const updated: CalendarEvent = {
      ...current,
      ...rest,
      extendedProperties: { private: { ...current.extendedProperties?.private, ...privateTags } },
    };
    this.bucket(target.calendarId).set(target.eventId, updated);
    this.writes.push({ op: 'patch', calendarId: target.calendarId, eventId: target.eventId });
    return updated;
  }

  async deleteEvent(target: GuardedTarget): Promise<void> {
    this.bucket(target.calendarId).delete(target.eventId);
    this.writes.push({ op: 'delete', calendarId: target.calendarId, eventId: target.eventId });
  }
}
