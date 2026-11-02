import type { Page } from '@playwright/test';
import { expect, expectNoA11yViolations, signIn, test } from '../fixtures';
import {
  openPractice,
  practiceTaskStatus,
  setUpPracticeTask,
  switchToApiWithoutAi,
} from '../support/practice';

/**
 * Practice with no AI provider (spec 3.3, "the app must work with AI off"). The page talks to a
 * second API process of the same build that has no provider configured.
 */

async function finishWithAllStepsTicked(page: Page): Promise<void> {
  const steps = page.getByRole('group', { name: 'Steps I completed' }).getByRole('checkbox');
  const count = await steps.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) await steps.nth(i).check();
  await page.getByRole('button', { name: 'Finish with this self-check' }).click();
  const dialog = page.getByRole('dialog', { name: 'Finish this practice' });
  await expect(dialog).toContainText(`Self-check: ${count} of ${count} steps ticked.`);
  await dialog.getByLabel('Hours to log').fill('1');
  await dialog.getByRole('button', { name: 'Finish practice' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Practice finished' })).toBeVisible();
  await expect(page.getByText('Your self-check', { exact: true })).toBeVisible();
  await expect(page.getByText('Score: 10 out of 10')).toBeVisible();
  await expect(page.getByText('Logged 1 h.')).toBeVisible();
  await expect(page.getByText('The task was not marked done.')).toBeVisible();
}

test('no AI configured: the chat is not offered, and a self-check finishes the practice', async ({
  page,
  api,
  user,
}) => {
  const taskId = await setUpPracticeTask(api);
  await switchToApiWithoutAi(page);
  await signIn(page, user);
  await openPractice(page, taskId);

  await expect(page.getByRole('radio', { name: /Chat with the in-app assistant/ })).toHaveCount(0);
  await expectNoA11yViolations(page, 'the start screen with AI off');
  await page.getByRole('radio', { name: /Practise on my own/ }).check();
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Score yourself' })).toBeVisible();

  await finishWithAllStepsTicked(page);
  await expectNoA11yViolations(page, 'the self-check result');
  // A rubric never marks anything done by itself.
  expect(await practiceTaskStatus(api)).not.toBe('done');
});

test('the AI goes away mid-chat: the notice names the fallbacks, and a self-check still finishes', async ({
  page,
  api,
  user,
}) => {
  const taskId = await setUpPracticeTask(api);
  await signIn(page, user);
  await openPractice(page, taskId);

  await test.step('start the chat while an AI is configured', async () => {
    await page.getByRole('radio', { name: /Chat with the in-app assistant/ }).check();
    await page.getByRole('button', { name: 'Start practice' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Practice chat' })).toBeVisible();
  });

  await test.step('from now on no provider can answer', async () => {
    await switchToApiWithoutAi(page);
    await page.getByLabel('Your answer').fill('I would start with a pivot table.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'AI unavailable' });
    await expect(notice).toContainText('You can still practise: copy the prompt below');
    // The failed send is kept for a retry, so the button now reads "Send again"; it is off.
    await expect(page.getByRole('button', { name: 'Send again', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Get AI feedback' })).toBeDisabled();
  });

  await test.step('the copy-prompt and paste flow and the self-check are offered', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Prompt' })).toBeVisible();
    await expect(page.getByLabel('Reply from your assistant')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Score yourself' })).toBeVisible();
    await expectNoA11yViolations(page, 'the chat with the AI unavailable');
  });

  await test.step('finish with the self-check', async () => {
    await finishWithAllStepsTicked(page);
    expect(await practiceTaskStatus(api)).not.toBe('done');
  });
});
