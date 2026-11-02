import { addDays, formatTime, type LocalDate, type Minutes } from '../dates';
import { APP_NAME } from '../constants';
import type { BusyInterval } from '../schemas';
import { localDateOf, utcOffsetMinutes, zonedTimeToUtc } from '../zone';
import type { CalendarEvent } from './event';

/**
 * Busy-event classifier (spec 3.8). Pure: events in, classification out. It never talks to
 * Google and never decides anything about writing; it only says what counts against capacity.
 */

/**
 * Value of `extendedProperties.private.source` on events the app created (spec 3.8). It is stored
 * on real calendar events, so it is a fixed neutral value, not the product name, and it must
 * NEVER change: a different value would orphan every event the app already wrote.
 */
export const APP_EVENT_SOURCE = 'studyplanner-app';

/** Display name of the app's secondary calendar (spec 3.8). Always equal to the product name. */
export const APP_CALENDAR_NAME = APP_NAME;

export type BusyKind = 'busy' | 'tentative' | 'all_day' | 'ignored';

export type BusyReason =
  | 'cancelled'
  | 'own_study_block'
  | 'free'
  | 'working_location'
  | 'declined'
  | 'not_responded'
  | 'not_a_participant'
  | 'invalid_time'
  | 'organizer'
  | 'no_attendees'
  | 'accepted'
  /** Default: out-of-office counts as busy. */
  | 'out_of_office'
  /** Default: focus time counts as busy. */
  | 'focus_time'
  | 'tentative'
  | 'all_day_blocking'
  | 'all_day_not_blocking';

/** A slice of one event on one local day, in minutes since local midnight (0 to 1440). */
export interface DayInterval {
  date: LocalDate;
  startMinute: Minutes;
  endMinute: Minutes;
}

export interface BusyClassification {
  eventId: string;
  kind: BusyKind;
  reason: BusyReason;
  title?: string | undefined;
  /**
   * Per-day pieces of a timed event. Filled for `busy` (counted) and `tentative` (shown only,
   * never counted); empty otherwise.
   */
  intervals: DayInterval[];
  /** Only for `all_day`: true when the user marked it as blocking, so it cancels the study day. */
  blocksDay?: true;
  /** Only for `all_day`: the local dates the event covers. */
  days?: LocalDate[];
}

export interface BusyContext {
  /** The plan's IANA time zone. */
  timeZone: string;
  /** Ids of all-day events the user marked as blocking. */
  blockingEventIds?: ReadonlySet<string>;
}

const MINUTE_MS = 60_000;

/** Wall-clock minutes since local midnight of `date` for an instant, capped to 0..1440. */
function wallMinutes(instantMs: number, date: LocalDate, timeZone: string): Minutes {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const localMs = instantMs + utcOffsetMinutes(instantMs, timeZone) * MINUTE_MS;
  const minutes = Math.round((localMs - Date.UTC(y, m - 1, d)) / MINUTE_MS);
  return Math.min(1440, Math.max(0, minutes));
}

/** Splits [startMs, endMs) into per-local-day intervals; none crosses midnight. */
export function splitByDay(startMs: number, endMs: number, timeZone: string): DayInterval[] {
  const out: DayInterval[] = [];
  if (!(endMs > startMs)) return out;
  const last = localDateOf(new Date(endMs - 1), timeZone);
  for (let date = localDateOf(new Date(startMs), timeZone); date <= last; date = addDays(date, 1)) {
    const dayStart = zonedTimeToUtc(date, 0, timeZone).getTime();
    const dayEnd = zonedTimeToUtc(addDays(date, 1), 0, timeZone).getTime();
    const from = Math.max(startMs, dayStart);
    const to = Math.min(endMs, dayEnd);
    if (to <= from) continue;
    const startMinute = wallMinutes(from, date, timeZone);
    // Wall clock normally; in the repeated hour when clocks go back the wall end can be
    // at or before the start, so fall back to start + elapsed minutes.
    const wallEnd = wallMinutes(to, date, timeZone);
    const elapsed = Math.round((to - from) / MINUTE_MS);
    const endMinute =
      to === dayEnd
        ? 1440
        : wallEnd > startMinute
          ? wallEnd
          : Math.min(1440, startMinute + elapsed);
    if (endMinute > startMinute) out.push({ date, startMinute, endMinute });
  }
  return out;
}

function ignored(e: CalendarEvent, reason: BusyReason): BusyClassification {
  return { eventId: e.id, kind: 'ignored', reason, title: e.summary, intervals: [] };
}

