import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionDetail } from '../../api/practice-hooks';
import { bodyOf } from '../../test/day-fixtures';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import {
  BASE,
  feedbackBody,
  finishedBody,
  practiceRoutes,
  SESSION_ID,
  sessionBody,
  TASK_ID,
} from '../../test/practice-fixtures';

const GET_SESSION = `GET ${BASE}/practice/sessions/${SESSION_ID}`;
const MESSAGES = `POST ${BASE}/practice/sessions/${SESSION_ID}/messages`;
const FINISH = `POST ${BASE}/practice/sessions/${SESSION_ID}/finish`;
const USAGE = 'GET /api/v1/ai/usage';

const usageBody = (configured = true) => ({
  day: '2026-11-10',
  resetsAt: '2026-11-11T00:00:00.000Z',
  configured,
  user: {
    practiceMessages: { used: 1, cap: 30 },
    practiceFeedback: { used: 0, cap: 10 },
    dayOverview: { used: 0, cap: 5 },
  },
  avoidedToday: 0,
  providers: [],
});

const msg = (
  seq: number,
  role: 'user' | 'assistant' | 'note',
  content: string,
  extra: Partial<SessionDetail['messages'][number]> = {},
): SessionDetail['messages'][number] => ({
  id: `00000000-0000-4000-8000-00000000000${seq}`,
  seq,
  role,
  content,
  providerId: null,
  model: null,
  redacted: false,
  createdAt: '2026-11-10T09:00:00.000Z',
  ...extra,
});

const OPENER = msg(1, 'assistant', 'Tell me about a time you led a project.');

function chatSession(messages: SessionDetail['messages'] = [OPENER]): SessionDetail {
  return { ...sessionBody({ channel: 'in_app' }), messages };
}

function reply(content: string, extra: Record<string, unknown> = {}) {
  return {
    userMessage: msg(2, 'user', 'My answer'),
    reply: { id: '00000000-0000-4000-8000-000000000003', content, providerId: 'groq', model: null },
    switched: null,
    usage: { used: 2, cap: 30 },
    replayed: false,
    ...extra,
  };
}

/** A session that remembers what was sent, like the server does. */
function open(handlers: Record<string, (r: Request) => Response | Promise<Response>> = {}) {
  let detail = chatSession();
  const wrapped: Record<string, (r: Request) => Response | Promise<Response>> = { ...handlers };
  const original = handlers[MESSAGES];
  if (original) {
    wrapped[MESSAGES] = async (request) => {
      const response = await original(request);
      if (response.ok) {
        const body = (await response.clone().json()) as Omit<
          ReturnType<typeof reply>,
          'switched'
        > & {
          switched: { toLabel: string } | null;
        };
        detail = {
          ...detail,
          messages: [
            ...detail.messages,
            body.userMessage,
            ...(body.switched ? [msg(8, 'note', `Continuing on ${body.switched.toLabel}.`)] : []),
            msg(9, 'assistant', body.reply.content, { id: body.reply.id }),
          ],
        };
      }
      return response;
    };
  }
  const api = installApi(
    practiceRoutes({
      [GET_SESSION]: () => json(detail),
      [USAGE]: () => json(usageBody()),
      ...wrapped,
    }),
  );
  window.localStorage.setItem(
    `upversion.practice.${BASE.split('/').at(-1)}.${TASK_ID}`,
    SESSION_ID,
  );
  renderApp({ auth: fakeAuth(SESSION), path: `/practice/${TASK_ID}` });
  return { api, setDetail: (d: SessionDetail) => (detail = d) };
}

beforeEach(() => window.localStorage.clear());

