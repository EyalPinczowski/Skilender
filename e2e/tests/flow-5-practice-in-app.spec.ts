import type { Page } from '@playwright/test';
import { expect, expectNoA11yViolations, signIn, test } from '../fixtures';
import { CHAT_REPLY, aiCalls, resetAi, scriptAi } from '../support/ai-stub';
import { openPractice, practiceTaskStatus, setUpPracticeTask } from '../support/practice';

/**
 * Practice in the in-app chat (spec 3.3). The API runs its real Groq and Cloudflare provider code;
 * their HTTPS calls go to a local scripted stub (support/ai-stub.ts), so no key, model or network.
 *
 * Order matters: a provider that answered 429 is "cooling down" in the API process for the rest of
 * the run (the API's clock is fixed), so the test that forces a 429 on the first provider comes
 * last in this file and nothing in a later file relies on that provider.
 */

async function startInAppChat(page: Page, taskId: string): Promise<void> {
  await openPractice(page, taskId);
  await page.getByRole('radio', { name: /Chat with the in-app assistant/ }).check();
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Practice chat' })).toBeVisible();
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByLabel('Your answer').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function askForFeedbackAndFinish(page: Page, markDone: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Get AI feedback' }).click();
  const dialog = page.getByRole('dialog', { name: 'Finish this practice' });
  await expect(dialog).toContainText('The AI will write feedback from your chat.');
  await dialog.getByLabel('Hours to log').fill('0.5');
  if (markDone) await dialog.getByRole('checkbox', { name: 'Mark task done' }).check();
  await dialog.getByRole('button', { name: 'Finish practice' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Practice finished' })).toBeVisible();
}

test('in-app practice: feedback that is not JSON is saved as plain text, nothing is lost', async ({
  page,
  api,
  user,
}) => {
  await resetAi();
  const taskId = await setUpPracticeTask(api);
  await signIn(page, user);
  await startInAppChat(page, taskId);

  await test.step('one chat turn', async () => {
    await say(page, 'I would start with a pivot table, then check the totals.');
    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log).toContainText(CHAT_REPLY);
    await expectNoA11yViolations(page, 'the in-app chat');
  });

  await test.step('the model answers the feedback request twice without JSON', async () => {
    // The first answer and the one retry are both broken, so the first text is kept as it was.
    await scriptAi('groq', [
      { content: 'You did well, but I will not give a number or a block.' },
      { content: 'Sorry, still not JSON.' },
    ]);
    await askForFeedbackAndFinish(page, false);
  });

  await test.step('the text is saved as plain text with no score, and the task stays open', async () => {
    await expect(page.getByText('Pasted text, saved as it was')).toBeVisible();
    await expect(page.getByText('No score: this feedback had no number.')).toBeVisible();
    await expect(
      page.getByText('No feedback block was found, so the text is saved as plain text.'),
    ).toBeVisible();
    await expect(
      page.getByText('You did well, but I will not give a number or a block.'),
    ).toBeVisible();
    await expect(page.getByText('Logged 0.5 h.')).toBeVisible();
    await expect(page.getByText('The task was not marked done.')).toBeVisible();
    await expectNoA11yViolations(page, 'the plain text result');
    expect(await practiceTaskStatus(api)).not.toBe('done');
    // One chat call, the broken feedback and its one retry: the retry is the only extra call.
    expect((await aiCalls()).filter((c) => c.provider === 'groq').map((c) => c.json)).toEqual([
      false,
      true,
      true,
    ]);
  });
});

test('in-app practice: a 429 on the first provider continues on the next, then AI feedback and done', async ({
  page,
  api,
  user,
}) => {
  await resetAi();
  const taskId = await setUpPracticeTask(api);
  await signIn(page, user);
  await startInAppChat(page, taskId);

  await test.step('the first provider is over its limit: the chat continues on the second', async () => {
    await scriptAi('groq', [{ status: 429 }]);
    await say(page, 'I would start with a pivot table, then check the totals.');
    const log = page.getByRole('log', { name: 'Conversation' });
    await expect(log).toContainText('Continuing on Cloudflare Workers AI.');
    await expect(log).toContainText(CHAT_REPLY);
    await expectNoA11yViolations(page, 'the chat after the switch');
  });

  await test.step('AI feedback, then finish and mark done on purpose', async () => {
    await askForFeedbackAndFinish(page, true);
    await expect(page.getByText('AI feedback', { exact: true })).toBeVisible();
    await expect(page.getByText('Score: 7 out of 10')).toBeVisible();
    await expect(page.getByText('Clear structure and one concrete example.')).toBeVisible();
    await expect(page.getByText('Open with the outcome.')).toBeVisible();
    await expect(page.getByText('AI feedback can be wrong.', { exact: false })).toBeVisible();
    await expect(page.getByText('The task is marked done.')).toBeVisible();
    await expectNoA11yViolations(page, 'the AI feedback result');
    expect(await practiceTaskStatus(api)).toBe('done');
  });

  await test.step('the stub saw one refused call, then the second provider for chat and feedback', async () => {
    const calls = await aiCalls();
    expect(calls.filter((c) => c.provider === 'groq')).toHaveLength(1);
    expect(calls.filter((c) => c.provider === 'cloudflare-ai').map((c) => c.json)).toEqual([
      false,
      true,
    ]);
  });
});
