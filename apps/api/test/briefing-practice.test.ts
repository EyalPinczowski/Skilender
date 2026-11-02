import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { createBriefingService } from '../src/modules/briefing/service';
import { HttpError } from '../src/errors';
import type { PracticeService } from '../src/modules/practice/service';
import type { SchedulingService } from '../src/modules/scheduling/service';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_A2 = 'a0000000-0000-4000-8000-000000000002';
const PLAN_B = 'b0000000-0000-4000-8000-000000000001';
const S = (n: number) => `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const NOW = new Date('2026-11-02T10:00:00Z');

const BLOCK = (score: string, focus: string) =>
  `Here you go.\n===FEEDBACK===\nscore: ${score}\nstrengths: Clear structure and calm delivery\nimprove: Give numbers\nnext_focus: ${focus}\n===END===`;

type Method = 'GET' | 'POST' | 'PUT';

describe.skipIf(!dbAvailable)('briefing practice prompts (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let clock = NOW;

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
  });

  afterAll(async () => {
    await app?.close();
  });

  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);

  beforeEach(async () => {
    clock = NOW;
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(
        `insert into rnd.allowed_emails (email)
         values ('zed.quill@example.com'), ('b@example.com'), ('c@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email, display_name)
         values ($1, 'zed.quill@example.com', 'Zebediah Quillfeather'),
                ($2, 'b@example.com', null), ($3, 'c@example.com', null)`,
        [A, B, C],
      );
      // C never accepts the terms.
      await acceptCurrentLegal(c, [A, B]);
      const plan = async (user: string, id: string) => {
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
           values ($1, $2, 'builder', 'Plan', 'active', '2026-11-01', '2026-10-30T10:00:00Z')`,
          [user, id],
        );
        await c.query(
          `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
             window_start, window_end, timezone)
           values ($1, $2, '{0,1,2,3,4}', 8, '09:00', '17:00', 'Asia/Jerusalem')`,
          [user, id],
        );
      };
      const task = (
        user: string,
        planId: string,
        id: string,
        order: number,
        o: { type?: string; kind?: string | null; steps?: string[]; est?: number } = {},
      ) =>
        c.query(
          `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order,
             practice_kind, how_to_steps, prompt_template)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
          [
            user,
            planId,
            id,
            `Task ${id}`,
            o.type ?? 'practice',
            o.est ?? 1,
            order,
            o.kind === undefined ? 'mock_interview' : o.kind,
            JSON.stringify(o.steps ?? ['Prepare', 'Answer aloud', 'Review answers', 'Note gaps']),
            'Run a mock interview with me.',
          ],
        );
      await plan(A, PLAN_A);
      await plan(A, PLAN_A2);
      await plan(B, PLAN_B);
      await task(A, PLAN_A, 'p1', 0);
      await task(A, PLAN_A, 'p2', 1);
      await task(A, PLAN_A, 'p3', 2, { kind: 'home_assignment' });
      await task(A, PLAN_A, 'p4', 3, { kind: null, steps: [] });
      await task(A, PLAN_A, 'c1', 4, { type: 'course', kind: null });
      await task(A, PLAN_A2, 'other', 0);
      await task(A, PLAN_A2, 'q1', 1);
      await task(B, PLAN_B, 'p1', 0);
    });
  });

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const asA = () => as(A, 'zed.quill@example.com');
  const asB = () => as(B, 'b@example.com');
  const call = async (
    method: Method,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const callA = async (method: Method, url: string, payload?: unknown) =>
    call(method, url, await asA(), payload);

  const base = `/plans/${PLAN_A}`;
  const briefingUrl = `${base}/days/2026-11-02/briefing`;
  const briefingTasks = async () => {
    const res = await callA('GET', briefingUrl);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().tasks as Record<string, unknown>[];
  };
  const entry = async (id: string) => (await briefingTasks()).find((t) => t.taskId === id)!;
  const start = async (task: string, id: string) => {
    const res = await callA('POST', `${base}/tasks/${task}/practice/sessions`, {
      id,
      channel: 'external',
    });
    expect(res.statusCode).toBe(201);
  };

  it('puts the last same-kind next_focus in the prompt, and no other kind’s', async () => {
    await start('p1', S(1));
    expect(
      (
        await callA('POST', `${base}/practice/sessions/${S(1)}/feedback`, {
          text: BLOCK('6/10', 'FOCUS-ONE use numbers'),
          markDone: false,
        })
      ).statusCode,
    ).toBe(201);
    const same = (await entry('p2')).promptTemplate as string;
    expect(same).toContain('FOCUS-ONE use numbers');
    expect(same).toContain('Run a mock interview with me.');
    const other = (await entry('p3')).promptTemplate as string;
    expect(other).not.toContain('FOCUS-ONE');
    // Same text as the prompt route.
    const route = (await callA('GET', `${base}/tasks/p2/practice/prompt`)).json();
    expect(same).toBe(route.prompt);
  });

  it('keeps the job description out of storage and events, as the prompt route does', async () => {
    await callA('PUT', `${base}/practice/context`, { jobDescription: 'JOBDESC-MARKER backend' });
    const prompt = (await entry('p1')).promptTemplate as string;
    expect(prompt).toBe((await callA('GET', `${base}/tasks/p1/practice/prompt`)).json().prompt);
    await start('p1', S(1));
    expect(
      await rows(
        `select 1 from rnd.practice_sessions where prompt_used like '%JOBDESC-MARKER%'
           or prompt_inputs::text like '%JOBDESC-MARKER%'`,
      ),
    ).toHaveLength(0);
    expect(
      await rows(`select 1 from rnd.events where payload::text like '%JOBDESC-MARKER%'`),
    ).toHaveLength(0);
  });

  it('carries practiceSessionId only while a session is active', async () => {
    expect(await entry('p1')).not.toHaveProperty('practiceSessionId');
    await start('p1', S(1));
    expect((await entry('p1')).practiceSessionId).toBe(S(1));
    expect(await entry('p2')).not.toHaveProperty('practiceSessionId');
    await callA('POST', `${base}/practice/sessions/${S(1)}/abandon`);
    expect(await entry('p1')).not.toHaveProperty('practiceSessionId');
    await start('p1', S(2));
    await callA('POST', `${base}/practice/sessions/${S(2)}/finish`, { markDone: false });
    expect(await entry('p1')).not.toHaveProperty('practiceSessionId');
  });

  it('does not leak another plan’s or another user’s data', async () => {
    // Same kind, other plan of the same user: its next_focus must not reach PLAN_A.
    await callA('PUT', `/plans/${PLAN_A2}/practice/context`, { jobDescription: 'x' });
    const other = await callA('POST', `/plans/${PLAN_A2}/tasks/q1/practice/sessions`, {
      id: S(8),
      channel: 'external',
    });
    expect(other.statusCode).toBe(201);
    await callA('POST', `/plans/${PLAN_A2}/practice/sessions/${S(8)}/feedback`, {
      text: BLOCK('6/10', 'FOCUS-OTHER-PLAN'),
      markDone: false,
    });
    // User B has an active session on PLAN_B/p1 (same task id).
    const b = await call('POST', `/plans/${PLAN_B}/tasks/p1/practice/sessions`, await asB(), {
      id: S(9),
      channel: 'external',
    });
    expect(b.statusCode).toBe(201);
    const p1 = await entry('p1');
    expect(p1.promptTemplate).not.toContain('FOCUS-OTHER-PLAN');
    expect(p1).not.toHaveProperty('practiceSessionId');
  });

  it('puts the job description in the briefing prompt exactly like the prompt route', async () => {
    await callA('PUT', `${base}/practice/context`, { jobDescription: 'JOBDESC-MARKER backend' });
    const prompt = (await entry('p1')).promptTemplate as string;
    expect(prompt).toContain('JOBDESC-MARKER');
    expect(prompt).toBe((await callA('GET', `${base}/tasks/p1/practice/prompt`)).json().prompt);
  });

  it('hides the user’s name in the job description, like the prompt route', async () => {
    // The redactor removes a known name, so the real stack never reaches `pii_blocked` from
    // this input; the 422 `pii_blocked` fallback is covered with a throwing practice service.
    await callA('PUT', `${base}/practice/context`, {
      jobDescription: 'Contact Zebediah Quillfeather about the role',
    });
    const route = await callA('GET', `${base}/tasks/p1/practice/prompt`);
    expect(route.statusCode).toBe(200);
    const p1 = await entry('p1');
    expect(p1.promptTemplate).toBe(route.json().prompt);
    expect(p1.promptTemplate).not.toContain('Quillfeather');
  });

  it('keeps the stored template and no session id on a past day', async () => {
    await start('p1', S(1));
    const res = await callA('GET', `${base}/days/2026-11-01/briefing`);
    expect(res.statusCode, res.body).toBe(200);
    for (const t of res.json().tasks as Record<string, unknown>[]) {
      expect(t).not.toHaveProperty('practiceSessionId');
      if (t.type === 'practice') expect(t.promptTemplate).toBe('Run a mock interview with me.');
    }
  });

  it('leaves non-practice tasks untouched', async () => {
    const c1 = await entry('c1');
    expect(c1.promptTemplate).toBe('Run a mock interview with me.'); // its own template, not a built prompt
    expect(c1).not.toHaveProperty('practiceSessionId');
  });

  it('writes nothing and calls no model', async () => {
    await briefingTasks(); // brings missed days up to date first (own events)
    const before = await rows(`select count(*)::int as n from rnd.events`);
    await briefingTasks();
    expect(await rows(`select count(*)::int as n from rnd.events`)).toEqual(before);
    expect(await rows(`select 1 from rnd.practice_sessions`)).toHaveLength(0);
  });
});

describe('briefing service (no database)', () => {
  const task = (id: string, type: string, promptTemplate?: string) => ({
    id,
    title: id,
    type,
    estHours: 1,
    doneHours: 0,
    status: 'pending',
    order: 0,
    howToSteps: [],
    lessons: [],
    prerequisites: [],
    ...(promptTemplate ? { promptTemplate } : {}),
  });
  const day = (tasks: ReturnType<typeof task>[]) => ({
    date: '2026-11-02',
    blocks: tasks.map((t, i) => ({
      taskId: t.id,
      date: '2026-11-02',
      start: `${String(9 + i).padStart(2, '0')}:00`,
      end: `${String(9 + i).padStart(2, '0')}:30`,
      minutes: 30,
    })),
    tasks,
    earlierBlocks: [],
    pattern: {
      studyWeekdays: [0, 1, 2, 3, 4],
      defaultHours: 2,
      windowStart: '09:00',
      windowEnd: '17:00',
      timezone: 'Asia/Jerusalem',
    },
    overrides: [],
    warnings: [],
    finishDate: null,
    skillIds: [],
  });
  const scheduling = (tasks: ReturnType<typeof task>[]) =>
    ({ dayPlan: async () => day(tasks) }) as unknown as SchedulingService;
  const logged: Record<string, unknown>[] = [];
  const log = { warn: (obj: Record<string, unknown>) => void logged.push(obj) };
  const practiceOf = (fn: () => Promise<unknown>) =>
    ({ briefingEntry: fn }) as unknown as PracticeService;

  it('is identical for a plan without practices and never asks the practice service', async () => {
    const tasks = [task('c1', 'course'), task('a1', 'admin')];
    let calls = 0;
    const withPractice = createBriefingService(
      scheduling(tasks),
      practiceOf(async () => {
        calls += 1;
        return { prompt: 'x', practiceSessionId: null };
      }),
      () => NOW,
    );
    const plain = createBriefingService(scheduling(tasks));
    const a = await withPractice.get('u', 'p', '2026-11-02');
    expect(a).toEqual(await plain.get('u', 'p', '2026-11-02'));
    expect(calls).toBe(0);
    expect(a.tasks.every((t) => !('practiceSessionId' in t))).toBe(true);
  });

  it('falls back to the template when the practice service throws', async () => {
    const tasks = [task('p1', 'practice', 'MY TEMPLATE'), task('p2', 'practice')];
    const service = createBriefingService(
      scheduling(tasks),
      practiceOf(async () => {
        throw new Error('boom SECRET-TEXT');
      }),
      () => NOW,
      log,
    );
    const b = await service.get('u', 'p', '2026-11-02');
    expect(b.tasks.map((t) => t.promptTemplate)).toEqual(['MY TEMPLATE', null]);
    expect(b.tasks.every((t) => !('practiceSessionId' in t))).toBe(true);
    expect(b).toEqual(await createBriefingService(scheduling(tasks)).get('u', 'p', '2026-11-02'));
    // Unexpected errors are logged by class only, never their message.
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('SECRET-TEXT');
    expect(logged[0]).toMatchObject({ errorClass: 'Error' });
  });

  it('falls back silently on an expected 404 or 422', async () => {
    logged.length = 0;
    const tasks = [task('p1', 'practice', 'MY TEMPLATE')];
    for (const e of [
      new HttpError(404, 'not_found', 'x'),
      new HttpError(422, 'pii_blocked', 'x'),
    ]) {
      const service = createBriefingService(
        scheduling(tasks),
        practiceOf(async () => {
          throw e;
        }),
        () => NOW,
        log,
      );
      const b = await service.get('u', 'p', '2026-11-02');
      expect(b.tasks[0]!.promptTemplate).toBe('MY TEMPLATE');
    }
    expect(logged).toHaveLength(0);
  });

  it('does not ask the practice service for a day other than today', async () => {
    let calls = 0;
    const tasks = [task('p1', 'practice', 'MY TEMPLATE')];
    const service = createBriefingService(
      scheduling(tasks),
      practiceOf(async () => {
        calls += 1;
        return { prompt: 'x', practiceSessionId: null };
      }),
      () => new Date('2026-11-03T10:00:00Z'),
    );
    const b = await service.get('u', 'p', '2026-11-02');
    expect(calls).toBe(0);
    expect(b.tasks[0]!.promptTemplate).toBe('MY TEMPLATE');
  });
});
