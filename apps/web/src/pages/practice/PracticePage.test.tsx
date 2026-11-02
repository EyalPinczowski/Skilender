import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import {
  BASE,
  feedbackBody,
  finishedBody,
  practiceRoutes,
  practiceTask,
  promptBody,
  SESSION_ID,
  sessionBody,
  TASK_ID,
} from '../../test/practice-fixtures';
import { bodyOf } from '../../test/day-fixtures';

const USAGE_ON = {
  day: '2026-11-10',
  resetsAt: '2026-11-11T00:00:00.000Z',
  configured: true,
  user: {
    practiceMessages: { used: 0, cap: 30 },
    practiceFeedback: { used: 0, cap: 10 },
    dayOverview: { used: 0, cap: 5 },
  },
  avoidedToday: 0,
  providers: [],
};
const START = `POST ${BASE}/tasks/${TASK_ID}/practice/sessions`;
const GET_SESSION = `GET ${BASE}/practice/sessions/${SESSION_ID}`;
const FINISH = `POST ${BASE}/practice/sessions/${SESSION_ID}/finish`;
const PASTE = `POST ${BASE}/practice/sessions/${SESSION_ID}/feedback`;
const ABANDON = `POST ${BASE}/practice/sessions/${SESSION_ID}/abandon`;
const STORE_KEY = `upversion.practice.${BASE.split('/').at(-1)}.${TASK_ID}`;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Start answers with this session, and so does every later read of it. */
const serveSession = (detail: ReturnType<typeof sessionBody>) => ({
  [START]: () => json(detail, 201),
  [GET_SESSION]: () => json(detail),
});

function open(extra: Parameters<typeof practiceRoutes>[0] = {}) {
  const api = installApi(practiceRoutes(extra));
  renderApp({ auth: fakeAuth(SESSION), path: `/practice/${TASK_ID}` });
  return api;
}

const requests = (api: ReturnType<typeof installApi>, key: string) =>
  api.calls.filter((c) => `${c.method} ${new URL(c.url).pathname}` === key);

async function startExternal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Start practice' }));
  await screen.findByRole('timer');
}

