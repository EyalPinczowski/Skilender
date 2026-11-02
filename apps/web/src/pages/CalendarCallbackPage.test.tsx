import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createQueryClient } from '../lib/query-client';
import * as navigate from '../lib/navigate';
import { expectNoAxeViolations } from '../test/axe';
import { apiError, ENV, fakeAuth, installApi, json, meBody, SESSION } from '../test/helpers';

const redirect = vi.spyOn(navigate, 'redirectTo').mockImplementation(() => {});
const STATUS = { status: 'connected', lastSyncedAt: null, lastErrorCode: null, sources: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  redirect.mockClear();
  window.history.replaceState(null, '', '/');
});

function open(
  search: string,
  routes: Parameters<typeof installApi>[0] = {},
  { strict = false } = {},
) {
  // The page reads the real address bar, like in the browser.
  window.history.replaceState(null, '', `/calendar/callback${search}`);
  const api = installApi({
    'GET /api/v1/me': () => json(meBody()),
    'GET /api/v1/calendar': () => json(STATUS),
    'POST /api/v1/calendar/sync': () =>
      json({ status: 'cached', syncedAt: null, movedTaskIds: [], finishChanged: false, text: '' }),
    ...routes,
  });
  const tree = (
    <MemoryRouter initialEntries={['/calendar/callback']}>
      <App env={ENV} queryClient={createQueryClient()} auth={fakeAuth(SESSION)} />
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return api;
}

const posts = (api: ReturnType<typeof installApi>) =>
  api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/calendar/callback'));

describe('calendar callback page', () => {
  it('removes code and state from the address bar, posts them once and shows success', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    let body: unknown;
    const api = open('?code=the-code&state=the-state&scope=x', {
      'POST /api/v1/calendar/callback': async (request) => {
        body = await request.json();
        return json(STATUS);
      },
    });
    expect(await screen.findByText('Google Calendar is connected.')).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('the-code');
    expect(replace).toHaveBeenCalled();
    replace.mockRestore();
    expect(body).toEqual({ code: 'the-code', state: 'the-state' });
    expect(posts(api)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    await expectNoAxeViolations();
  });

  it('posts only once under React strict mode', async () => {
    const api = open(
      '?code=c&state=s',
      { 'POST /api/v1/calendar/callback': () => json(STATUS) },
      { strict: true },
    );
    expect(await screen.findByText('Google Calendar is connected.')).toBeInTheDocument();
    expect(posts(api)).toHaveLength(1);
  });

  it('tells the person to allow both permissions on scopes_not_granted', async () => {
    open('?code=c&state=s', {
      'POST /api/v1/calendar/callback': () =>
        apiError(400, 'scopes_not_granted', 'Not all scopes granted.'),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Both permissions are needed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Google Calendar is connected.')).not.toBeInTheDocument();
  });

  it('shows a general message with a retry for any other error', async () => {
    const api = open('?code=c&state=s', {
      'POST /api/v1/calendar/callback': () => apiError(400, 'invalid_state', 'Bad state.'),
      'POST /api/v1/calendar/connect': () =>
        json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=n' }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t finish connecting');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.count('POST /api/v1/calendar/connect')).toBe(1));
    expect(redirect).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=n');
  });

  it('handles access_denied without calling the API', async () => {
    const api = open('?error=access_denied&state=s');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('access was not allowed');
    expect(window.location.search).toBe('');
    expect(posts(api)).toHaveLength(0);
    expect(within(document.body).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('explains a link without code and state and does not call the API', async () => {
    const api = open('');
    expect(await screen.findByRole('alert')).toHaveTextContent('missing');
    expect(posts(api)).toHaveLength(0);
  });
});