/** Dates covered by an all-day event; Google's `end.date` is exclusive. */
function allDayDates(e: CalendarEvent): LocalDate[] {
  const start = e.start.date ?? e.start.dateTime?.slice(0, 10);
  const end = e.end.date ?? e.end.dateTime?.slice(0, 10);
  if (!start || !end || end <= start) return [];
  const days: LocalDate[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * Classifies one event. Rules, in order:
 * 1. ignored: cancelled; created by the app (`source` tag); working-location events; the
 *    user's own response is `declined` or `needsAction`; the user is neither organizer nor
 *    an attendee of an event that has attendees; unusable times.
 * 2. all_day (date-only): not counted, unless its id is in `blockingEventIds`
 *    (then `blocksDay: true`). This comes before the Free check, because Google marks
 *    all-day events as Free by default and the user's explicit mark must win.
 * 2b. ignored: transparency `transparent` (Free) on a timed event.
 * 3. tentative: the user's response is `tentative`. Shown, never counted.
 * 4. busy: the user is organizer, or there are no attendees, or the user accepted.
 *    Out-of-office and focus-time events are busy by default.
 */
export function classifyEvent(event: CalendarEvent, ctx: BusyContext): BusyClassification {
  if (event.status === 'cancelled') return ignored(event, 'cancelled');
  if (event.extendedProperties?.private?.source === APP_EVENT_SOURCE) {
    return ignored(event, 'own_study_block');
  }
  if (event.eventType === 'workingLocation') return ignored(event, 'working_location');

  const attendees = event.attendees ?? [];
  const mine = attendees.find((a) => a.self === true);
  const response = mine?.responseStatus;
  if (response === 'declined') return ignored(event, 'declined');
  if (response === 'needsAction') return ignored(event, 'not_responded');

  const isOrganizer = event.organizer?.self === true;
  if (!isOrganizer && attendees.length > 0 && !mine) return ignored(event, 'not_a_participant');

  const allDay = event.start.date !== undefined || event.end.date !== undefined;
  if (allDay) {
    const days = allDayDates(event);
    if (days.length === 0) return ignored(event, 'invalid_time');
    const blocks = ctx.blockingEventIds?.has(event.id) === true;
    return {
      eventId: event.id,
      kind: 'all_day',
      reason: blocks ? 'all_day_blocking' : 'all_day_not_blocking',
      title: event.summary,
      intervals: [],
      days,
      ...(blocks ? { blocksDay: true as const } : {}),
    };
  }

  if (event.transparency === 'transparent') return ignored(event, 'free');

  const startMs = event.start.dateTime ? Date.parse(event.start.dateTime) : NaN;
  const endMs = event.end.dateTime ? Date.parse(event.end.dateTime) : NaN;
  const intervals = splitByDay(startMs, endMs, ctx.timeZone);
  if (intervals.length === 0) return ignored(event, 'invalid_time');

  const base = { eventId: event.id, title: event.summary, intervals };
  if (response === 'tentative') return { ...base, kind: 'tentative', reason: 'tentative' };

  let reason: BusyReason;
  if (event.eventType === 'outOfOffice') reason = 'out_of_office';
  else if (event.eventType === 'focusTime') reason = 'focus_time';
  else if (isOrganizer) reason = 'organizer';
  else if (attendees.length === 0) reason = 'no_attendees';
  else if (response === 'accepted') reason = 'accepted';
  else return ignored(event, 'not_responded');
  return { ...base, kind: 'busy', reason };
}

export function classifyEvents(
  events: readonly CalendarEvent[],
  ctx: BusyContext,
): BusyClassification[] {
  return events.map((e) => classifyEvent(e, ctx));
}

/**
 * The counted busy time, in the shape the scheduling engine takes as `busy`.
 * Only `busy` results count. An interval ending at midnight is written as 23:59, because
 * the engine's `HH:MM` times stop there (study windows end well before).
 */
export function toBusyIntervals(results: readonly BusyClassification[]): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const r of results) {
    if (r.kind !== 'busy') continue;
    for (const i of r.intervals) {
      const end = Math.min(i.endMinute, 24 * 60 - 1);
      if (end <= i.startMinute) continue;
      out.push({
        date: i.date,
        start: formatTime(i.startMinute),
        end: formatTime(end),
        ...(r.title !== undefined ? { title: r.title } : {}),
      });
    }
  }
  return out;
}

/** Dates the user marked as blocking (all-day events with `blocksDay`), sorted and unique. */
export function blockedDays(results: readonly BusyClassification[]): LocalDate[] {
  const days = new Set<LocalDate>();
  for (const r of results) if (r.blocksDay) for (const d of r.days ?? []) days.add(d);
  return [...days].sort();
}
