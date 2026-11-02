import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { dayRoutes } from '../../test/day-fixtures';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import { PLAN_ID, type planRoutes } from '../../test/plan-fixtures';
import { deltaText, kindLabel, scoreText } from './practice-labels';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = `/api/v1/plans/${PLAN_ID}`;
const TRENDS = `GET ${BASE}/practice/trends`;
const HISTORY = `GET ${BASE}/practice/history`;

const trendsBody = {
  kinds: [
    {
      kind: 'mock_interview',
      points: [
        { date: '2026-11-03', score: 5, source: 'self_rubric' },
        { date: '2026-11-06', score: 6.5, source: 'pasted_block' },
        { date: '2026-11-09', score: 8, source: 'model_json' },
      ],
      last: 8,
      average: 6.5,
      delta: 1.5,
    },
    {
      kind: 'timed_test',
      points: [{ date: '2026-11-08', score: 4, source: 'model_json' }],
      last: 4,
      average: 4,
      delta: null,
    },
  ],
};

const session = (overrides: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  taskId: 'sql1',
  kind: 'mock_interview',
  channel: 'external',
  startedAt: '2026-11-10T09:00:00.000Z',
  minutes: 25,
  score: 7.5,
  source: 'pasted_block',
  ...overrides,
});

function open(path: string, extra: Parameters<typeof planRoutes>[0] = {}) {
  const api = installApi(dayRoutes(extra));
  renderApp({ auth: fakeAuth(SESSION), path });
  return api;
}

describe('practice labels', () => {
  it('writes kinds, scores and changes as plain text', () => {
    expect(kindLabel('mock_interview')).toBe('Mock interview');
    expect(kindLabel('')).toBe('Practice');
    expect(scoreText(7.25)).toBe('7.3');
    expect(scoreText(7)).toBe('7');
    expect(deltaText(null)).toBe('first score');
    expect(deltaText(0)).toBe('same as the one before');
    expect(deltaText(-2)).toBe('down 2 from the one before');
  });
});

describe('Practice scores page', () => {
  it('draws one chart per kind with a table alternative', async () => {
    const api = open('/practice-history', { [TRENDS]: () => json(trendsBody) });
    await screen.findByRole('heading', { name: 'Practice scores' });
    const charts = await screen.findAllByRole('img');
    expect(charts).toHaveLength(2);
    expect(charts[0]).toHaveAccessibleName(/Mock interview scores from 0 to 10/);
    expect(screen.getByRole('heading', { name: 'Mock interview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Timed test' })).toBeInTheDocument();
    expect(screen.getByText(/Last score 8 of 10 \(up 1.5 from the one before\)/)).toBeVisible();
    expect(screen.getByText(/Last score 4 of 10 \(first score\)/)).toBeVisible();
    expect(screen.getByText('Square: self-check')).toBeVisible();

    await userEvent.setup().click(screen.getByText('Show mock interview scores as a table'));
    const table = screen.getByRole('table', { name: /Mock interview scores/ });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('5');
    expect(rows[1]).toHaveTextContent('Self-check');
    expect(rows[3]).toHaveTextContent('AI feedback');
    expect(api.count(TRENDS)).toBe(1);
    await expectNoAxeViolations(document.body);
  });

  it('says so when there are no scores yet', async () => {
    open('/practice-history', { [TRENDS]: () => json({ kinds: [] }) });
    expect(await screen.findByText(/No practice scores yet/)).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await expectNoAxeViolations(document.body);
  });

  it('offers a retry when the scores cannot be loaded', async () => {
    open('/practice-history', { [TRENDS]: () => apiError(500, 'internal', 'Boom.') });
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeVisible();
  });
});

describe('Last practice score on Week', () => {
  it('shows the last score per kind and links to the history', async () => {
    open('/week', { [TRENDS]: () => json(trendsBody) });
    const heading = await screen.findByRole('heading', { name: 'Last practice score' });
    const section = within(heading.closest('section')!);
    expect(await section.findByText(/Mock interview:/)).toBeVisible();
    expect(section.getByText(/8 of 10 \(up 1.5 from the one before\)/)).toBeVisible();
    expect(section.getByText(/Timed test:/)).toBeVisible();
    expect(section.getByRole('link', { name: 'See practice scores over time' })).toHaveAttribute(
      'href',
      '/practice-history',
    );
  });

  it('has an empty state and does not break when the scores fail', async () => {
    open('/week', { [TRENDS]: () => json({ kinds: [] }) });
    expect(await screen.findByText('No practice scores yet.')).toBeVisible();
  });

  it('keeps the page when the scores cannot be loaded', async () => {
    open('/week', { [TRENDS]: () => apiError(500, 'internal', 'Boom.') });
    expect(await screen.findByText('Practice scores could not be loaded.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Week progress' })).toBeVisible();
  });
});

describe('Practice results on the day review', () => {
  const DATE = '2026-11-10';

  it('lists the practice finished that day, asking only for that day', async () => {
    const api = open(`/review/${DATE}`, {
      [HISTORY]: () =>
        json({
          sessions: [
            session(),
            session({
              id: '44444444-4444-4444-8444-444444444444',
              score: null,
              source: 'free_text',
            }),
          ],
        }),
    });
    const heading = await screen.findByRole('heading', { name: 'Practice on this day' });
    const section = within(heading.closest('section')!);
    expect(await section.findByText('Score 7.5 of 10')).toBeVisible();
    expect(section.getByText('No score')).toBeVisible();
    expect(section.getByText(/Mock interview · 25 min · Pasted feedback/)).toBeVisible();
    const url = new URL(api.calls.find((c) => c.url.includes('/practice/history'))!.url);
    expect(url.searchParams.get('from')).toBe(DATE);
    expect(url.searchParams.get('to')).toBe(DATE);
  });

  it('has an empty state', async () => {
    open(`/review/${DATE}`, { [HISTORY]: () => json({ sessions: [] }) });
    expect(await screen.findByText('No practice was finished on this day.')).toBeVisible();
  });
});
