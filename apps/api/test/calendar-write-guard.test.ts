import { APP_CALENDAR_NAME, APP_EVENT_SOURCE, type CalendarEvent } from '@upversion/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { eventIdFor } from '../src/modules/calendar/event-id';
import { CalendarWriteRefused, createWriteGuard } from '../src/modules/calendar/write-guard';
import { FakeCalendarProvider } from './fake-calendar-provider';

const APP_CAL = 'app-cal';
const PRIMARY = 'primary';

const time = { dateTime: '2026-11-03T09:00:00+00:00' };
const endTime = { dateTime: '2026-11-03T10:00:00+00:00' };
const draft = { id: eventIdFor('task-9'), summary: 'Study block', start: time, end: endTime };

const event = (id: string, tags?: Record<string, string>): CalendarEvent => ({
  id,
  status: 'confirmed',
  summary: 'x',
  start: time,
  end: endTime,
  ...(tags ? { extendedProperties: { private: tags } } : {}),
});
const own = (id: string) => event(id, { source: APP_EVENT_SOURCE, task_id: 't1' });

let provider: FakeCalendarProvider;
let guard: ReturnType<typeof createWriteGuard>;

beforeEach(() => {
  provider = new FakeCalendarProvider();
  guard = createWriteGuard(provider, APP_CAL);
});

const refusal = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CalendarWriteRefused);
  return (error as CalendarWriteRefused).reason;
};

describe('write guard refuses', () => {
  it('deleting a foreign event in the primary calendar, with no provider write', async () => {
    provider.seed(PRIMARY, event('meeting'));
    expect(await refusal(guard.deleteAppEvent(PRIMARY, 'meeting'))).toBe('not_app_calendar');
    expect(provider.writes).toEqual([]);
    expect(await provider.getEvent(PRIMARY, 'meeting')).not.toBeNull();
  });

  it('patching a foreign event in the primary calendar', async () => {
    provider.seed(PRIMARY, event('meeting'));
    await refusal(guard.patchAppEvent(PRIMARY, 'meeting', { summary: 'hijacked' }));
    expect(provider.writes).toEqual([]);
  });

  it('a foreign event even when it carries our tags but sits in another calendar', async () => {
    provider.seed(PRIMARY, own('spoof'));
    await refusal(guard.deleteAppEvent(PRIMARY, 'spoof'));
    expect(provider.writes).toEqual([]);
  });

  it('an untagged event inside the app calendar', async () => {
    provider.seed(APP_CAL, event('plain'));
    expect(await refusal(guard.deleteAppEvent(APP_CAL, 'plain'))).toBe('not_tagged_as_app_event');
    await refusal(guard.patchAppEvent(APP_CAL, 'plain', { summary: 'x' }));
    expect(provider.writes).toEqual([]);
  });

  it('an event with the wrong source', async () => {
    provider.seed(APP_CAL, event('other', { source: 'someone-else', task_id: 't1' }));
    expect(await refusal(guard.deleteAppEvent(APP_CAL, 'other'))).toBe('not_tagged_as_app_event');
    expect(provider.writes).toEqual([]);
  });

  it('an event with our source but no task_id', async () => {
    provider.seed(APP_CAL, event('notask', { source: APP_EVENT_SOURCE }));
    expect(await refusal(guard.deleteAppEvent(APP_CAL, 'notask'))).toBe('missing_task_id');
    provider.seed(APP_CAL, event('blank', { source: APP_EVENT_SOURCE, task_id: ' ' }));
    expect(await refusal(guard.deleteAppEvent(APP_CAL, 'blank'))).toBe('missing_task_id');
    expect(provider.writes).toEqual([]);
  });

  it('inserting into a different calendar', async () => {
    expect(await refusal(guard.insertAppEvent(PRIMARY, 't1', draft))).toBe('not_app_calendar');
    expect(provider.writes).toEqual([]);
  });

  it('inserting without a task id', async () => {
    expect(await refusal(guard.insertAppEvent(APP_CAL, '', draft))).toBe('invalid_task_id');
    expect(provider.writes).toEqual([]);
  });

  it('patching an event that does not exist', async () => {
    expect(await refusal(guard.patchAppEvent(APP_CAL, 'nope', {}))).toBe('event_not_found');
  });

  it('a guard built without an app calendar id', () => {
    expect(() => createWriteGuard(provider, '')).toThrow(CalendarWriteRefused);
  });
});

