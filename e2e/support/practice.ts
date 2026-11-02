import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { acceptCurrentLegal, importDemoPlan } from './api';
import { API_NO_AI_URL, API_URL } from './env';

/** Helpers for the practice flows (spec 3.3). */

/** The demo plan's timed Excel test: a practice task with written steps for the self-check. */
export const PRACTICE_TASK_TITLE = 'Timed Excel test (45 min)';

/** Accepts the Terms, imports the demo plan and returns the practice task's id. */
export async function setUpPracticeTask(api: APIRequestContext): Promise<string> {
  await acceptCurrentLegal(api);
  const planId = await importDemoPlan(api);
  const response = await api.get(`/api/v1/plans/${planId}/tasks`);
  expect(response.ok(), await response.text()).toBe(true);
  const { tasks } = (await response.json()) as { tasks: { id: string; title: string }[] };
  const task = tasks.find((t) => t.title === PRACTICE_TASK_TITLE);
  expect(task, `the demo plan has "${PRACTICE_TASK_TITLE}"`).toBeDefined();
  return task!.id;
}

export async function openPractice(page: Page, taskId: string): Promise<void> {
  await page.goto(`/practice/${taskId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Practice' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Start practice' })).toBeVisible();
}

/** The status of the practice task as the API sees it. */
export async function practiceTaskStatus(api: APIRequestContext): Promise<string | undefined> {
  const plans = (await (await api.get('/api/v1/plans')).json()) as { plans: { id: string }[] };
  const response = await api.get(`/api/v1/plans/${plans.plans[0]!.id}/tasks`);
  const { tasks } = (await response.json()) as { tasks: { title: string; status: string }[] };
  return tasks.find((t) => t.title === PRACTICE_TASK_TITLE)?.status;
}

/**
 * Sends every API call of the page to the API process that has no AI provider, from now on. The
 * database is shared, so a session started before keeps going: the app then meets "no AI".
 */
export async function switchToApiWithoutAi(page: Page): Promise<void> {
  await page.route(`${API_URL}/**`, (route) => {
    const url = new URL(route.request().url());
    return route.continue({ url: `${API_NO_AI_URL}${url.pathname}${url.search}` });
  });
}

/** The feedback block an outside assistant ends with (the format asked for in the prompt). */
export const PASTED_BLOCK = [
  'Great session. Here is where you stand.',
  '',
  '===FEEDBACK===',
  'score: 8/10',
  'strengths: Fast with lookups and a clean pivot table.',
  'improve: Check the totals before moving on.',
  'next_focus: Practise conditional formatting rules.',
  '===END===',
].join('\n');