describe('Practice page: starting', () => {
  it('offers the two channels and no in-app chat', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Start practice' })).toBeInTheDocument();
    expect(screen.getByText('Mock interview')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Use Claude or another assistant/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Practise on my own/ })).not.toBeChecked();
    expect(screen.queryByText(/in-app|chat/i)).toBeNull();
  });

  it('says so for a task that is not a practice', async () => {
    installApi(practiceRoutes());
    renderApp({ auth: fakeAuth(SESSION), path: '/practice/sql1' });
    expect(await screen.findByText(/not a practice/)).toBeInTheDocument();
  });

  it('starts an external session with a client id, then shows the timer, prompt and paste box', async () => {
    const user = userEvent.setup();
    const api = open(serveSession(sessionBody()));
    await startExternal(user);

    const sent = (await bodyOf(requests(api, START)[0]!)) as { id: string; channel: string };
    expect(sent.channel).toBe('external');
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(sent)).not.toMatch(/user_id|userId/);

    expect(await screen.findByLabelText('Practice prompt')).toHaveTextContent(
      'Act as a behavioral interviewer.',
    );
    expect(screen.getByRole('link', { name: /Open in Claude/ })).toHaveAttribute(
      'href',
      'https://claude.ai/new',
    );
    expect(screen.getByLabelText('Reply from your assistant')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Score yourself' })).toBeInTheDocument();
    // Only the session id is remembered in the browser.
    expect(window.localStorage.getItem(STORE_KEY)).toBe(SESSION_ID);
  });

  it('starts a self session without a prompt or paste box', async () => {
    const user = userEvent.setup();
    const api = open(serveSession(sessionBody({ channel: 'self' })));
    await user.click(await screen.findByRole('radio', { name: /Practise on my own/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByRole('timer');
    expect(((await bodyOf(requests(api, START)[0]!)) as { channel: string }).channel).toBe('self');
    expect(screen.queryByLabelText('Practice prompt')).toBeNull();
    expect(screen.queryByLabelText('Reply from your assistant')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Answer out loud' })).toBeInTheDocument();
  });

  it('carries on with the running session named in the 409 body', async () => {
    const user = userEvent.setup();
    open({
      // The real API shape: the id is its own field, the message is only for people.
      [START]: () =>
        json(
          {
            error: {
              code: 'practice_session_active',
              message: 'This task already has an active practice session.',
              requestId: 'req-1',
              sessionId: SESSION_ID,
            },
          },
          409,
        ),
      [GET_SESSION]: () => json(sessionBody()),
    });
    await user.click(await screen.findByRole('button', { name: 'Start practice' }));
    expect(await screen.findByRole('timer')).toBeInTheDocument();
    expect(window.localStorage.getItem(STORE_KEY)).toBe(SESSION_ID);
  });

  it('shows the error when a 409 names no usable session, and the button still works', async () => {
    const user = userEvent.setup();
    const api = open({
      [START]: () =>
        apiError(
          409,
          'practice_session_active',
          `This task already has a session (${SESSION_ID}).`,
        ),
    });
    const button = await screen.findByRole('button', { name: 'Start practice' });
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has a session/);
    // The id in the message is not trusted: only the body field is read.
    expect(requests(api, GET_SESSION)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Start practice' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    expect(requests(api, START)).toHaveLength(2);
  });

  it('ignores a remembered id that is not a UUID, without asking the API', async () => {
    window.localStorage.setItem(STORE_KEY, '../../etc/passwd');
    const api = open();
    expect(await screen.findByRole('button', { name: 'Start practice' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.url.includes('passwd'))).toBe(false);
    expect(requests(api, GET_SESSION)).toHaveLength(0);
  });

  it.each([
    ['is gone (404)', () => apiError(404, 'not_found', 'Resource not found.')],
    ['is finished', () => json(sessionBody({ status: 'finished' }))],
    ['is abandoned', () => json(sessionBody({ status: 'abandoned' }))],
    ['cannot be read (500)', () => apiError(500, 'internal', 'boom')],
  ])('forgets a remembered session that %s and shows the start panel', async (_name, answer) => {
    window.localStorage.setItem(STORE_KEY, SESSION_ID);
    open({ [GET_SESSION]: answer });
    expect(await screen.findByRole('button', { name: 'Start practice' })).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(STORE_KEY)).toBeNull());
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('forgets remembered sessions on sign-out', async () => {
    window.localStorage.setItem(STORE_KEY, SESSION_ID);
    installApi(practiceRoutes());
    renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(window.localStorage.getItem(STORE_KEY)).toBeNull());
  });

  it('resumes a remembered active session after a reload', async () => {
    window.localStorage.setItem(STORE_KEY, SESSION_ID);
    const api = open({ [GET_SESSION]: () => json(sessionBody()) });
    expect(await screen.findByRole('timer')).toBeInTheDocument();
    expect(requests(api, START)).toHaveLength(0);
  });

  it('offers the in-app chat only when an AI provider is configured', async () => {
    const user = userEvent.setup();
    open({
      'GET /api/v1/ai/usage': () => json(USAGE_ON),
      ...serveSession(sessionBody({ channel: 'in_app' })),
    });
    await user.click(await screen.findByRole('radio', { name: /Chat with the in-app assistant/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    expect(await screen.findByRole('log', { name: 'Conversation' })).toBeInTheDocument();
  });

  it('after a 503 at start: start-screen wording, back to the external channel, usage reread', async () => {
    const user = userEvent.setup();
    const api = open({
      'GET /api/v1/ai/usage': () => json(USAGE_ON),
      [START]: () => json({ error: { code: 'ai_unavailable', message: 'x', requestId: 'r' } }, 503),
    });
    await user.click(await screen.findByRole('radio', { name: /Chat with the in-app assistant/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    expect(await screen.findByText(/Choose another way to practise/)).toBeInTheDocument();
    expect(screen.queryByText(/copy the prompt below/)).toBeNull();
    expect(screen.getByRole('radio', { name: /Use Claude or another assistant/ })).toBeChecked();
    await waitFor(() => expect(requests(api, 'GET /api/v1/ai/usage').length).toBeGreaterThan(1));
  });

  it('shows AI unavailable when starting a chat answers 503', async () => {
    const user = userEvent.setup();
    open({
      'GET /api/v1/ai/usage': () => json(USAGE_ON),
      [START]: () =>
        json(
          {
            error: {
              code: 'ai_unavailable',
              message: 'x',
              requestId: 'r',
              fallbacks: ['copy_prompt'],
            },
          },
          503,
        ),
    });
    await user.click(await screen.findByRole('radio', { name: /Chat with the in-app assistant/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    expect(await screen.findByText('AI unavailable')).toBeInTheDocument();
    // The other channels are still there.
    await user.click(screen.getByRole('radio', { name: /Practise on my own/ }));
    expect(screen.getByRole('button', { name: 'Start practice' })).toBeEnabled();
  });

  it('shows a server problem when the start fails, in words', async () => {
    const user = userEvent.setup();
    open({ [START]: () => apiError(500, 'internal', 'boom') });
    await user.click(await screen.findByRole('button', { name: 'Start practice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong on our side/);
  });
});

describe('Practice page: finishing', () => {
  it('pastes a feedback block, asks about done, and shows the API score and next focus', async () => {
    const user = userEvent.setup();
    const block = '===FEEDBACK===\nscore: 7/10\n===END===';
    const api = open({
      ...serveSession(sessionBody()),
      [PASTE]: () => json(finishedBody({ loggedHours: 0.5 }), 201),
    });
    await startExternal(user);
    await user.click(await screen.findByLabelText('Reply from your assistant'));
    await user.paste(block);
    await user.click(screen.getByRole('button', { name: 'Finish with this feedback' }));

    const dialog = await screen.findByRole('dialog', { name: 'Finish this practice' });
    expect(within(dialog).getByRole('checkbox', { name: 'Mark task done' })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Finish practice' }));

    expect(await screen.findByRole('heading', { name: 'Practice finished' })).toBeInTheDocument();
    const sent = (await bodyOf(requests(api, PASTE)[0]!)) as Record<string, unknown>;
    expect(sent.text).toBe(block);
    expect(sent.markDone).toBe(false);
    expect(typeof sent.logHours === 'number' || sent.logHours === null).toBe(true);
    expect(screen.getByText('Score: 7 out of 10')).toBeInTheDocument();
    expect(screen.getByText('Quantify the result')).toBeInTheDocument();
    expect(screen.getByText('Logged 0.5 h.')).toBeInTheDocument();
    expect(screen.getByText('The task was not marked done.')).toBeInTheDocument();
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('saves unformatted text as plain text and says so', async () => {
    const user = userEvent.setup();
    open({
      ...serveSession(sessionBody()),
      [PASTE]: () =>
        json(
          finishedBody({
            parsed: false,
            feedback: feedbackBody({
              source: 'free_text',
              score: null,
              strengths: '',
              improve: '',
              nextFocus: '',
              raw: 'Nice work, be more concrete.',
            }),
          }),
          201,
        ),
    });
    await startExternal(user);
    await user.click(await screen.findByLabelText('Reply from your assistant'));
    await user.paste('Nice work, be more concrete.');
    await user.click(screen.getByRole('button', { name: 'Finish with this feedback' }));
    await user.click(await screen.findByRole('button', { name: 'Finish practice' }));

    expect(await screen.findByText(/saved as plain text/)).toBeInTheDocument();
    expect(screen.getByText('Nice work, be more concrete.')).toBeInTheDocument();
    expect(screen.getByText(/No score/)).toBeInTheDocument();
  });

  it('marks the task done only when the box was ticked', async () => {
    const user = userEvent.setup();
    const api = open({
      ...serveSession(sessionBody({ channel: 'self' })),
      [FINISH]: () => json(finishedBody({ status: 'done' }), 201),
    });
    await user.click(await screen.findByRole('radio', { name: /Practise on my own/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByRole('timer');
    await user.click(screen.getByRole('checkbox', { name: 'Set a timer' }));
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Mark task done' }));
    await user.click(within(dialog).getByRole('button', { name: 'Finish practice' }));

    expect(await screen.findByText('The task is marked done.')).toBeInTheDocument();
    const sent = (await bodyOf(requests(api, FINISH)[0]!)) as Record<string, unknown>;
    expect(sent.markDone).toBe(true);
    expect(sent.rubric).toEqual({ checkedSteps: [0] });
    expect(sent).not.toHaveProperty('enteredScore');
    expect(sent).not.toHaveProperty('score');
  });

  it('finishes with an entered score', async () => {
    const user = userEvent.setup();
    const api = open({
      ...serveSession(sessionBody({ channel: 'self' })),
      [FINISH]: () =>
        json(finishedBody({ feedback: feedbackBody({ source: 'self_rubric', score: 8.5 }) }), 201),
    });
    await user.click(await screen.findByRole('radio', { name: /Practise on my own/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByRole('timer');
    await user.click(screen.getByRole('radio', { name: 'Entering a score I got elsewhere' }));
    await user.type(screen.getByLabelText('My score'), '34');
    await user.type(screen.getByLabelText('Maximum score'), '40');
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    await user.click(await screen.findByRole('button', { name: 'Finish practice' }));
    expect(await screen.findByText('Score: 8.5 out of 10')).toBeInTheDocument();
    const sent = (await bodyOf(requests(api, FINISH)[0]!)) as Record<string, unknown>;
    expect(sent.enteredScore).toEqual({ score: 34, max: 40 });
    expect(sent.markDone).toBe(false);
  });

  it('keeps the dialog open with the API message when the finish is refused, and can be retried', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open({
      ...serveSession(sessionBody({ channel: 'self' })),
      [FINISH]: () => {
        calls += 1;
        return calls === 1
          ? apiError(409, 'task_skipped', 'This task was skipped. Reopen it first.')
          : json(finishedBody(), 201);
      },
    });
    await user.click(await screen.findByRole('radio', { name: /Practise on my own/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByRole('timer');
    await user.click(screen.getByRole('button', { name: 'Finish without feedback' }));
    await user.click(await screen.findByRole('button', { name: 'Finish practice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This task was skipped.');
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(await screen.findByRole('heading', { name: 'Practice finished' })).toBeInTheDocument();
  });

  it('can be finished with the keyboard alone', async () => {
    const user = userEvent.setup();
    const api = open({
      ...serveSession(sessionBody({ channel: 'self' })),
      [FINISH]: () => json(finishedBody(), 201),
    });
    // Choose "Practise on my own" and start, only with Tab, arrow keys, Space and Enter.
    const external = await screen.findByRole('radio', { name: /Use Claude or another assistant/ });
    external.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /Practise on my own/ })).toBeChecked();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Start practice' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('timer');

    // Tick the first step, then reach the finish button with Tab.
    const first = screen.getByRole('checkbox', { name: 'Set a timer' });
    first.focus();
    await user.keyboard(' ');
    expect(first).toBeChecked();
    for (let i = 0; i < 2; i += 1) await user.tab(); // two more steps
    await user.tab();
    expect(screen.getByRole('button', { name: 'Finish with this self-check' })).toHaveFocus();
    await user.keyboard('{Enter}');

    // The dialog takes focus; Tab to the checkbox is skipped, Enter on the field submits.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Hours to log')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Practice finished' })).toBeInTheDocument();
    expect(((await bodyOf(requests(api, FINISH)[0]!)) as { markDone: boolean }).markDone).toBe(
      false,
    );
  });

  it('closes the dialog with Escape and returns focus to the button that opened it', async () => {
    const user = userEvent.setup();
    open(serveSession(sessionBody({ channel: 'self' })));
    await user.click(await screen.findByRole('radio', { name: /Practise on my own/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByRole('timer');
    const trigger = screen.getByRole('button', { name: 'Finish without feedback' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe('Practice page: stopping', () => {
  it('asks first, then stops and logs nothing', async () => {
    const user = userEvent.setup();
    const api = open({
      ...serveSession(sessionBody()),
      [ABANDON]: () => json({ session: sessionBody({ status: 'abandoned' }).session }),
    });
    await startExternal(user);
    await user.click(screen.getByRole('button', { name: 'Stop without saving' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(requests(api, ABANDON)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Stop practice' }));
    expect(
      await screen.findByText('The practice was stopped. Nothing was logged.'),
    ).toBeInTheDocument();
    expect(requests(api, ABANDON)).toHaveLength(1);
    expect(requests(api, FINISH)).toHaveLength(0);
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });
});

describe('Practice page: job description and storage', () => {
  it('saves the job description through the API and never into browser storage', async () => {
    const user = userEvent.setup();
    const secret = 'Senior analyst at Example Corp, SQL and dashboards';
    const api = open({
      ...serveSession(sessionBody()),
      [`PUT ${BASE}/practice/context`]: () =>
        json({
          jobDescription: secret,
          updatedAt: '2026-11-10T09:00:00.000Z',
          redactionsPreview: 1,
        }),
    });
    await startExternal(user);
    const field = await screen.findByLabelText('Job description');
    await user.click(field);
    await user.paste(secret);
    await user.click(screen.getByRole('button', { name: 'Save job description' }));
    expect(
      await screen.findByText(/Saved\. 1 personal detail will be removed/),
    ).toBeInTheDocument();
    expect(
      (
        (await bodyOf(requests(api, `PUT ${BASE}/practice/context`)[0]!)) as {
          jobDescription: string;
        }
      ).jobDescription,
    ).toBe(secret);
    // The prompt is fetched again because it now contains the job description.
    await waitFor(() =>
      expect(requests(api, `GET ${BASE}/tasks/${TASK_ID}/practice/prompt`).length).toBeGreaterThan(
        1,
      ),
    );

    const stored =
      JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    expect(stored).not.toContain('Example Corp');
  });

  it('shows the updated prompt with the job description after saving', async () => {
    const user = userEvent.setup();
    let saved = false;
    open({
      ...serveSession(sessionBody()),
      [`GET ${BASE}/tasks/${TASK_ID}/practice/prompt`]: () =>
        json(
          promptBody({
            prompt: saved ? 'Prompt WITH job description' : 'Prompt without job description',
          }),
        ),
      [`PUT ${BASE}/practice/context`]: () => {
        saved = true;
        return json({
          jobDescription: 'A role',
          updatedAt: '2026-11-10T09:00:00.000Z',
          redactionsPreview: 0,
        });
      },
    });
    await startExternal(user);
    expect(await screen.findByLabelText('Practice prompt')).toHaveTextContent('without job');
    await user.click(await screen.findByLabelText('Job description'));
    await user.paste('A role');
    await user.click(screen.getByRole('button', { name: 'Save job description' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Practice prompt')).toHaveTextContent('WITH job description'),
    );
  });
});

describe('Practice page: finish dialog details', () => {
  async function startSelf(user: ReturnType<typeof userEvent.setup>, startedAt?: string) {
    open({
      ...serveSession(sessionBody({ channel: 'self', ...(startedAt ? { startedAt } : {}) })),
      [FINISH]: () => json(finishedBody(), 201),
    });
    await user.click(await screen.findByRole('radio', { name: /Practise on my own/ }));
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByRole('timer');
  }

  it('leaves the hours empty when almost no time has passed', async () => {
    const user = userEvent.setup();
    await startSelf(user);
    await user.click(screen.getByRole('button', { name: 'Finish without feedback' }));
    expect(await screen.findByLabelText('Hours to log')).toHaveValue('');
  });

  it('prefills the time spent, rounded to a quarter hour', async () => {
    const user = userEvent.setup();
    await startSelf(user, new Date(Date.now() - 31 * 60_000).toISOString());
    await user.click(screen.getByRole('button', { name: 'Finish without feedback' }));
    expect(await screen.findByLabelText('Hours to log')).toHaveValue('0.5');
  });

  it('hides the page from assistive technology while open, then lands on the result', async () => {
    const user = userEvent.setup();
    await startSelf(user);
    await user.click(screen.getByRole('button', { name: 'Finish without feedback' }));
    const dialog = await screen.findByRole('dialog');
    const root = document.getElementById('root') ?? document.body.firstElementChild!;
    expect(root).toHaveAttribute('inert');
    expect(root).not.toContainElement(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Finish practice' }));
    const heading = await screen.findByRole('heading', { name: 'Practice finished' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(root).not.toHaveAttribute('inert');
    // One way back, not two.
    expect(screen.getAllByRole('link', { name: 'Back to Today' })).toHaveLength(1);
  });
});

describe('Practice page: accessibility', () => {
  it('has no axe violations on the start panel, a running session and the finish dialog', async () => {
    const user = userEvent.setup();
    open(serveSession(sessionBody()));
    await screen.findByRole('button', { name: 'Start practice' });
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Start practice' }));
    await screen.findByLabelText('Practice prompt');
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Finish without feedback' }));
    await screen.findByRole('dialog');
    await expectNoAxeViolations();
  });
});

// The practice task fixture is used by name in the assertions above.
void practiceTask;
