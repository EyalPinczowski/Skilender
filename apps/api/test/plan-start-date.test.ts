import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN = 'a0000000-0000-4000-8000-000000000001';
// 2026-11-03 is a Tuesday. In Pacific/Kiritimati (UTC+14) it is already the 4th at 10:00Z.
const CLOCK = new Date('2026-11-03T10:00:00Z');

describe.skipIf(!dbAvailable)('plan start date (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    app = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
      now: () => CLOCK,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  const seed = async (tz: string, endDate: string | null = null) =>
    testDb.admin(async (c) => {
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
      await c.query(
        `insert into rnd.plans (user_id, id, created_from, name, status, start_date, end_date, created_at)
         values ($1, $2, 'builder', 'Plan', 'active', '2026-11-03', $3, '2026-10-30T10:00:00Z')`,
        [A, PLAN, endDate],
      );
      await c.query(
        `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
           window_start, window_end, lunch_start, lunch_end, break_minutes, timezone)
         values ($1, $2, '{0,1,2,3,4,5,6}', 4, '09:00', '17:00', '13:00', '14:00', 0, $3)`,
        [A, PLAN, tz],
      );
      await c.query(
        `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
         values ($1, $2, 't1', 'Task', 'course', 6, 0)`,
        [A, PLAN],
      );
    });
  beforeEach(async () => {
    await seed('UTC');
  });

  const headers = async (sub = A) => ({
    authorization: `Bearer ${await keys.sign({ sub, email: sub === A ? 'a@example.com' : 'b@example.com' })}`,
  });
  const put = async (startDate: unknown, sub = A, id = PLAN) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${id}/start-date`,
      headers: await headers(sub),
      payload: { startDate } as object,
    });
  const stored = async () =>
    testDb.admin(
      async (c) =>
        (await c.query(`select start_date::text as d from rnd.plans where id = $1`, [PLAN])).rows[0]
          .d as string,
    );
  const firstBlockDate = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${PLAN}/schedule`,
      headers: await headers(),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { blocks: { date: string }[] }).blocks[0]!.date;
  };

  it('moves the start date and the schedule starts on the new day', async () => {
    expect(await firstBlockDate()).toBe('2026-11-03');
    const res = await put('2026-11-10');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ startDate: '2026-11-10', endDate: null });
    expect(await stored()).toBe('2026-11-10');
    expect(await firstBlockDate()).toBe('2026-11-10');
  });

  it('accepts today, in the plan time zone', async () => {
    expect((await put('2026-11-03')).statusCode).toBe(200);
    await seed('Pacific/Kiritimati');
    expect((await put('2026-11-03')).statusCode).toBe(422); // already the 4th there
    expect((await put('2026-11-04')).statusCode).toBe(200);
  });

  it('rejects a date before today with 422 and stores nothing', async () => {
    const res = await put('2026-11-02');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('2026-11-03');
    expect(await stored()).toBe('2026-11-03');
  });

  it('rejects a date after the end date, and accepts the end date itself', async () => {
    await seed('UTC', '2026-12-01');
    expect((await put('2026-12-02')).statusCode).toBe(422);
    expect(await stored()).toBe('2026-11-03');
    expect((await put('2026-12-01')).statusCode).toBe(200);
  });

  it('rejects a malformed body and unknown fields (never a user id)', async () => {
    expect((await put('soon')).statusCode).toBe(400);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${PLAN}/start-date`,
      headers: await headers(),
      payload: { startDate: '2026-11-10', user_id: B },
    });
    expect(res.statusCode).toBe(400);
    expect(await stored()).toBe('2026-11-03');
  });

  it('answers 404 for another user’s plan and 401 without a token', async () => {
    expect((await put('2026-11-10', B)).statusCode).toBe(404);
    expect(await stored()).toBe('2026-11-03');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/plans/${PLAN}/start-date`,
      payload: { startDate: '2026-11-10' },
    });
    expect(res.statusCode).toBe(401);
  });
});
