import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Block } from '../../api/client';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import {
  dayState,
  NOW,
  PLAN_ID,
  planDetail,
  planRoutes,
  previewResult,
  schedule,
} from '../../test/plan-fixtures';
import { addedMinutes, workAheadEffect } from './work-ahead';

afterEach(() => {
  vi.unstubAllGlobals();
  saved.length = 0;
});

const BASE = `/api/v1/plans/${PLAN_ID}`;
const TODAY = '2026-11-10';
const study = (
  taskId: string,
  date: string,
  start: string,
  end: string,
  minutes: number,
): Block => ({ taskId, date, start, end, minutes, kind: 'study' });
const CURRENT = [
  study('sql1', TODAY, '09:00', '12:00', 180),
  study('setup', '2026-11-11', '09:00', '09:30', 30),
  study('sql1', '2026-11-11', '09:30', '12:00', 150),
];
const PROPOSED = [
  study('sql1', TODAY, '09:00', '12:00', 180),
  study('setup', TODAY, '12:00', '13:00', 60),
  study('sql1', '2026-11-11', '09:00', '11:30', 150),
];
const titleOf = (id: string) => ({ sql1: 'Intro to SQL', setup: 'Set up accounts' })[id] ?? id;

describe('work-ahead helpers', () => {
  it('says the first task of tomorrow now starts today', () => {
    expect(workAheadEffect(CURRENT, PROPOSED, TODAY, titleOf)).toBe(
      'Tomorrow’s first task, Set up accounts, now starts today.',
    );
  });

  it('says how much more of a task that was already started moves into today', () => {
    const current = [
      study('sql1', TODAY, '09:00', '12:00', 180),
      study('sql1', '2026-11-11', '09:00', '11:00', 120),
    ];
    const proposed = [
      study('sql1', TODAY, '09:00', '13:00', 240),
      study('sql1', '2026-11-11', '09:00', '10:00', 60),
    ];
    expect(workAheadEffect(current, proposed, TODAY, titleOf)).toBe(
      '1 h more of Intro to SQL, Tomorrow’s first task, moves into today.',
    );
  });

  it('names the weekday when the next work is not tomorrow, and says nothing when nothing moves', () => {
    const current = [study('setup', '2026-11-12', '09:00', '10:00', 60)];
    const proposed = [study('setup', TODAY, '09:00', '10:00', 60)];
    expect(workAheadEffect(current, proposed, TODAY, titleOf)).toBe(
      'Thu’s first task, Set up accounts, now starts today.',
    );
    expect(workAheadEffect(CURRENT, CURRENT, TODAY, titleOf)).toBe('');
    expect(addedMinutes(CURRENT, PROPOSED, TODAY)).toBe(60);
    expect(addedMinutes(CURRENT, CURRENT, TODAY)).toBe(0);
  });
});

const saved: unknown[] = [];

function open(extra: Parameters<typeof planRoutes>[0] = {}) {
  const api = installApi(
    planRoutes({
      [`GET ${BASE}/schedule`]: () => json(schedule({ blocks: CURRENT })),
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('1 task moved, plan finish unchanged.'),
          proposed: { finishDate: '2026-11-20', warnings: [], blocks: PROPOSED },
        }),
      [`PUT ${BASE}/day-overrides/${TODAY}`]: async (request) => {
        const body = await request.json();
        saved.push(body);
        return json({ date: TODAY, ...body });
      },
      [`DELETE ${BASE}/day-overrides/${TODAY}`]: () => new Response(null, { status: 204 }),
      ...extra,
    }),
  );
  renderApp({ auth: fakeAuth(SESSION), path: '/' });
  return api;
}

const workAheadButton = () => screen.findByRole('button', { name: 'Work ahead' });
const bodyOf = async (call: Request | undefined) => (call ? await call.clone().json() : undefined);
const previewCall = (api: ReturnType<typeof open>) =>
  api.calls.find((c) => c.url.endsWith('/schedule/preview'));
const dayOff = {
  [`GET ${BASE}`]: () => json(planDetail({ overrides: [{ date: TODAY, isStudyDay: false }] })),
};

