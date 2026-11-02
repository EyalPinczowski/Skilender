import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ProviderQuotaError, ProviderUnavailableError, type AIProvider } from '../src/ai/provider';
import type { SafeAIRequest } from '../src/ai/safe-request';
import { loadConfig } from '../src/config';
import { createDatabase, type Database } from '../src/db/database';
import { stalePendingMs } from '../src/modules/practice/service';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'b0000000-0000-4000-8000-000000000001';
const S = (n: number) => `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const M = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const GOOD_JSON = JSON.stringify({
  score: 8,
  strengths: 'Clear structure.',
  improve: 'Add numbers.',
  next_focus: 'Quantify results.',
});

type Responder = (request: SafeAIRequest, call: number) => string | Promise<string>;
interface Seen {
  provider: string;
  request: SafeAIRequest;
}

describe.skipIf(!dbAvailable)('practice chat with a fake provider (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let seen: Seen[];
  let clock = new Date();

  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
  });

  const makeProvider = (
    id: string,
    respond: Responder,
    model: string | undefined = 'fake-1',
  ): AIProvider => {
    let calls = 0;
    return {
      id,
      label: `Label ${id}`,
      costTier: 'free',
      maxContextChars: 12_000,
      async generate(request) {
        calls += 1;
        seen.push({ provider: id, request });
        const text = await respond(request, calls);
        return { text, ...(model ? { model } : {}) };
      },
    };
  };

  /** Rebuilds the app so provider cooldowns and rate-limit windows start clean. */
  const start = async (
    providers: AIProvider[],
    env: Record<string, string> = {},
    database: Database = db,
  ): Promise<ReturnType<typeof buildApp>> => {
    const ai = loadConfig({
      APP_ENV: 'rnd',
      AI_PROVIDERS: providers.map((p) => p.id).join(','),
      AI_BUDGET_GROQ_DAILY: '1000',
      AI_BUDGET_CLOUDFLARE_AI_DAILY: '1000',
      ...env,
    }).ai;
    const built = buildApp(testConfig({ appEnv: 'rnd', ai, rateLimitPerMinute: 100_000 }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db: database,
      now: () => clock,
      ai: { providers },
    });
    await built.ready();
    app = built;
    return built;
  };

  beforeEach(async () => {
    seen = [];
    clock = new Date();
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query('delete from rnd.ai_provider_usage');
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
      await acceptCurrentLegal(c, [A, B]);
      for (const [user, plan] of [
        [A, PLAN_A],
        [B, PLAN_B],
      ] as const) {
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
           values ($1, $2, 'builder', 'Plan', 'active', '2026-11-01', '2026-10-30T10:00:00Z')`,
          [user, plan],
        );
        await c.query(
          `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
             window_start, window_end, timezone)
           values ($1, $2, '{0,1,2,3,4}', 2, '09:00', '17:00', 'Asia/Jerusalem')`,
          [user, plan],
        );
        for (const [i, id] of ['p1', 'p2'].entries()) {
          await c.query(
            `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order,
               practice_kind, how_to_steps, prompt_template)
             values ($1, $2, $3, $4, 'practice', 1, $5, 'mock_interview', $6::jsonb, $7)`,
            [
              user,
              plan,
              id,
              `Task ${id}`,
              i,
              JSON.stringify(['Introduce yourself', 'Answer aloud']),
              'Run a mock interview with me.',
            ],
          );
        }
      }
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const call = async (
    method: 'GET' | 'POST',
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
  const callA = async (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    call(method, url, await as(A, 'zed.quill@example.com'), payload);

  const base = `/plans/${PLAN_A}`;
  const sessionUrl = (id: string, tail = '') => `${base}/practice/sessions/${id}${tail}`;
  const open = async (id = S(1), task = 'p1', channel = 'in_app') => {
    const res = await callA('POST', `${base}/tasks/${task}/practice/sessions`, { id, channel });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  const say = (session: string, id: string, content: string) =>
    callA('POST', sessionUrl(session, '/messages'), { id, content });
  const pendingOf = async (session = S(1)) =>
    (
      await rows<{ pending_turn_id: string | null; pending_since: Date | null }>(
        `select pending_turn_id, pending_since from rnd.practice_sessions where id = $1`,
        [session],
      )
    )[0]!;
  const taskStatus = async (id: string) =>
    (
      await rows<{ status: string }>(
        `select status from rnd.tasks where plan_id = $1 and id = $2`,
        [PLAN_A, id],
      )
    )[0]!.status;
  const finishAi = (session = S(1), extra: Record<string, unknown> = {}) =>
    callA('POST', sessionUrl(session, '/finish'), { markDone: false, aiFeedback: true, ...extra });

  // -------------------------------------------------------------------------------------------

  it('runs a whole in-app session: opener, turns, AI feedback saved, task done only with markDone', async () => {
    await start([
      makeProvider('groq', (req) => (req.json ? GOOD_JSON : 'Tell me about a time you led.')),
    ]);
    const created = await open();
    expect(created.session.channel).toBe('in_app');
    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]).toMatchObject({ role: 'assistant', providerId: null, seq: 0 });
    expect(seen).toHaveLength(0); // the opener is deterministic

    const turn = await say(S(1), M(1), 'I led a small team last year.');
    expect(turn.statusCode).toBe(201);
    expect(turn.json()).toMatchObject({
      userMessage: { role: 'user', redacted: false },
      reply: { content: 'Tell me about a time you led.', providerId: 'groq', model: 'fake-1' },
      switched: null,
      usage: { used: 1 },
      replayed: false,
    });
    expect((await pendingOf()).pending_turn_id).toBeNull();

    // Asking for feedback alone never closes the task.
    const kept = await finishAi(S(1));
    expect(kept.statusCode).toBe(201);
    expect(kept.json().feedback).toMatchObject({ source: 'model_json', score: 8 });
    expect(kept.json().task.status).not.toBe('done');
    expect(await taskStatus('p1')).not.toBe('done');

    // A second session, this time with markDone.
    const second = await open(S(2), 'p2');
    expect(second.messages).toHaveLength(1);
    await say(S(2), M(2), 'Another answer.');
    const done = await finishAi(S(2), { markDone: true });
    expect(done.statusCode).toBe(201);
    expect(done.json().task.status).toBe('done');
    expect(await taskStatus('p2')).toBe('done');
    const detail = (await callA('GET', sessionUrl(S(2)))).json();
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ]);
    expect(detail.feedback.source).toBe('model_json');

    // Events carry no text.
    const events = await rows<{ payload: Record<string, unknown> }>(
      `select payload from rnd.events where type like 'practice.%'`,
    );
    expect(JSON.stringify(events)).not.toContain('Another answer');
  });

  it('continues on the fallback with the full transcript when the primary hits its limit', async () => {
    await start([
      makeProvider('groq', (_req, n) => {
        if (n >= 2) throw new ProviderQuotaError();
        return 'First question from the primary.';
      }),
      makeProvider('cloudflare-ai', () => 'Second question from the fallback.'),
    ]);
    await open();
    expect((await say(S(1), M(1), 'My first answer.')).json().switched).toBeNull();
    const second = await say(S(1), M(2), 'My second answer.');
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({
      reply: { providerId: 'cloudflare-ai' },
      switched: {
        from: 'groq',
        to: 'cloudflare-ai',
        reason: 'quota',
        toLabel: 'Label cloudflare-ai',
      },
    });
    const last = seen[seen.length - 1]!;
    expect(last.provider).toBe('cloudflare-ai');
    expect(last.request.messages.map((m) => m.content)).toEqual([
      'My first answer.',
      'First question from the primary.',
      'My second answer.',
    ]);
    // The switch is recorded as a note, which the model never sees.
    const roles = (await callA('GET', sessionUrl(S(1))))
      .json()
      .messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['assistant', 'user', 'assistant', 'user', 'note', 'assistant']);
    expect(
      (
        await rows<{ providers_used: string[] }>(`select providers_used from rnd.practice_sessions`)
      )[0]!.providers_used,
    ).toEqual(['groq', 'cloudflare-ai']);
  });

  describe('AI feedback pipeline', () => {
    const run = async (responses: string[]) => {
      let json = 0;
      await start([
        makeProvider('groq', (req) => {
          if (!req.json) return 'A question.';
          const text = responses[Math.min(json, responses.length - 1)]!;
          json += 1;
          return text;
        }),
      ]);
      await open();
      await say(S(1), M(1), 'An answer.');
      seen = [];
      const res = await finishAi();
      return { res, jsonCalls: json };
    };

    it('repairs broken JSON locally without a second call', async () => {
      const { res, jsonCalls } = await run([
        "```json\n{score: '7/10', strengths: 'Good', improve: 'More detail', nextFocus: 'Depth',}\n```",
      ]);
      expect(res.statusCode).toBe(201);
      expect(res.json().feedback).toMatchObject({
        source: 'model_repaired',
        score: 7,
        nextFocus: 'Depth',
      });
      expect(jsonCalls).toBe(1);
    });

    it('retries garbage once, then keeps the text as free text', async () => {
      const { res, jsonCalls } = await run(['I cannot do that, sorry.']);
      expect(res.statusCode).toBe(201);
      expect(res.json().feedback).toMatchObject({
        source: 'free_text',
        score: null,
        raw: 'I cannot do that, sorry.',
      });
      expect(jsonCalls).toBe(2);
      expect(seen[1]!.request.messages.at(-1)!.content).toContain('Return only valid JSON');
      // The retry is counted against the user's feedback calls.
      const used = await rows<{ requests: number }>(
        `select requests from rnd.ai_usage_daily where purpose = 'practice_feedback'`,
      );
      expect(used[0]!.requests).toBe(2);
    });

    it('accepts valid JSON on the retry', async () => {
      const { res, jsonCalls } = await run(['nope', GOOD_JSON]);
      expect(res.json().feedback).toMatchObject({ source: 'model_json', score: 8 });
      expect(jsonCalls).toBe(2);
    });

    it('skips the retry at the cap and still finishes with free text', async () => {
      await start([makeProvider('groq', (req) => (req.json ? 'garbage' : 'Q?'))], {
        AI_USER_DAILY_PRACTICE_FEEDBACK: '1',
      });
      await open();
      await say(S(1), M(1), 'An answer.');
      seen = [];
      const res = await finishAi();
      expect(res.statusCode).toBe(201);
      expect(res.json().feedback.source).toBe('free_text');
      expect(seen).toHaveLength(1);
    });

    it('answers 503 with fallbacks when the model fails, and the session stays open', async () => {
      await start([
        makeProvider('groq', (req) => {
          if (req.json) throw new ProviderUnavailableError();
          return 'Q?';
        }),
      ]);
      await open();
      await say(S(1), M(1), 'An answer.');
      const res = await finishAi();
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        code: 'ai_unavailable',
        fallbacks: ['copy_prompt', 'self_rubric'],
      });
      expect((await pendingOf()).pending_turn_id).toBeNull();
      const status = (await callA('GET', sessionUrl(S(1)))).json().session.status;
      expect(status).toBe('active');
      // The rubric still finishes it.
      const rubric = await callA('POST', sessionUrl(S(1), '/finish'), {
        markDone: false,
        rubric: { checkedSteps: [0] },
      });
      expect(rubric.statusCode).toBe(201);
      expect(rubric.json().feedback.source).toBe('self_rubric');
    });

    it('replays an identical AI finish without another model call', async () => {
      await start([makeProvider('groq', (req) => (req.json ? GOOD_JSON : 'Q?'))]);
      await open();
      await say(S(1), M(1), 'An answer.');
      expect((await finishAi()).statusCode).toBe(201);
      seen = [];
      const again = await finishAi();
      expect(again.statusCode).toBe(200);
      expect(again.json().replayed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('refuses AI feedback before the user has said anything, and on other channels', async () => {
      await start([makeProvider('groq', () => GOOD_JSON)]);
      await open();
      expect((await finishAi()).statusCode).toBe(422);
      await open(S(3), 'p2', 'self');
      expect((await finishAi(S(3))).statusCode).toBe(422);
      expect(seen).toHaveLength(0);
      const both = await finishAi(S(1), { rubric: { checkedSteps: [0] } });
      expect(both.statusCode).toBe(400);
    });
  });

  describe('turn handling', () => {
    it('sends the same message id twice with one provider call', async () => {
      await start([makeProvider('groq', () => 'Only once.')]);
      await open();
      const first = await say(S(1), M(1), 'Hello there.');
      const again = await say(S(1), M(1), 'Hello there.');
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ replayed: true, reply: first.json().reply });
      expect(seen).toHaveLength(1);
      // One id with other text is a conflict, not a second turn.
      expect((await say(S(1), M(1), 'Something else.')).statusCode).toBe(409);
      expect(seen).toHaveLength(1);
      const used = await rows<{ requests: number }>(`select requests from rnd.ai_usage_daily`);
      expect(used[0]!.requests).toBe(1);
    });

    it('answers 409 to a second turn while one is being answered', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await start([
        makeProvider('groq', async () => {
          await gate;
          return 'Slow answer.';
        }),
      ]);
      await open();
      const slow = say(S(1), M(1), 'First.');
      // Wait until the first turn is marked pending (its transaction has committed).
      for (let i = 0; i < 100 && (await pendingOf()).pending_turn_id === null; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const blocked = await say(S(1), M(2), 'Second.');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('turn_in_progress');
      // The AI finish waits its turn too.
      expect((await finishAi()).statusCode).toBe(409);
      release();
      expect((await slow).statusCode).toBe(201);
      expect((await pendingOf()).pending_turn_id).toBeNull();
      expect((await say(S(1), M(2), 'Second.')).statusCode).toBe(201);
      expect(seen).toHaveLength(2);
    });

    it('recovers from a stale pending turn but not from a fresh one', async () => {
      await start([makeProvider('groq', () => 'Fine.')]);
      await open();
      await rows(
        `update rnd.practice_sessions set pending_turn_id = $1, pending_since = $2 where id = $3`,
        [S(9), new Date(clock.getTime() - 10_000), S(1)],
      ).catch(() => undefined);
      expect((await say(S(1), M(1), 'Hello.')).statusCode).toBe(409);
      await testDb.admin((c) =>
        c.query(`update rnd.practice_sessions set pending_since = $1 where id = $2`, [
          new Date(clock.getTime() - 120_000),
          S(1),
        ]),
      );
      expect((await say(S(1), M(1), 'Hello.')).statusCode).toBe(201);
      expect((await pendingOf()).pending_turn_id).toBeNull();
    });

    it('clears the pending turn after a provider failure, keeps the message and retries by id', async () => {
      let failing = true;
      await start([
        makeProvider('groq', () => {
          if (failing) throw new Error('sk-SECRET-KEY upstream said no');
          return 'Back again.';
        }),
      ]);
      await open();
      const failed = await say(S(1), M(1), 'Are you there?');
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error).toMatchObject({
        code: 'ai_unavailable',
        fallbacks: ['copy_prompt', 'self_rubric'],
      });
      expect(JSON.stringify(failed.json())).not.toContain('SECRET');
      expect((await pendingOf()).pending_turn_id).toBeNull();
      const stored = await rows<{ role: string }>(
        `select role from rnd.practice_messages order by seq`,
      );
      expect(stored.map((r) => r.role)).toEqual(['assistant', 'user']);

      // The provider is in cooldown for the gateway; a new app clears that, the id retries.
      failing = false;
      await app.close();
      await start([makeProvider('groq', () => 'Back again.')]);
      const retry = await say(S(1), M(1), 'Are you there?');
      expect(retry.statusCode).toBe(201);
      expect(retry.json().reply.content).toBe('Back again.');
      const after = await rows<{ role: string }>(
        `select role from rnd.practice_messages order by seq`,
      );
      expect(after.map((r) => r.role)).toEqual(['assistant', 'user', 'assistant']);
    });

    it('answers 429 with fallbacks at the daily cap, for that user only', async () => {
      await start([makeProvider('groq', () => 'Ok.')], { AI_USER_DAILY_PRACTICE_MESSAGES: '2' });
      await open();
      expect((await say(S(1), M(1), 'One.')).statusCode).toBe(201);
      expect((await say(S(1), M(2), 'Two.')).statusCode).toBe(201);
      const capped = await say(S(1), M(3), 'Three.');
      expect(capped.statusCode).toBe(429);
      expect(capped.json().error).toMatchObject({
        code: 'ai_user_cap',
        fallbacks: ['copy_prompt', 'self_rubric'],
      });
      expect(seen).toHaveLength(2);
      expect((await pendingOf()).pending_turn_id).toBeNull();
      // Nothing was stored for the refused turn; a session of the other kind still works.
      expect((await rows(`select 1 from rnd.practice_messages where id = $1`, [M(3)])).length).toBe(
        0,
      );
      const other = await call(
        'POST',
        `/plans/${PLAN_B}/tasks/p1/practice/sessions`,
        await as(B, 'b@example.com'),
        { id: S(7), channel: 'in_app' },
      );
      expect(other.statusCode).toBe(201);
      const b = await call(
        'POST',
        `/plans/${PLAN_B}/practice/sessions/${S(7)}/messages`,
        await as(B, 'b@example.com'),
        { id: M(7), content: 'Hi' },
      );
      expect(b.statusCode).toBe(201);
    });

    it('limits chat turns per user per minute', async () => {
      await start([makeProvider('groq', () => 'Ok.')], { AI_USER_DAILY_PRACTICE_MESSAGES: '100' });
      await open();
      let last = 0;
      for (let i = 1; i <= 21; i += 1) {
        last = (await say(S(1), M(i), `Turn ${i}.`)).statusCode;
        if (i <= 20) expect(last).toBe(201);
      }
      expect(last).toBe(429);
      expect(seen).toHaveLength(20);
    });

    it('only returns a model name that looks like a plain slug', async () => {
      await start([makeProvider('groq', () => 'Hi.', 'bad model <script>alert(1)</script>')]);
      await open();
      const res = await say(S(1), M(1), 'Hello.');
      expect(res.statusCode).toBe(201);
      expect(res.json().reply.model).toBeNull();
      expect(JSON.stringify(res.json())).not.toContain('<script>');
    });
  });

  describe('personal details', () => {
    it('never lets the user’s name, email, phone or links reach a provider', async () => {
      await start([makeProvider('groq', (req) => (req.json ? GOOD_JSON : 'Understood.'))]);
      await open();
      const text =
        'I am Zebediah Quillfeather, mail zed.quill@example.com, call +1 415 555 0132, see https://me.example.org/cv.';
      const res = await say(S(1), M(1), text);
      expect(res.statusCode).toBe(201);
      expect(res.json().userMessage.redacted).toBe(true);
      await say(S(1), M(2), 'And my handle is zed.quill, thanks.');
      expect((await finishAi()).statusCode).toBe(201);

      const everything = JSON.stringify(
        seen.map((s) => ({ system: s.request.system, messages: s.request.messages })),
      );
      expect(seen.length).toBeGreaterThanOrEqual(3);
      for (const secret of [
        'Zebediah',
        'Quillfeather',
        'zed.quill',
        'example.com',
        '555 0132',
        'me.example.org',
      ]) {
        expect(everything, secret).not.toContain(secret);
      }
      expect(everything).toContain('[removed]');
      const stored = await rows<{ content: string }>(
        `select content from rnd.practice_messages where role = 'user'`,
      );
      expect(JSON.stringify(stored)).not.toContain('Zebediah');
    });
  });

  describe('access and availability', () => {
    it('answers 404 for another user’s session on the new routes', async () => {
      await start([makeProvider('groq', () => 'Hi.')]);
      await open();
      const b = await as(B, 'b@example.com');
      expect(
        (await call('POST', sessionUrl(S(1), '/messages'), b, { id: M(1), content: 'Hi' }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await call('POST', sessionUrl(S(1), '/finish'), b, {
            markDone: false,
            aiFeedback: true,
          })
        ).statusCode,
      ).toBe(404);
      const own = `/plans/${PLAN_B}/practice/sessions/${S(1)}/messages`;
      expect((await call('POST', own, b, { id: M(1), content: 'Hi' })).statusCode).toBe(404);
      expect(seen).toHaveLength(0);
    });

    it('refuses the new route until the terms are accepted, and rejects NUL and extra fields', async () => {
      await start([makeProvider('groq', () => 'Hi.')]);
      await open();
      const c = await as(C, 'c@example.com');
      const blocked = await call('POST', sessionUrl(S(1), '/messages'), c, {});
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('terms_not_accepted');
      expect((await say(S(1), M(1), 'a\u0000b')).statusCode).toBe(422);
      const extra = await callA('POST', sessionUrl(S(1), '/messages'), {
        id: M(1),
        content: 'x',
        userId: B,
      });
      expect(extra.statusCode).toBe(400);
      expect((await say(S(1), 'not-a-uuid', 'x')).statusCode).toBe(400);
      expect(seen).toHaveLength(0);
    });

    it('refuses chat turns on external and self sessions', async () => {
      await start([makeProvider('groq', () => 'Hi.')]);
      await open(S(1), 'p1', 'external');
      expect((await say(S(1), M(1), 'Hi')).statusCode).toBe(422);
    });

    it('with no model: in-app is 503 with fallbacks, and the other channels work', async () => {
      await start([]);
      const refused = await callA('POST', `${base}/tasks/p1/practice/sessions`, {
        id: S(1),
        channel: 'in_app',
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error).toMatchObject({
        code: 'ai_unavailable',
        fallbacks: ['copy_prompt', 'self_rubric'],
      });
      expect(await rows(`select 1 from rnd.practice_sessions`)).toHaveLength(0);

      const ext = await open(S(2), 'p1', 'external');
      expect(ext.messages).toEqual([]);
      const paste = await callA('POST', sessionUrl(S(2), '/feedback'), { text: 'plain notes' });
      expect(paste.statusCode).toBe(201);
      await open(S(3), 'p2', 'self');
      const rubric = await callA('POST', sessionUrl(S(3), '/finish'), {
        markDone: true,
        rubric: { checkedSteps: [0, 1] },
      });
      expect(rubric.statusCode).toBe(201);
    });

    it('with the model gone mid-session: turns and AI feedback are 503, the rubric still finishes', async () => {
      await start([makeProvider('groq', () => 'Hi.')]);
      await open();
      await say(S(1), M(5), 'First answer.');
      await app.close();
      await start([]);
      const turn = await say(S(1), M(1), 'Still there?');
      expect(turn.statusCode).toBe(503);
      expect(turn.json().error.fallbacks).toEqual(['copy_prompt', 'self_rubric']);
      expect((await finishAi()).statusCode).toBe(503);
      expect(
        (await callA('POST', sessionUrl(S(1), '/finish'), { markDone: false })).statusCode,
      ).toBe(201);
    });
  });

  describe('review fixes', () => {
    const gateOf = () => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const untilPending = async (session = S(1)) => {
      for (let i = 0; i < 150 && (await pendingOf(session)).pending_turn_id === null; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const messagesOf = async (session = S(1)) =>
      rows<{ role: string }>(
        `select role from rnd.practice_messages where session_id = $1 order by seq`,
        [session],
      );

    it('derives the stale window from the turn timeout', () => {
      expect(stalePendingMs(25_000)).toBe(65_000);
      expect(stalePendingMs(1000)).toBe(60_000);
      expect(stalePendingMs(100_000)).toBe(215_000);
    });

    it('does not take over a turn that is still within the configured turn limit', async () => {
      await start([makeProvider('groq', () => 'Hi.')], { AI_TURN_TIMEOUT_MS: '100000' });
      await open();
      await testDb.admin((c) =>
        c.query(
          `update rnd.practice_sessions set pending_turn_id = $1, pending_since = $2 where id = $3`,
          [S(9), new Date(clock.getTime() - 120_000), S(1)],
        ),
      );
      // 120 s is over the old fixed 60 s, but a 100 s turn limit makes it still live.
      expect((await say(S(1), M(1), 'Hello.')).statusCode).toBe(409);
      await testDb.admin((c) =>
        c.query(`update rnd.practice_sessions set pending_since = $1 where id = $2`, [
          new Date(clock.getTime() - 300_000),
          S(1),
        ]),
      );
      expect((await say(S(1), M(1), 'Hello.')).statusCode).toBe(201);
    });

    it('drops a late reply when a newer turn has taken over the session', async () => {
      const gate = gateOf();
      await start([
        makeProvider('groq', async () => {
          await gate.promise;
          return 'Late answer.';
        }),
      ]);
      await open();
      const slow = say(S(1), M(1), 'First.');
      await untilPending();
      await testDb.admin((c) =>
        c.query(`update rnd.practice_sessions set pending_turn_id = $1 where id = $2`, [
          S(9),
          S(1),
        ]),
      );
      gate.release();
      const late = await slow;
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe('turn_superseded');
      expect((await messagesOf()).map((m) => m.role)).toEqual(['assistant', 'user']);
      // The newer turn's marker was not cleared by the stale one.
      expect((await pendingOf()).pending_turn_id).toBe(S(9));
    });

    it('drops the reply when the session is finished or abandoned during the turn', async () => {
      for (const how of ['finish', 'abandon'] as const) {
        const gate = gateOf();
        await start([
          makeProvider('groq', async () => {
            await gate.promise;
            return 'Late answer.';
          }),
        ]);
        await open(S(5), 'p1');
        const slow = say(S(5), M(5), 'First.');
        await untilPending(S(5));
        const res =
          how === 'finish'
            ? await callA('POST', sessionUrl(S(5), '/finish'), { markDone: false })
            : await callA('POST', sessionUrl(S(5), '/abandon'));
        expect(res.statusCode, how).toBe(how === 'finish' ? 201 : 200);
        gate.release();
        const late = await slow;
        expect(late.statusCode, how).toBe(409);
        expect(
          (await messagesOf(S(5))).map((m) => m.role),
          how,
        ).toEqual(['assistant', 'user']);
        await app.close();
        await testDb.admin((c) => c.query('delete from rnd.practice_sessions'));
      }
    });

    it('does not save AI feedback if the session ended while the model was writing it', async () => {
      const gate = gateOf();
      await start([
        makeProvider('groq', async (req) => {
          if (!req.json) return 'Q?';
          await gate.promise;
          return GOOD_JSON;
        }),
      ]);
      await open();
      await say(S(1), M(1), 'An answer.');
      const slow = finishAi(S(1), { markDone: true });
      await untilPending();
      expect((await callA('POST', sessionUrl(S(1), '/abandon'))).statusCode).toBe(200);
      gate.release();
      const late = await slow;
      expect(late.statusCode).toBe(409);
      expect(await rows(`select 1 from rnd.practice_feedback`)).toHaveLength(0);
      expect(await taskStatus('p1')).not.toBe('done');
    });

    it('keeps a chat working after many failed long turns (older unanswered turns are dropped)', async () => {
      await start([makeProvider('groq', () => 'Ok.')]);
      await open();
      for (let i = 1; i <= 5; i += 1) {
        await rows(
          `insert into rnd.practice_messages (user_id, session_id, id, seq, role, content)
           values ($1, $2, $3, $4, 'user', $5)`,
          [A, S(1), M(40 + i), i, `${String(i).repeat(4000)}`],
        );
      }
      const res = await say(S(1), M(1), 'The one I want answered.');
      expect(res.statusCode).toBe(201);
      const sent = seen[0]!.request.messages;
      expect(sent).toHaveLength(1);
      expect(sent[0]!.content).toBe('The one I want answered.');
    });

    it('does not return another message’s reply when an earlier message is retried', async () => {
      let n = 0;
      await start([
        makeProvider('groq', () => {
          n += 1;
          if (n === 1) throw new ProviderUnavailableError(true);
          return 'Answer to B.';
        }),
      ]);
      await open();
      expect((await say(S(1), M(1), 'Message A.')).statusCode).toBe(503);
      const b = await say(S(1), M(2), 'Message B.');
      expect(b.statusCode).toBe(201);
      const retry = await say(S(1), M(1), 'Message A.');
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error.code).toBe('message_superseded');
      expect(n).toBe(2);
      // B itself still replays its own reply.
      const again = await say(S(1), M(2), 'Message B.');
      expect(again.statusCode).toBe(200);
      expect(again.json().reply.content).toBe('Answer to B.');
    });

    it('holds no database connection while a provider call is in flight (pool of 2)', async () => {
      const small = createDatabase({
        connectionString: testDb.appUrl('rnd'),
        appEnv: 'rnd',
        max: 2,
      });
      try {
        const gate = gateOf();
        await start(
          [
            makeProvider('groq', async () => {
              await gate.promise;
              return 'Slow.';
            }),
          ],
          {},
          small,
        );
        await open(S(1), 'p1');
        await open(S(2), 'p2');
        const one = say(S(1), M(1), 'One.');
        const two = say(S(2), M(2), 'Two.');
        await untilPending(S(1));
        await untilPending(S(2));
        const probe = callA('GET', sessionUrl(S(1)));
        const outcome = await Promise.race([
          probe.then((r) => r.statusCode),
          new Promise<string>((r) => setTimeout(() => r('hung'), 3000)),
        ]);
        expect(outcome).toBe(200);
        gate.release();
        expect((await one).statusCode).toBe(201);
        expect((await two).statusCode).toBe(201);
      } finally {
        await app.close();
        await small.close();
      }
    });

    it('redacts at the request-building step, whatever the stored text holds', async () => {
      await start([makeProvider('groq', () => 'Ok.')]);
      await open();
      // Text that reached the database without passing the turn redaction: the stored prompt,
      // and earlier turns inserted directly.
      await testDb.admin(async (c) => {
        await c.query(
          `update rnd.practice_sessions set prompt_used = prompt_used || ' Role-play with Zebediah Quillfeather.' where id = $1`,
          [S(1)],
        );
        await c.query(
          `insert into rnd.practice_messages (user_id, session_id, id, seq, role, content)
           values ($1, $2, $3, 1, 'user', 'Hello, I am Zebediah.'),
                  ($1, $2, $4, 2, 'assistant', 'Nice to meet you, Quillfeather.')`,
          [A, S(1), M(41), M(42)],
        );
      });
      const res = await say(S(1), M(1), 'Next question please.');
      expect(res.statusCode).toBe(201);
      const everything = JSON.stringify(
        seen.map((s) => ({ system: s.request.system, messages: s.request.messages })),
      );
      expect(everything).not.toContain('Zebediah');
      expect(everything).not.toContain('Quillfeather');
      expect(everything).toContain('[removed]');
    });

    it('refuses an AI finish with markDone on a skipped task before any model call', async () => {
      await start([makeProvider('groq', (req) => (req.json ? GOOD_JSON : 'Q?'))]);
      await open();
      await say(S(1), M(1), 'An answer.');
      await rows(`update rnd.tasks set status = 'skipped' where plan_id = $1 and id = 'p1'`, [
        PLAN_A,
      ]);
      seen = [];
      const res = await finishAi(S(1), { markDone: true });
      expect(res.statusCode).toBe(409);
      expect(seen).toHaveLength(0);
      const used = await rows(
        `select 1 from rnd.ai_usage_daily where purpose = 'practice_feedback'`,
      );
      expect(used).toHaveLength(0);
    });
  });
});