describe('write guard allows', () => {
  it('inserting into the app calendar with the tags forced on', async () => {
    const created = await guard.insertAppEvent(APP_CAL, 'task-9', draft);
    expect(created.extendedProperties?.private).toEqual({
      source: APP_EVENT_SOURCE,
      task_id: 'task-9',
    });
    expect(provider.writes).toEqual([{ op: 'insert', calendarId: APP_CAL, eventId: created.id }]);
  });

  it('patching our own event, keeping its tags', async () => {
    provider.seed(APP_CAL, own('e1'));
    const patched = await guard.patchAppEvent(APP_CAL, 'e1', { summary: 'moved' });
    expect(patched.summary).toBe('moved');
    expect(patched.extendedProperties?.private).toEqual({
      source: APP_EVENT_SOURCE,
      task_id: 't1',
    });
  });

  it('deleting our own event, and reports false when it is already gone', async () => {
    provider.seed(APP_CAL, own('e1'));
    expect(await guard.deleteAppEvent(APP_CAL, 'e1')).toBe(true);
    expect(await provider.getEvent(APP_CAL, 'e1')).toBeNull();
    expect(await guard.deleteAppEvent(APP_CAL, 'e1')).toBe(false);
    expect(provider.writes).toHaveLength(1);
  });
});

describe('retried inserts and concurrent changes', () => {
  it('inserting the same draft twice yields one event (the second hits 409 and returns ours)', async () => {
    const first = await guard.insertAppEvent(APP_CAL, 'task-9', draft);
    const second = await guard.insertAppEvent(APP_CAL, 'task-9', draft);
    expect(second.id).toBe(first.id);
    expect(provider.events.get(APP_CAL)?.size).toBe(1);
    expect(provider.writes).toHaveLength(1);
  });

  it('refuses when the id is taken by an event that is not ours', async () => {
    provider.seed(APP_CAL, { ...event(draft.id), etag: 'x' });
    expect(await refusal(guard.insertAppEvent(APP_CAL, 'task-9', draft))).toBe(
      'not_tagged_as_app_event',
    );
    expect(provider.writes).toEqual([]);
  });

  it('refuses an id taken by an event of ANOTHER task, even though it carries our source tag', async () => {
    provider.seed(APP_CAL, {
      ...event(draft.id, { source: APP_EVENT_SOURCE, task_id: 'other-task' }),
    });
    expect(await refusal(guard.insertAppEvent(APP_CAL, 'task-9', draft))).toBe('event_id_taken');
    expect(provider.writes).toEqual([]);
  });

  it('delete then re-insert of the same task restores the event (cancelled keeps its id)', async () => {
    provider.keepCancelled = true;
    const first = await guard.insertAppEvent(APP_CAL, 'task-9', draft);
    expect(await guard.deleteAppEvent(APP_CAL, first.id)).toBe(true);
    expect((await provider.getEvent(APP_CAL, first.id))?.status).toBe('cancelled');

    const moved = { ...draft, summary: 'Back again' };
    const restored = await guard.insertAppEvent(APP_CAL, 'task-9', moved);
    expect(restored).toMatchObject({ id: first.id, status: 'confirmed', summary: 'Back again' });
    expect(restored.extendedProperties?.private).toEqual({
      source: APP_EVENT_SOURCE,
      task_id: 'task-9',
    });
    expect(provider.writes.map((w) => w.op)).toEqual(['insert', 'delete', 'patch']);
  });

  it("a cancelled event that is not ours, or is another task's, stays refused", async () => {
    provider.seed(APP_CAL, { ...event(draft.id), status: 'cancelled' });
    expect(await refusal(guard.insertAppEvent(APP_CAL, 'task-9', draft))).toBe(
      'not_tagged_as_app_event',
    );
    provider.seed(APP_CAL, {
      ...event(draft.id, { source: APP_EVENT_SOURCE, task_id: 'other' }),
      status: 'cancelled',
    });
    expect(await refusal(guard.insertAppEvent(APP_CAL, 'task-9', draft))).toBe('event_id_taken');
    expect(provider.writes).toEqual([]);
  });

  it('refuses event ids that Google would not accept', async () => {
    for (const id of ['abc', 'UPPER12345', 'has-dash1', 'w'.repeat(10), 'a'.repeat(1025)]) {
      expect(await refusal(guard.insertAppEvent(APP_CAL, 't', { ...draft, id }))).toBe(
        'invalid_event_id',
      );
    }
    expect(provider.writes).toEqual([]);
  });

  it('refuses an insert without an event id', async () => {
    const bad = { ...draft, id: '' };
    expect(await refusal(guard.insertAppEvent(APP_CAL, 't', bad))).toBe('invalid_event_id');
  });

  it('a patch or delete whose event changed after the re-fetch is refused, not applied', async () => {
    provider.seed(APP_CAL, { ...own('e1'), etag: 'v1' });
    let n = 1;
    provider.onBeforeWrite = () =>
      provider.seed(APP_CAL, { ...own('e1'), etag: `moved-${(n += 1)}` });
    expect(await refusal(guard.patchAppEvent(APP_CAL, 'e1', { summary: 'x' }))).toBe(
      'changed_concurrently',
    );
    expect(await refusal(guard.deleteAppEvent(APP_CAL, 'e1'))).toBe('changed_concurrently');
    expect(provider.writes).toEqual([]);
    expect(await provider.getEvent(APP_CAL, 'e1')).not.toBeNull();
  });

  it('forced tags win over forged privateTags smuggled into a draft', async () => {
    const forged = {
      ...draft,
      privateTags: { source: 'evil', task_id: 'forged' },
    } as unknown as typeof draft;
    const created = await guard.insertAppEvent(APP_CAL, 'task-9', forged);
    expect(created.extendedProperties?.private).toEqual({
      source: APP_EVENT_SOURCE,
      task_id: 'task-9',
    });
  });
});

