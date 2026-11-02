import { beforeAll, describe, expect, it } from 'vitest';
import {
  ENVS,
  TEST_DATABASE_URL,
  asUser,
  dbAvailable,
  prepareEnvironments,
  withClient,
  type TestEnvironments,
} from './helpers';

// Migration 0011 (calendar): behaviour the generic per-table tests in data-model.test.ts do not
// cover (constraints, uniqueness, column grants, cascade). Runs on both schemas.

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'b0000000-0000-4000-8000-000000000002';
const CHECK = /violates check constraint/;
const UNIQUE = /duplicate key value/;
const NO_PRIVILEGE = /permission denied for table/;
const TABLES = [
  'calendar_connections',
  'calendar_oauth_states',
  'calendar_event_links',
  'calendar_locked_blocks',
  'calendar_busy',
  'calendar_sources',
];

for (const schema of ENVS) {
  describe.skipIf(!dbAvailable)(`calendar tables (${schema})`, () => {
    const s = schema;
    let env: TestEnvironments;

    /** Runs the statements as the signed-in user (null: no claims) in a rolled-back transaction. */
    const as = <T>(
      sub: string | null,
      work: (q: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>,
    ) =>
      withClient(env.appUrl(s), (client) =>
        asUser(client, s, sub, () => work((sql) => client.query(sql))),
      );

    const link = (user: string, plan: string, key: string, event = 'ev') =>
      `insert into ${s}.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
       values ('${user}', '${plan}', '${key}', 't1', '${event}', '2026-01-05 09:00+00', '2026-01-05 10:00+00')`;
    const lock = (
      user: string,
      plan: string,
      key: string,
      from: string,
      to: string,
      reason: string,
    ) =>
      `insert into ${s}.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
       values ('${user}', '${plan}', '${key}', 't1', '${from}', '${to}', '${reason}')`;
    const busy = (
      user: string,
      ext: string,
      date: string,
      from: number,
      to: number,
      kind: string,
    ) =>
      `insert into ${s}.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, kind)
       values ('${user}', '${date}', '${ext}', 'cal', ${from}, ${to}, '${kind}')`;
    const state = (user: string, hash: string, expires: string) =>
      `insert into ${s}.calendar_oauth_states (user_id, state_hash, pkce_verifier_ciphertext, expires_at)
       values ('${user}', '${hash}', 'ct', ${expires})`;

    beforeAll(async () => {
      env = await prepareEnvironments();
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        await client.query(`set local role owner_${s}`);
        await client.query(`
          insert into ${s}.app_users (id, email) values
            ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
          insert into ${s}.plans (user_id, id, created_from, name, start_date) values
            ('${USER_A}', '${PLAN_A}', 'builder', 'Plan A', '2026-01-01'),
            ('${USER_B}', '${PLAN_B}', 'import', 'Plan B', '2026-01-01');
          insert into ${s}.calendar_connections (user_id) values ('${USER_A}');
          ${state(USER_A, 'a'.repeat(64), `now() + interval '10 minutes'`)};
          ${link(USER_A, PLAN_A, 'k1', 'ev1')};
          ${lock(USER_A, PLAN_A, 'k1', '2026-01-05 09:00+00', '2026-01-05 10:00+00', 'moved')};
          ${busy(USER_A, 'x1', '2026-01-05', 60, 120, 'busy')};
          insert into ${s}.calendar_sources (user_id, calendar_id) values ('${USER_A}', 'cal');
        `);
        await client.query('commit');
      });
    });

    it('fills the documented defaults', async () => {
      await as(USER_A, async (q) => {
        const conn = await q(
          `select provider, status, granted_scopes from ${s}.calendar_connections`,
        );
        expect(conn.rows[0]).toEqual({
          provider: 'google',
          status: 'connected',
          granted_scopes: [],
        });
        expect((await q(`select blocks_time from ${s}.calendar_sources`)).rows[0]).toEqual({
          blocks_time: false,
        });
        expect((await q(`select blocks_day from ${s}.calendar_busy`)).rows[0]).toEqual({
          blocks_day: false,
        });
      });
    });

    it.each([
      [
        'unknown connection status',
        `insert into ${s}.calendar_connections (user_id, status) values ('${USER_B}', 'bogus')`,
      ],
      [
        'unknown provider',
        `insert into ${s}.calendar_connections (user_id, provider) values ('${USER_B}', 'outlook')`,
      ],
      [
        'unknown lock reason',
        lock(USER_B, PLAN_B, 'k', '2026-01-05 09:00+00', '2026-01-05 10:00+00', 'gone'),
      ],
      [
        'lock ends before it starts',
        lock(USER_B, PLAN_B, 'k', '2026-01-05 10:00+00', '2026-01-05 09:00+00', 'moved'),
      ],
      [
        'link with an empty range',
        `insert into ${s}.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
         values ('${USER_B}', '${PLAN_B}', 'k', 't', 'e', '2026-01-05 10:00+00', '2026-01-05 10:00+00')`,
      ],
      [
        'negative generation',
        `insert into ${s}.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, generation, last_start, last_end)
         values ('${USER_B}', '${PLAN_B}', 'k', 't', 'e', -1, '2026-01-05 09:00+00', '2026-01-05 10:00+00')`,
      ],
      ['unknown busy kind', busy(USER_B, 'x', '2026-01-05', 0, 60, 'free')],
      ['busy end after midnight', busy(USER_B, 'x', '2026-01-05', 0, 1441, 'busy')],
      ['busy with an empty range', busy(USER_B, 'x', '2026-01-05', 60, 60, 'busy')],
      ['state already expired', state(USER_B, 'b'.repeat(64), `now() - interval '1 minute'`)],
    ])('rejects bad values: %s', async (_name, sql) => {
      await expect(as(USER_B, (q) => q(sql))).rejects.toThrow(CHECK);
    });

    it('keeps one connection per user, one link and one lock per plan block, one busy row per event and date', async () => {
      await expect(
        as(USER_A, (q) =>
          q(`insert into ${s}.calendar_connections (user_id) values ('${USER_A}')`),
        ),
      ).rejects.toThrow(UNIQUE);
      await expect(as(USER_A, (q) => q(link(USER_A, PLAN_A, 'k1', 'ev2')))).rejects.toThrow(UNIQUE);
      await expect(
        as(USER_A, (q) =>
          q(lock(USER_A, PLAN_A, 'k1', '2026-01-05 09:00+00', '2026-01-05 10:00+00', 'deleted')),
        ),
      ).rejects.toThrow(UNIQUE);
      await expect(
        as(USER_A, (q) => q(busy(USER_A, 'x1', '2026-01-05', 0, 30, 'busy'))),
      ).rejects.toThrow(UNIQUE);
      // The same external event on another date is a different row.
      await as(USER_A, (q) => q(busy(USER_A, 'x1', '2026-01-06', 0, 1440, 'all_day')));
    });

    it('keeps a state hash unique across users', async () => {
      await expect(
        as(USER_B, (q) => q(state(USER_B, 'a'.repeat(64), `now() + interval '10 minutes'`))),
      ).rejects.toThrow(UNIQUE);
    });

    it('has no column that could hold an event description or attendees', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        const { rows } = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = $1 and table_name = any($2)
              and column_name ~* '(descr|attendee|guest|organizer|location|body|note)'`,
          [s, TABLES],
        );
        expect(rows).toEqual([]);
      });
    });

    it('lets the app change working columns only, never the owner or the keys', async () => {
      for (const sql of [
        `update ${s}.calendar_connections set user_id = '${USER_B}'`,
        `update ${s}.calendar_connections set provider = 'google'`,
        `update ${s}.calendar_oauth_states set expires_at = now()`,
        `update ${s}.calendar_event_links set block_key = 'zz'`,
        `update ${s}.calendar_event_links set plan_id = '${PLAN_B}'`,
        `update ${s}.calendar_locked_blocks set block_key = 'zz'`,
        `update ${s}.calendar_busy set date = '2026-02-02'`,
        `update ${s}.calendar_busy set external_event_id = 'zz'`,
        `update ${s}.calendar_sources set calendar_id = 'zz'`,
      ]) {
        await expect(
          as(USER_A, (q) => q(sql)),
          sql,
        ).rejects.toThrow(NO_PRIVILEGE);
      }
      await as(USER_A, (q) =>
        q(
          `update ${s}.calendar_connections set status = 'needs_reconnect', last_error_code = 'invalid_grant'`,
        ),
      );
    });

    it('has no UPDATE policy on calendar_oauth_states for the app role', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        const { rows } = await client.query<{ polcmd: string }>(
          `select p.polcmd from pg_policy p
            where p.polrelid = $1::regclass and $2::regrole::oid = any (p.polroles)
            order by 1`,
          [`${s}.calendar_oauth_states`, `app_${s}_user`],
        );
        expect(rows.map((r) => r.polcmd)).toEqual(['a', 'd', 'r']);
      });
    });

    it('rejects a link on another user’s plan', async () => {
      await expect(as(USER_A, (q) => q(link(USER_A, PLAN_B, 'k9')))).rejects.toThrow(
        /violates foreign key constraint/,
      );
    });

    it('removes links and locks with their plan, and every calendar row with the user', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        const countOf = async (t: string, where = 'true') =>
          (await client.query(`select count(*)::int as n from ${s}.${t} where ${where}`)).rows[0]
            .n as number;

        await client.query('begin');
        try {
          await client.query(`set local role owner_${s}`);
          await client.query(`delete from ${s}.plans where id = '${PLAN_A}'`);
          for (const t of ['calendar_event_links', 'calendar_locked_blocks']) {
            expect(await countOf(t), t).toBe(0);
          }
        } finally {
          await client.query('rollback');
        }

        await client.query('begin');
        try {
          await client.query(`set local role owner_${s}`);
          for (const t of TABLES) {
            expect(await countOf(t, `user_id = '${USER_A}'`), `${t} seeded`).toBeGreaterThan(0);
          }
          await client.query(`delete from ${s}.app_users where id = '${USER_A}'`);
          for (const t of TABLES) {
            expect(await countOf(t, `user_id = '${USER_A}'`), t).toBe(0);
          }
        } finally {
          await client.query('rollback');
        }
      });
    });

    it('returns nothing without a user context', async () => {
      for (const t of TABLES) {
        await as(null, async (q) => {
          const res = await q(`select count(*)::int as n from ${s}.${t}`);
          expect(res.rows[0]!.n, t).toBe(0);
        });
      }
    });
  });
}
