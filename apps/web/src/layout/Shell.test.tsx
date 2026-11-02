import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { fakeAuth, installApi, json, meBody, renderApp, SESSION } from '../test/helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openApp() {
  installApi({ 'GET /api/v1/me': () => json(meBody()) });
  renderApp({ auth: fakeAuth(SESSION), path: '/' });
  return within(await screen.findByRole('navigation', { name: 'Main' }));
}

describe('app shell navigation', () => {
  it('has one main navigation with Today and Settings, marking the current page', async () => {
    const nav = await openApp();
    const today = nav.getByRole('link', { name: 'Today' });
    expect(today).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });

  it('is a bottom tab bar on a phone, a rail from 640 px and a sticky sidebar from 1024 px', async () => {
    await openApp();
    const classes = screen.getByRole('navigation', { name: 'Main' }).className.split(' ');
    // Phone: fixed to the bottom, scrolls sideways if it ever overflows.
    for (const c of ['fixed', 'bottom-0', 'overflow-x-auto']) expect(classes).toContain(c);
    // Tablet: in the page flow as a rail.
    for (const c of ['sm:static', 'sm:block', 'sm:w-56']) expect(classes).toContain(c);
    // Desktop: wider and sticky, still the same single navigation.
    for (const c of ['lg:sticky', 'lg:top-0', 'lg:w-64']) expect(classes).toContain(c);
  });

  it('offers the same destinations at every width, reachable with the keyboard', async () => {
    const nav = await openApp();
    expect(nav.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Today',
      'Week',
      'Plan',
      'Settings',
    ]);
    await userEvent.tab(); // skip link
    await userEvent.tab();
    expect(nav.getByRole('link', { name: 'Today' })).toHaveFocus();
  });

  it('lets Today and Week use the desktop width and keeps other pages in a reading column', async () => {
    await openApp();
    const column = screen.getByRole('main').firstElementChild!;
    expect(column.className).toContain('lg:max-w-none');
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.getByRole('main').firstElementChild!.className).not.toContain('lg:max-w-none');
  });

  it('gives every item a touch target of at least 44 by 44 px', async () => {
    const nav = await openApp();
    for (const link of nav.getAllByRole('link')) {
      expect(link.className).toContain('min-h-16');
      expect(link.className).toContain('min-w-24');
    }
  });

  it('shows each item with an icon and a text label, and marks the current one by more than colour', async () => {
    const nav = await openApp();
    const today = nav.getByRole('link', { name: 'Today' });
    expect(today.querySelector('svg')).not.toBeNull();
    expect(today.className).toContain('border-accent');
    expect(nav.getByRole('link', { name: 'Settings' }).className).toContain('border-transparent');
  });

  it('moves between pages and moves focus to the page content', async () => {
    const nav = await openApp();
    await userEvent.click(nav.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('has no automatically detectable accessibility violations on the home page', async () => {
    await openApp();
    await screen.findByRole('heading', { name: 'No plan yet' });
    await screen.findByText(/Connected/);
    await expectNoAxeViolations();
  });
});