describe('eventIdFor', () => {
  it('is deterministic, distinct per key and valid base32hex of 5 to 1024 chars', () => {
    expect(eventIdFor('a')).toBe(eventIdFor('a'));
    expect(eventIdFor('a')).not.toBe(eventIdFor('b'));
    expect(eventIdFor('a')).toMatch(/^[a-v0-9]{52}$/);
  });
});

describe('deleteAllAppEvents', () => {
  it('skips events that are not ours even when the provider ignores the tag filter', async () => {
    provider.ignoreTagFilter = true;
    provider.seed(APP_CAL, own('mine'));
    provider.seed(APP_CAL, event('plain'));
    provider.seed(APP_CAL, event('wrong', { source: 'other', task_id: 't' }));
    provider.seed(APP_CAL, event('notask', { source: APP_EVENT_SOURCE }));
    expect(await guard.deleteAllAppEvents(APP_CAL)).toBe(1);
    expect([...(provider.events.get(APP_CAL)?.keys() ?? [])].sort()).toEqual([
      'notask',
      'plain',
      'wrong',
    ]);
  });

  it('deletes only events tagged as ours, across pages, and never the calendar', async () => {
    provider.pageSize = 2;
    for (let i = 0; i < 5; i += 1) provider.seed(APP_CAL, own(`own-${i}`));
    provider.seed(APP_CAL, event('untagged'));
    provider.seed(APP_CAL, event('wrong', { source: 'other', task_id: 't' }));
    provider.seed(PRIMARY, own('in-primary'));
    provider.calendars.set(APP_CAL, {
      id: APP_CAL,
      name: APP_CALENDAR_NAME,
      primary: false,
      accessRole: 'owner',
    });

    expect(await guard.deleteAllAppEvents(APP_CAL)).toBe(5);

    const left = [...(provider.events.get(APP_CAL)?.keys() ?? [])];
    expect(left.sort()).toEqual(['untagged', 'wrong']);
    expect(await provider.getEvent(PRIMARY, 'in-primary')).not.toBeNull();
    expect(provider.calendars.has(APP_CAL)).toBe(true);
    expect(provider.writes.every((w) => w.op === 'delete' && w.calendarId === APP_CAL)).toBe(true);
  });

  it('refuses another calendar', async () => {
    provider.seed(PRIMARY, own('x'));
    expect(await refusal(guard.deleteAllAppEvents(PRIMARY))).toBe('not_app_calendar');
    expect(provider.writes).toEqual([]);
  });
});

describe('compile-time protection', () => {
  it('calling the provider write methods with plain ids does not compile', () => {
    // These lines are never run: the assertions are the @ts-expect-error comments, which fail
    // `pnpm typecheck` if the calls ever start to compile.
    const bypass = async () => {
      // @ts-expect-error a plain string is not a guard-approved target
      await provider.deleteEvent('some-id');
      // @ts-expect-error a plain object is not a guard-approved target
      await provider.deleteEvent({ calendarId: PRIMARY, eventId: 'meeting' });
      // @ts-expect-error a plain object is not a guard-approved target
      await provider.patchEvent({ calendarId: PRIMARY, eventId: 'meeting' }, { privateTags: {} });
      // @ts-expect-error a plain object is not a guard-approved target
      await provider.insertEvent({ calendarId: PRIMARY }, { ...draft, privateTags: {} });
      // @ts-expect-error a cast-free forged object lacks the brand
      await provider.deleteEvent({ calendarId: PRIMARY, eventId: 'x', etag: 'e' });
    };
    expect(typeof bypass).toBe('function');
  });
});