describe('Work ahead on Today', () => {
  it('previews first, saves only after approval, and shows the effect', async () => {
    const api = open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));

    expect(
      await screen.findByText(/Tomorrow’s first task, Set up accounts, now starts today\./),
    ).toBeInTheDocument();
    expect(await bodyOf(previewCall(api))).toEqual({
      today: TODAY,
      overrides: [{ date: TODAY, isStudyDay: true, capacityHours: 9 }],
    });
    // Nothing is saved yet.
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Add 2 h to today' }));
    await waitFor(() => expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(1));
    expect(saved).toEqual([{ isStudyDay: true, capacityHours: 9 }]);
    expect(
      await screen.findByText(/Today now has 9 h of study\. Tomorrow’s first task/),
    ).toBeInTheDocument();
  });

  it('cancelling the preview saves nothing', async () => {
    const api = open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 1 hour' }));
    await screen.findByText('What this would change');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('What this would change')).not.toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);
  });

  it('never saves by itself: opening the panel only reads', async () => {
    const api = open();
    await userEvent.setup().click(await workAheadButton());
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('explains that the study window is the limit and offers no approval when nothing fits', async () => {
    open({
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('Nothing moved.'),
          proposed: { finishDate: '2026-11-20', warnings: [], blocks: CURRENT },
        }),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 3 hours' }));
    expect(await screen.findByText(/has no room for more today/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 3 h to today' })).toBeDisabled();
  });

  it('says when only part of the extra time fits', async () => {
    open({
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('1 task moved.'),
          proposed: {
            finishDate: '2026-11-20',
            warnings: [],
            blocks: [...CURRENT, study('setup', TODAY, '12:00', '12:30', 30)],
          },
        }),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));
    expect(
      await screen.findByText(/Only 0.5 h more fits in your study window/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 2 h to today' })).toBeEnabled();
  });

  it('on a day off offers "Make today a study day" with hours', async () => {
    const api = open(dayOff);
    const user = userEvent.setup();
    expect(await screen.findByText(/Today has its own setting: day off/)).toBeInTheDocument();
    await user.click(await workAheadButton());
    expect(screen.getByText('Today is not a study day')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add 1 hour' })).not.toBeInTheDocument();
    const hours = screen.getByRole('spinbutton', { name: 'Hours today' });
    await user.clear(hours);
    await user.type(hours, '4');
    await user.click(screen.getByRole('button', { name: 'Make today a study day' }));
    const heading = await screen.findByText('What this would change');
    expect(await bodyOf(previewCall(api))).toEqual({
      today: TODAY,
      overrides: [{ date: TODAY, isStudyDay: true, capacityHours: 4 }],
    });
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);
    await user.click(
      within(heading.parentElement!).getByRole('button', { name: 'Make today a study day' }),
    );
    await waitFor(() => expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(1));
    expect(saved).toEqual([{ isStudyDay: true, capacityHours: 4 }]);
  });

  it('asks for the hours before previewing', async () => {
    const api = open(dayOff);
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.clear(screen.getByRole('spinbutton', { name: 'Hours today' }));
    await user.click(screen.getByRole('button', { name: 'Make today a study day' }));
    expect(screen.getByText('Enter how many hours you want to study today.')).toBeInTheDocument();
    expect(previewCall(api)).toBeUndefined();
  });

  it('"Back to normal" removes today’s exception', async () => {
    const api = open({
      [`GET ${BASE}`]: () =>
        json(planDetail({ overrides: [{ date: TODAY, isStudyDay: true, capacityHours: 9 }] })),
    });
    const user = userEvent.setup();
    expect(
      await screen.findByText(/Today has its own setting: study day, 9 h/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to normal' }));
    await waitFor(() => expect(api.count(`DELETE ${BASE}/day-overrides/${TODAY}`)).toBe(1));
    expect(
      await screen.findByText(/Back to normal: today follows your usual hours/),
    ).toBeInTheDocument();
  });

  it('has no Back to normal when today has no exception', async () => {
    open();
    await workAheadButton();
    expect(screen.queryByRole('button', { name: 'Back to normal' })).not.toBeInTheDocument();
  });

  it('is not offered once the day has ended', async () => {
    open({
      [`GET ${BASE}/days/${TODAY}`]: () =>
        json(
          dayState({
            status: 'ended',
            startedAt: NOW,
            endedAt: NOW,
            frozen: { frozenAt: NOW, source: 'day_end', blocks: [] },
          }),
        ),
    });
    await screen.findByText('Day ended');
    expect(screen.queryByRole('button', { name: 'Work ahead' })).not.toBeInTheDocument();
  });

  it('shows the API’s message when saving is refused', async () => {
    open({
      [`PUT ${BASE}/day-overrides/${TODAY}`]: () =>
        apiError(422, 'unprocessable', 'A plan can have at most 1000 day overrides.'),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 1 hour' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 h to today' }));
    expect(
      await screen.findByText('A plan can have at most 1000 day overrides.'),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations with the preview open', async () => {
    open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));
    await screen.findByText('What this would change');
    await expectNoAxeViolations();
  });
});
