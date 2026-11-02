import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { createDaysService } from '../src/modules/days/service';
import { createSchedulingService } from '../src/modules/scheduling/service';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'b0000000-0000-4000-8000-000000000001';

interface Block {
  taskId: string;
  date: string;
  start: string;
  end: string;
  minutes: number;
  kind: string;
}
interface Schedule {
  blocks: Block[];
  warnings: { kind: string }[];
}

// Plan A starts on Sunday 2026-11-01 and studies Sunday to Thursday, 7 h a day, in the window
// 09:00-17:00 minus lunch 13:00-14:00, in Jerusalem (UTC+2 in November).
const SUN = '2026-11-01';
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const at = (date: string, time = '08:00') => new Date(`${date}T${time}:00Z`);
/** Local Jerusalem time on a date in November (UTC+2) as a timestamptz literal. */
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${date}T${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
};
const minutesOn = (blocks: Block[], date: string) =>
  blocks.filter((b) => b.date === date).reduce((s, b) => s + b.minutes, 0);
const on = (blocks: Block[], date: string) => blocks.filter((b) => b.date === date);
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const overlaps = (b: Block, from: string, to: string) =>
  mins(b.start) < mins(to) && mins(from) < mins(b.end);

describe.skipIf(!dbAvailable)('calendar rows in the schedule (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let clock = at(SUN);
  let scheduling: ReturnType<typeof createSchedulingService>;

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    app = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
      now: () => clock,
    });
    await app.ready();
    scheduling = createSchedulingService(
      db,
      createDaysService(db, () => clock),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    clock = at(SUN);
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(
        `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`,
        [A, B],
      );
      await acceptCurrentLegal(c, [A, B]);
      for (const [user, plan] of [
        [A, PLAN_A],
        [B, PLAN_B],
      ] as const) {
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
           values ($1, $2, 'builder', 'Plan', 'active', $3, '2026-10-30T10:00:00Z')`,
          [user, plan, SUN],
        );
        await c.query(
          `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
             window_start, window_end, lunch_start, lunch_end, break_minutes, timezone)
           values ($1, $2, '{0,1,2,3,4}', 7, '09:00', '17:00', '13:00', '14:00', 0, 'Asia/Jerusalem')`,
          [user, plan],
        );
        // One long course, and a one-hour task that tests lock in place.
        await c.query(
          `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
           values ($1, $2, 'big', 'Big course', 'course', 34, 0),
                  ($1, $2, 'lk', 'Locked task', 'course', 1, 1)`,
          [user, plan],
        );
      }
    });
  });

  const asA = async () => ({
    authorization: `Bearer ${await keys.sign({ sub: A, email: 'a@example.com' })}`,
  });
  const schedule = async (): Promise<Schedule> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${PLAN_A}/schedule`,
      headers: await asA(),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Schedule;
  };
  const busyRow = (
    user: string,
    date: string,
    startMin: number,
    endMin: number,
    kind: 'busy' | 'tentative' | 'all_day',
    opts: { id?: string; blocksDay?: boolean } = {},
  ) =>
    testDb.admin((c) =>
      c.query(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id,
           start_minute, end_minute, title, kind, blocks_day)
         values ($1, $2, $3, 'primary', $4, $5, 'Event', $6, $7)`,
        [
          user,
          date,
          opts.id ?? `${kind}-${date}-${startMin}`,
          startMin,
          endMin,
          kind,
          opts.blocksDay ?? false,
        ],
      ),
    );
  const lockRow = (user: string, plan: string, taskId: string, startsAt: string, endsAt: string) =>
    testDb.admin((c) =>
      c.query(
        `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at,
           ends_at, reason) values ($1, $2, $3, $4, $5, $6, 'moved')`,
        [user, plan, `${taskId}-${startsAt}`, taskId, startsAt, endsAt],
      ),
    );

  it('with empty calendar tables, a Monday has the full 7 hours', async () => {
    const s = await schedule();
    expect(minutesOn(s.blocks, MON)).toBe(7 * 60);
    expect(await scheduling.calendarImpact(A, PLAN_A)).toMatchObject({
      movedTaskIds: [],
      finishChanged: false,
    });
  });

  it('(a) a 2-hour busy event on a 7-hour day leaves 5 hours, scheduled around it', async () => {
    await busyRow(A, MON, 11 * 60, 13 * 60, 'busy');
    const s = await schedule();
    expect(minutesOn(s.blocks, MON)).toBe(5 * 60);
    expect(on(s.blocks, MON).some((b) => overlaps(b, '11:00', '13:00'))).toBe(false);
    // Other days keep their 7 hours.
    expect(minutesOn(s.blocks, SUN)).toBe(7 * 60);
    expect(minutesOn(s.blocks, TUE)).toBe(7 * 60);
  });

  it('the change summary reports tasks that moved because of a new busy event', async () => {
    await busyRow(A, MON, 11 * 60, 13 * 60, 'busy');
    const summary = await scheduling.calendarImpact(A, PLAN_A);
    expect(summary.movedTaskIds).toContain('big');
    expect(summary.finishChanged).toBe(true);
    expect(summary.text).toMatch(/moved/);
  });

  it('(b) tentative and non-blocking all-day events do not change the schedule', async () => {
    const before = await schedule();
    await busyRow(A, MON, 11 * 60, 13 * 60, 'tentative');
    await busyRow(A, TUE, 0, 1440, 'all_day', { blocksDay: false });
    const after = await schedule();
    expect(after.blocks).toEqual(before.blocks);
    expect(await scheduling.calendarImpact(A, PLAN_A)).toMatchObject({ movedTaskIds: [] });
  });

  it('(c) an all-day event with blocks_day=true empties that day', async () => {
    await busyRow(A, TUE, 0, 1440, 'all_day', { blocksDay: true });
    const s = await schedule();
    expect(on(s.blocks, TUE)).toEqual([]);
    expect(minutesOn(s.blocks, MON)).toBe(7 * 60);
    expect(minutesOn(s.blocks, WED)).toBe(7 * 60);
    const summary = await scheduling.calendarImpact(A, PLAN_A);
    expect(summary.finishChanged).toBe(true);
  });

  it('(d) a locked block stays at its locked time and the others move around it', async () => {
    await lockRow(A, PLAN_A, 'lk', local(MON, '15:00'), local(MON, '16:00'));
    const s = await schedule();
    const locked = s.blocks.filter((b) => b.taskId === 'lk');
    expect(locked).toEqual([
      { taskId: 'lk', date: MON, start: '15:00', end: '16:00', minutes: 60, kind: 'locked' },
    ]);
    expect(
      on(s.blocks, MON)
        .filter((b) => b.taskId !== 'lk')
        .some((b) => overlaps(b, '15:00', '16:00')),
    ).toBe(false);
    // The day is not filled beyond its capacity.
    expect(minutesOn(s.blocks, MON)).toBe(7 * 60);
  });

  it("(e) another user's calendar rows have no effect", async () => {
    const before = await schedule();
    await busyRow(B, MON, 9 * 60, 17 * 60, 'busy');
    await busyRow(B, TUE, 0, 1440, 'all_day', { blocksDay: true });
    await lockRow(B, PLAN_B, 'lk', local(MON, '15:00'), local(MON, '16:00'));
    expect((await schedule()).blocks).toEqual(before.blocks);
    // The rows are not hidden by accident: B's own schedule does change.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${PLAN_B}/schedule`,
      headers: { authorization: `Bearer ${await keys.sign({ sub: B, email: 'b@example.com' })}` },
    });
    const b = res.json() as Schedule;
    expect(on(b.blocks, TUE)).toEqual([]);
    expect(b.blocks.some((x) => x.kind === 'locked')).toBe(true);
  });

  it('a locked block that overlaps a busy event: the engine keeps the lock where it is', async () => {
    // Busy 15:00-16:00 (not lunch) and the user's locked block 15:00-16:00 on top of it.
    await busyRow(A, MON, 15 * 60, 16 * 60, 'busy');
    await lockRow(A, PLAN_A, 'lk', local(MON, '15:00'), local(MON, '16:00'));
    const s = await schedule();
    // The lock is not moved or dropped, and nothing warns about the overlap with busy time.
    expect(s.blocks.filter((b) => b.taskId === 'lk')).toEqual([
      { taskId: 'lk', date: MON, start: '15:00', end: '16:00', minutes: 60, kind: 'locked' },
    ]);
    expect(s.warnings.some((w) => w.kind === 'fixed_overlap')).toBe(false);
    // Other blocks avoid that hour.
    expect(
      on(s.blocks, MON)
        .filter((b) => b.taskId !== 'lk')
        .some((b) => overlaps(b, '15:00', '16:00')),
    ).toBe(false);
    // The busy hour reduced capacity to 6 h and the lock uses 1 h of it, so Monday has 6 h
    // in total (5 h of study + the locked hour).
    expect(minutesOn(s.blocks, MON)).toBe(6 * 60);
  });

  it('freezing a day at its end uses the calendar, so the snapshot matches what was shown', async () => {
    await busyRow(A, MON, 11 * 60, 13 * 60, 'busy');
    clock = at(MON);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${PLAN_A}/days/${MON}/end`,
      headers: await asA(),
    });
    expect(res.statusCode).toBeLessThan(300);
    const [row] = await testDb.admin(
      async (c) =>
        (
          await c.query(`select blocks from rnd.schedule_days where plan_id = $1 and date = $2`, [
            PLAN_A,
            MON,
          ])
        ).rows as { blocks: Block[] }[],
    );
    expect(minutesOn(row!.blocks, MON)).toBe(5 * 60);
  });
});
