import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../index';
import { dayCapacity } from '../scheduling/capacity';
import { WeekPatternSchema } from '../schemas';
import {
  APP_CALENDAR_NAME,
  APP_EVENT_SOURCE,
  blockedDays,
  classifyEvent,
  classifyEvents,
  splitByDay,
  toBusyIntervals,
} from './busy';
import { CalendarEventSchema, type CalendarEventInput } from './event';

const TZ = 'Asia/Jerusalem'; // UTC+2 in winter, UTC+3 in summer
const ctx = { timeZone: TZ };

function ev(over: Partial<CalendarEventInput> = {}) {
  return CalendarEventSchema.parse({
    id: 'e1',
    summary: 'Meeting',
    start: { dateTime: '2026-11-03T10:00:00+02:00' },
    end: { dateTime: '2026-11-03T11:30:00+02:00' },
    ...over,
  });
}

const self = (responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction') => ({
  attendees: [{ responseStatus }, { self: true, responseStatus }],
});

describe('constants', () => {
  it('names the secondary calendar after the product', () => {
    expect(APP_CALENDAR_NAME).toBe(APP_NAME);
    expect(APP_EVENT_SOURCE).toBe('upversion');
  });
});

describe('classifyEvent', () => {
  const rows: [string, Partial<CalendarEventInput>, string, string][] = [
    ['plain event without attendees', {}, 'busy', 'no_attendees'],
    [
      'organizer',
      { organizer: { self: true }, attendees: [{ responseStatus: 'accepted' }] },
      'busy',
      'organizer',
    ],
    ['accepted', self('accepted'), 'busy', 'accepted'],
    ['tentative', self('tentative'), 'tentative', 'tentative'],
    ['declined', self('declined'), 'ignored', 'declined'],
    ['needsAction', self('needsAction'), 'ignored', 'not_responded'],
    ['free', { transparency: 'transparent' }, 'ignored', 'free'],
    ['opaque', { transparency: 'opaque' }, 'busy', 'no_attendees'],
    ['cancelled', { status: 'cancelled' }, 'ignored', 'cancelled'],
    [
      'not a participant',
      { attendees: [{ responseStatus: 'accepted' }] },
      'ignored',
      'not_a_participant',
    ],
    ['out of office', { eventType: 'outOfOffice' }, 'busy', 'out_of_office'],
    ['working location', { eventType: 'workingLocation' }, 'ignored', 'working_location'],
    ['unknown future event type', { eventType: 'fromGmail' }, 'busy', 'no_attendees'],
    ['focus time', { eventType: 'focusTime' }, 'busy', 'focus_time'],
    [
      'declined out of office',
      { eventType: 'outOfOffice', ...self('declined') },
      'ignored',
      'declined',
    ],
    [
      'own study block',
      { extendedProperties: { private: { source: APP_EVENT_SOURCE, task_id: 't1' } } },
      'ignored',
      'own_study_block',
    ],
    [
      'foreign source tag',
      { extendedProperties: { private: { source: 'other' } } },
      'busy',
      'no_attendees',
    ],
    [
      'end before start',
      { end: { dateTime: '2026-11-03T09:00:00+02:00' } },
      'ignored',
      'invalid_time',
    ],
  ];

  it.each(rows)('%s', (_name, over, kind, reason) => {
    const r = classifyEvent(ev(over), ctx);
    expect(r.kind).toBe(kind);
    expect(r.reason).toBe(reason);
    if (kind === 'ignored') expect(r.intervals).toEqual([]);
  });

  it('keeps the tentative intervals for display', () => {
    const r = classifyEvent(ev(self('tentative')), ctx);
    expect(r.intervals).toEqual([{ date: '2026-11-03', startMinute: 600, endMinute: 690 }]);
  });

  it('converts to the plan time zone', () => {
    const r = classifyEvent(
      ev({
        start: { dateTime: '2026-11-03T08:00:00Z' },
        end: { dateTime: '2026-11-03T09:00:00Z' },
      }),
      ctx,
    );
    expect(r.intervals).toEqual([{ date: '2026-11-03', startMinute: 600, endMinute: 660 }]);
  });

  it('splits an event that crosses midnight', () => {
    const r = classifyEvent(
      ev({
        start: { dateTime: '2026-11-03T22:00:00+02:00' },
        end: { dateTime: '2026-11-04T01:30:00+02:00' },
      }),
      ctx,
    );
    expect(r.intervals).toEqual([
      { date: '2026-11-03', startMinute: 1320, endMinute: 1440 },
      { date: '2026-11-04', startMinute: 0, endMinute: 90 },
    ]);
  });

  it('does not spill an event ending exactly at midnight onto the next day', () => {
    const r = classifyEvent(
      ev({
        start: { dateTime: '2026-11-03T23:00:00+02:00' },
        end: { dateTime: '2026-11-04T00:00:00+02:00' },
      }),
      ctx,
    );
    expect(r.intervals).toEqual([{ date: '2026-11-03', startMinute: 1380, endMinute: 1440 }]);
  });

  it('handles a daylight-saving day without leaving 0..1440', () => {
    // Israel moves clocks back on 2026-10-25 (25-hour day).
    const parts = splitByDay(
      Date.parse('2026-10-24T20:00:00Z'),
      Date.parse('2026-10-25T21:00:00Z'),
      TZ,
    );
    expect(parts).toEqual([
      { date: '2026-10-24', startMinute: 1380, endMinute: 1440 },
      { date: '2026-10-25', startMinute: 0, endMinute: 1380 },
    ]);
  });

  it('keeps an event inside the repeated hour when clocks go back', () => {
    // 01:30 (+03:00) to 01:30 (+02:00) on 2026-10-25 is one real hour.
    const parts = splitByDay(
      Date.parse('2026-10-24T22:30:00Z'),
      Date.parse('2026-10-24T23:30:00Z'),
      TZ,
    );
    expect(parts).toEqual([{ date: '2026-10-25', startMinute: 90, endMinute: 150 }]);
  });
});

