import { expect, expectNoA11yViolations, signIn, test } from '../fixtures';
import { loadDemoPlan } from '../support/ui';

/**
 * Layout at four widths (phone, tablet, desktop, wide): the right navigation is shown, nothing
 * scrolls sideways from 320 px up, and Today and Week use two columns from 1024 px. Screenshots go
 * to the test output folder (git-ignored); they are not stored in the repository.
 */
const WIDTHS = [390, 820, 1280, 1600] as const;

for (const width of WIDTHS) {
  test(`layout at ${width} px: navigation, no sideways scroll, no clipped page`, async ({
    page,
    user,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, user);
    await loadDemoPlan(page);

    const nav = page.getByRole('navigation', { name: 'Main' });
    const noSidewaysScroll = async (screen: string) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${screen} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
    };

    await test.step('Today', async () => {
      await expect(nav.getByRole('link', { name: 'Today' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      const box = (await nav.boundingBox())!;
      if (width < 640) {
        expect(box.y, 'tab bar sits at the bottom').toBeGreaterThan(500);
        expect(box.width).toBeGreaterThanOrEqual(width - 1);
      } else {
        expect(box.x, 'rail or sidebar sits on the left').toBeLessThan(width / 2);
        expect(box.width).toBeLessThan(width / 3);
        if (width >= 1024) expect(box.width).toBeGreaterThanOrEqual(256);
      }
      const tasks = page.getByRole('region', { name: 'Today’s blocks' });
      const upcoming = page.getByRole('region', { name: 'Coming up' });
      if (width >= 1024) {
        const a = (await tasks.boundingBox())!;
        const b = (await upcoming.boundingBox())!;
        expect(b.x, 'Coming up is beside today’s tasks').toBeGreaterThan(a.x + a.width - 1);
      }
      await noSidewaysScroll('Today');
      await page.screenshot({ path: testInfo.outputPath(`today-${width}.png`), fullPage: true });
      if (width === 1280) await expectNoA11yViolations(page, 'Today at desktop width');
    });

    await test.step('Week', async () => {
      await nav.getByRole('link', { name: 'Week' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Week' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Open tasks' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Week' })).toHaveAttribute('aria-current', 'page');
      if (width >= 1024) {
        const a = (await page.getByRole('heading', { name: 'Week progress' }).boundingBox())!;
        const b = (await page.getByRole('heading', { name: 'Open tasks' }).boundingBox())!;
        expect(b.x, 'Open tasks is in the second column').toBeGreaterThan(a.x + 100);
      }
      await noSidewaysScroll('Week');
      await page.screenshot({ path: testInfo.outputPath(`week-${width}.png`), fullPage: true });
      if (width === 1280) await expectNoA11yViolations(page, 'Week at desktop width');
    });

    await test.step('Settings', async () => {
      await nav.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await noSidewaysScroll('Settings');
      await page.screenshot({
        path: testInfo.outputPath(`settings-${width}.png`),
        fullPage: true,
      });
      if (width === 1280) await expectNoA11yViolations(page, 'Settings at desktop width');
    });
  });
}

test('no sideways scroll at 320 px on Today, Week and Settings', async ({ page, user }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await signIn(page, user);
  await loadDemoPlan(page);
  for (const [name, path] of [
    ['Today', '/'],
    ['Week', '/week'],
    ['Settings', '/settings'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} scrolls sideways at 320 px`).toBeLessThanOrEqual(0);
  }
});
