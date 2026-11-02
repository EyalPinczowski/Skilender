import { expect, expectNoA11yViolations, signIn, test } from '../fixtures';
import {
  PASTED_BLOCK,
  openPractice,
  practiceTaskStatus,
  setUpPracticeTask,
} from '../support/practice';

/**
 * Practice with another assistant (spec 3.3): copy the prompt, paste the assistant's feedback block
 * back, finish, and mark the task done on purpose. The app calls no AI on this path.
 */
test('practice with another assistant: copy the prompt, paste the block, finish, mark done', async ({
  page,
  api,
  context,
  user,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const taskId = await setUpPracticeTask(api);
  await signIn(page, user);
  await openPractice(page, taskId);
  await expectNoA11yViolations(page, 'the practice start screen');

  await test.step('start with another assistant', async () => {
    await page.getByRole('radio', { name: /Use Claude or another assistant/ }).check();
    await page.getByRole('button', { name: 'Start practice' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Prompt' })).toBeVisible();
  });

  await test.step('copy the ready-made prompt', async () => {
    const prompt = page.getByLabel('Practice prompt');
    await expect(prompt).toContainText('===FEEDBACK===');
    await page.getByRole('button', { name: 'Copy prompt' }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await prompt.innerText());
    await expectNoA11yViolations(page, 'the active practice');
  });

  await test.step('paste the feedback block and finish; marking done is a separate, unticked choice', async () => {
    await page.getByLabel('Reply from your assistant').fill(PASTED_BLOCK);
    await page.getByRole('button', { name: 'Finish with this feedback' }).click();
    const dialog = page.getByRole('dialog', { name: 'Finish this practice' });
    await expect(dialog).toContainText('Pasted feedback');
    const markDone = dialog.getByRole('checkbox', { name: 'Mark task done' });
    await expect(markDone).not.toBeChecked();
    await dialog.getByLabel('Hours to log').fill('1');
    await markDone.check();
    await expectNoA11yViolations(page, 'the finish dialog');
    await dialog.getByRole('button', { name: 'Finish practice' }).click();
  });

  await test.step('the parsed feedback is shown, and the task is done only because it was ticked', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Practice finished' })).toBeVisible();
    await expect(page.getByText('Pasted feedback', { exact: true })).toBeVisible();
    await expect(page.getByText('Score: 8 out of 10')).toBeVisible();
    await expect(page.getByText('Fast with lookups and a clean pivot table.')).toBeVisible();
    await expect(page.getByText('Practise conditional formatting rules.')).toBeVisible();
    await expect(page.getByText('Logged 1 h.')).toBeVisible();
    await expect(page.getByText('The task is marked done.')).toBeVisible();
    await expectNoA11yViolations(page, 'the finished practice');
    expect(await practiceTaskStatus(api)).toBe('done');
  });
});