describe('Practice chat', () => {
  it('shows the opener as plain text, with the AI-can-be-wrong note', async () => {
    open();
    const log = await screen.findByRole('log', { name: 'Conversation' });
    expect(within(log).getByText('Tell me about a time you led a project.')).toBeInTheDocument();
    expect(screen.getByText(/AI feedback can be wrong/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get AI feedback' })).toBeDisabled();
  });

  it('renders model output as text only: no links, no markup', async () => {
    const user = userEvent.setup();
    open({
      [MESSAGES]: () =>
        json(reply('See https://example.com/x and [a link](https://evil.test) <b>bold</b>'), 201),
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const log = screen.getByRole('log', { name: 'Conversation' });
    const text = await within(log).findByText(/See https:\/\/example.com\/x/);
    expect(text).toHaveTextContent('[a link](https://evil.test) <b>bold</b>');
    expect(log.querySelector('a, b, strong')).toBeNull();
  });

  it('sends the message with a client id and shows the reply once, then clears the field', async () => {
    const user = userEvent.setup();
    const { api } = open({ [MESSAGES]: () => json(reply('Good. What was the result?'), 201) });
    const box = await screen.findByLabelText('Your answer');
    await user.type(box, 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Good. What was the result?')).toBeInTheDocument();
    expect(screen.getAllByText('Good. What was the result?')).toHaveLength(1);
    expect(box).toHaveValue('');
    const sent = (await bodyOf(
      api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/messages'))!,
    )) as {
      id: string;
      content: string;
    };
    expect(sent.content).toBe('My answer');
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(sent)).not.toMatch(/user_id|userId/);
    // One conversation log is the only live region for messages.
    expect(screen.getAllByRole('log')).toHaveLength(1);
  });

  it('announces "Continuing on {label}" inside the live log when the provider switched', async () => {
    const user = userEvent.setup();
    open({
      [MESSAGES]: () =>
        json(
          reply('Next question.', {
            switched: {
              from: 'groq',
              fromLabel: 'Groq',
              to: 'cf',
              toLabel: 'Cloudflare',
              reason: 'quota',
            },
          }),
          201,
        ),
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const log = screen.getByRole('log', { name: 'Conversation' });
    const note = await within(log).findByText('Continuing on Cloudflare.');
    expect(log).toContainElement(note);
    expect(screen.getAllByText('Continuing on Cloudflare.')).toHaveLength(1);
  });

  it('shows the redaction notice for a redacted message', async () => {
    const user = userEvent.setup();
    open({
      [MESSAGES]: () =>
        json(
          reply('Thanks.', {
            userMessage: msg(2, 'user', 'Mail me at [email removed]', { redacted: true }),
          }),
          201,
        ),
    });
    await user.type(await screen.findByLabelText('Your answer'), 'Mail me at a@b.co');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Removed contact details before sending')).toBeInTheDocument();
  });

  it('retries a failed send with the same id, and a new id for changed text', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = open({
      [MESSAGES]: () => {
        calls += 1;
        return calls === 1 ? apiError(502, 'bad_gateway', 'x') : json(reply('Back again.'), 201);
      },
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong/);
    expect(screen.getByLabelText('Your answer')).toHaveValue('My answer');
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText('Back again.')).toBeInTheDocument();
    const ids = await Promise.all(
      api.calls
        .filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
        .map(async (c) => ((await bodyOf(c)) as { id: string }).id),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('sends a new id after a superseded answer, never the replaced one', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = open({
      [MESSAGES]: () => {
        calls += 1;
        return calls === 1
          ? apiError(409, 'turn_superseded', 'replaced')
          : json(reply('Fresh start.'), 201);
      },
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/replaced by a newer one/);
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText('Fresh start.')).toBeInTheDocument();
    const ids = await Promise.all(
      api.calls
        .filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
        .map(async (c) => ((await bodyOf(c)) as { id: string }).id),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('says a reply is still being written on 409 turn_in_progress', async () => {
    const user = userEvent.setup();
    open({ [MESSAGES]: () => apiError(409, 'turn_in_progress', 'busy') });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still being written/);
    expect(screen.getByLabelText('Your answer')).toHaveValue('My answer');
  });

  it('says to wait on 429 rate_limited, for a message and for AI feedback', async () => {
    const user = userEvent.setup();
    const { setDetail } = open({
      [MESSAGES]: () => apiError(429, 'rate_limited', 'slow down'),
      [FINISH]: () => apiError(429, 'rate_limited', 'slow down'),
    });
    setDetail(chatSession([OPENER, msg(2, 'user', 'Earlier'), msg(3, 'assistant', 'Okay.')]));
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many requests in a minute/);
    // Not treated as the AI being unavailable.
    expect(screen.queryByText('AI unavailable')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Get AI feedback' }));
    await user.click(await screen.findByRole('button', { name: 'Finish practice' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Too many requests in a minute/,
    );
  });

  it('shows the switch note once, even after the stored transcript replaces it', async () => {
    const user = userEvent.setup();
    open({
      [MESSAGES]: () =>
        json(
          reply('Next.', {
            switched: { from: 'a', fromLabel: 'A', to: 'b', toLabel: 'Bee', reason: 'error' },
          }),
          201,
        ),
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const note = await screen.findByText('Continuing on Bee.');
    await waitFor(() => expect(screen.getByText('Next.')).toBeInTheDocument());
    // The same DOM node stays: it is not removed and added again (which would announce twice).
    expect(screen.getByText('Continuing on Bee.')).toBe(note);
  });

  it('explains a superseded message instead of failing silently', async () => {
    const user = userEvent.setup();
    open({ [MESSAGES]: () => apiError(409, 'message_superseded', 'newer message exists') });
    await user.type(await screen.findByLabelText('Your answer'), 'Old one');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/replaced by a newer one/);
  });

  it('shows AI unavailable with both fallbacks when the AI is down, and practice stays possible', async () => {
    const user = userEvent.setup();
    open({
      [MESSAGES]: () =>
        json(
          {
            error: {
              code: 'ai_unavailable',
              message: 'x',
              requestId: 'r',
              fallbacks: ['copy_prompt', 'self_rubric'],
            },
          },
          503,
        ),
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('AI unavailable');
    expect(notice).toHaveTextContent(/copy the prompt/);
    expect(notice).toHaveTextContent(/self-check/);
    // The fallbacks are on screen.
    expect(await screen.findByLabelText('Practice prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Reply from your assistant')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Score yourself' })).toBeInTheDocument();
    expect(screen.getByLabelText('Your answer')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try the AI again' }));
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
  });

  it('shows the daily-limit state on ai_user_cap', async () => {
    const user = userEvent.setup();
    open({
      [MESSAGES]: () =>
        json(
          {
            error: {
              code: 'ai_user_cap',
              message: 'x',
              requestId: 'r',
              fallbacks: ['copy_prompt', 'self_rubric'],
            },
          },
          429,
        ),
    });
    await user.type(await screen.findByLabelText('Your answer'), 'My answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('AI unavailable');
    expect(notice).toHaveTextContent(/limit is used up/);
    expect(screen.queryByRole('button', { name: 'Try the AI again' })).toBeNull();
    expect(await screen.findByLabelText('Practice prompt')).toBeInTheDocument();
  });

  it('gets AI feedback with an explicit markDone choice and shows the note', async () => {
    const user = userEvent.setup();
    const { api, setDetail } = open({
      [FINISH]: () =>
        json(
          finishedBody({ feedback: feedbackBody({ source: 'model_json' }), status: 'in_progress' }),
          201,
        ),
    });
    setDetail(chatSession([OPENER, msg(2, 'user', 'My answer'), msg(3, 'assistant', 'Okay.')]));
    await user.click(await screen.findByRole('button', { name: 'Get AI feedback' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(await screen.findByRole('heading', { name: 'Practice finished' })).toBeInTheDocument();
    const sent = (await bodyOf(api.calls.find((c) => c.url.endsWith('/finish'))!)) as Record<
      string,
      unknown
    >;
    expect(sent.aiFeedback).toBe(true);
    expect(sent.markDone).toBe(false);
    expect(screen.getByText(/AI feedback can be wrong\. Check facts/)).toBeInTheDocument();
  });

  it('closes the dialog and offers fallbacks when AI feedback is unavailable', async () => {
    const user = userEvent.setup();
    const { setDetail } = open({
      [FINISH]: () =>
        json(
          {
            error: {
              code: 'ai_unavailable',
              message: 'x',
              requestId: 'r',
              fallbacks: ['self_rubric'],
            },
          },
          503,
        ),
    });
    setDetail(chatSession([OPENER, msg(2, 'user', 'My answer'), msg(3, 'assistant', 'Okay.')]));
    await user.click(await screen.findByRole('button', { name: 'Get AI feedback' }));
    await user.click(await screen.findByRole('button', { name: 'Finish practice' }));
    expect(await screen.findByText('AI unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Score yourself' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    open();
    await screen.findByRole('log', { name: 'Conversation' });
    await expectNoAxeViolations();
  });
});