describe('all-day events', () => {
  const allDay = (over: Partial<CalendarEventInput> = {}) =>
    ev({ id: 'v1', start: { date: '2026-11-10' }, end: { date: '2026-11-13' }, ...over });

  it('are not counted by default', () => {
    const r = classifyEvent(allDay(), ctx);
    expect(r.kind).toBe('all_day');
    expect(r.blocksDay).toBeUndefined();
    expect(r.days).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(toBusyIntervals([r])).toEqual([]);
    expect(blockedDays([r])).toEqual([]);
  });

  it('block the days when the user marked them', () => {
    const r = classifyEvent(allDay(), { ...ctx, blockingEventIds: new Set(['v1']) });
    expect(r.kind).toBe('all_day');
    expect(r.blocksDay).toBe(true);
    expect(blockedDays([r])).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });

  it('block the days even when Google marks them Free (the default for all-day)', () => {
    const r = classifyEvent(allDay({ transparency: 'transparent' }), {
      ...ctx,
      blockingEventIds: new Set(['v1']),
    });
    expect(r.kind).toBe('all_day');
    expect(r.blocksDay).toBe(true);
  });

  it('stay ignored when declined or cancelled, even if marked', () => {
    const c = { ...ctx, blockingEventIds: new Set(['v1']) };
    expect(classifyEvent(allDay(self('declined')), c).kind).toBe('ignored');
    expect(classifyEvent(allDay({ status: 'cancelled' }), c).kind).toBe('ignored');
  });
});

describe('toBusyIntervals and the scheduling engine', () => {
  it('produces BusyInterval values that reduce capacity', () => {
    const results = classifyEvents(
      [
        ev({
          start: { dateTime: '2026-11-03T10:00:00+02:00' },
          end: { dateTime: '2026-11-03T12:00:00+02:00' },
        }),
        ev({ id: 'e2', ...self('tentative') }),
        ev({ id: 'e3', transparency: 'transparent' }),
      ],
      ctx,
    );
    const busy = toBusyIntervals(results);
    expect(busy).toEqual([{ date: '2026-11-03', start: '10:00', end: '12:00', title: 'Meeting' }]);
    const pattern = WeekPatternSchema.parse({
      studyWeekdays: [0, 1, 2, 3, 4, 5, 6],
      defaultHours: 7,
      windowStart: '08:00',
      windowEnd: '18:00',
      timezone: TZ,
    });
    const free = dayCapacity('2026-11-03', pattern, [], []);
    const withBusy = dayCapacity('2026-11-03', pattern, [], busy);
    expect(free.capacityMinutes - withBusy.capacityMinutes).toBe(120);
  });
});

describe('properties', () => {
  const ZONES = ['UTC', 'Asia/Kolkata', 'America/Sao_Paulo', 'Pacific/Auckland'];
  // Fixed-offset zones outside DST changes in the sampled range keep total minutes exact.
  const FIXED = ['UTC', 'Asia/Kolkata'];
  const instant = fc.integer({
    min: Date.parse('2026-01-01T00:00:00Z') / 60_000,
    max: Date.parse('2026-12-31T00:00:00Z') / 60_000,
  });
  const span = fc.integer({ min: 1, max: 60 * 24 * 5 });

  it('no piece crosses a day boundary and pieces are ordered', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), instant, span, (zone, start, len) => {
        const parts = splitByDay(start * 60_000, (start + len) * 60_000, zone);
        expect(parts.length).toBeGreaterThan(0);
        for (const [i, p] of parts.entries()) {
          expect(p.startMinute).toBeGreaterThanOrEqual(0);
          expect(p.endMinute).toBeLessThanOrEqual(1440);
          expect(p.endMinute).toBeGreaterThan(p.startMinute);
          if (i > 0) expect(p.date > parts[i - 1]!.date).toBe(true);
        }
      }),
    );
  });

  it('preserves total minutes', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FIXED), instant, span, (zone, start, len) => {
        const parts = splitByDay(start * 60_000, (start + len) * 60_000, zone);
        const total = parts.reduce((s, p) => s + (p.endMinute - p.startMinute), 0);
        expect(total).toBe(len);
      }),
    );
  });

  it('never counts tentative, declined, free, cancelled or own events', () => {
    const uncounted = fc.constantFrom<Partial<CalendarEventInput>>(
      self('tentative'),
      self('declined'),
      self('needsAction'),
      { transparency: 'transparent' },
      { status: 'cancelled' },
      { extendedProperties: { private: { source: APP_EVENT_SOURCE } } },
    );
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), instant, span, uncounted, (zone, start, len, over) => {
        const event = ev({
          ...over,
          start: { dateTime: new Date(start * 60_000).toISOString() },
          end: { dateTime: new Date((start + len) * 60_000).toISOString() },
        });
        const r = classifyEvent(event, { timeZone: zone });
        expect(r.kind).not.toBe('busy');
        expect(toBusyIntervals([r])).toEqual([]);
      }),
    );
  });
});
