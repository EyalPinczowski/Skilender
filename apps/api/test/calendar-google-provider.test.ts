import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_CALENDAR_NAME, APP_EVENT_SOURCE } from '@skillstack/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CalendarAuthError,
  CalendarConflictError,
  CalendarPreconditionFailedError,
  CalendarRequestError,
  CalendarRetryableError,
  CalendarSyncTokenExpiredError,
} from '../src/modules/calendar/errors';
import {
  createRefreshingTokenSupplier,
  GoogleCalendarProvider,
  refreshAccessToken,
} from '../src/modules/calendar/google-provider';
import { mintInsertTarget, mintTarget } from '../src/modules/calendar/guarded';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  ifMatch: string | undefined;
  body: string;
}
type Handler = (req: Seen, res: ServerResponse) => void;

let server: Server;
let base: string;
let seen: Seen[];
let handler: Handler;

const json = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => json(res, 200, {});
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        ifMatch: req.headers['if-match'],
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

const provider = (getAccessToken = async () => 'tok-1') =>
  new GoogleCalendarProvider({ apiBase: `${base}/calendar/v3`, getAccessToken });

const evTarget = mintTarget('app@group', 'e/1');
const calTarget = mintInsertTarget('app@group');
const time = { dateTime: '2026-11-03T09:00:00+00:00' };

describe('GoogleCalendarProvider', () => {
  it('lists calendars across pages and maps them to domain types', async () => {
    handler = (req, res) =>
      req.url.includes('pageToken=p2')
        ? json(res, 200, { items: [{ id: 'b', summary: APP_CALENDAR_NAME, accessRole: 'owner' }] })
        : json(res, 200, {
            items: [{ id: 'a', summary: 'Me', primary: true, accessRole: 'weird' }],
            nextPageToken: 'p2',
          });
    expect(await provider().listCalendars()).toEqual([
      { id: 'a', name: 'Me', primary: true, accessRole: 'unknown' },
      { id: 'b', name: APP_CALENDAR_NAME, primary: false, accessRole: 'owner' },
    ]);
    expect(seen[0]?.auth).toBe('Bearer tok-1');
  });

  it('lists events with a window, drops unknown fields and keeps cancelled stubs', async () => {
    handler = (_req, res) =>
      json(res, 200, {
        items: [
          {
            id: '1',
            start: time,
            end: time,
            summary: 'Call',
            attendees: [{ email: 'a@b.c', self: true }],
            creator: { email: 'x' },
          },
          { id: '2', status: 'cancelled' },
        ],
        nextSyncToken: 'sync-1',
      });
    const page = await provider().listEvents(
      'cal 1',
      '2026-11-01T00:00:00Z',
      '2026-11-08T00:00:00Z',
      {
        privateTags: { source: APP_EVENT_SOURCE },
      },
    );
    const url = new URL(seen[0]!.url, base);
    expect(url.pathname).toBe('/calendar/v3/calendars/cal%201/events');
    expect(url.searchParams.get('timeMin')).toBe('2026-11-01T00:00:00Z');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('privateExtendedProperty')).toBe(`source=${APP_EVENT_SOURCE}`);
    expect(page.nextSyncToken).toBe('sync-1');
    expect(page.events[0]).not.toHaveProperty('creator');
    expect(page.events[0]?.attendees?.[0]).toEqual({ self: true });
    expect(page.events[1]).toMatchObject({ id: '2', status: 'cancelled' });
  });

  it('omits the time window when resuming with a sync token, and maps 410 to a typed error', async () => {
    handler = (_req, res) =>
      json(res, 410, { error: { errors: [{ reason: 'fullSyncRequired' }] } });
    await expect(
      provider().listEvents('c', '2026-11-01T00:00:00Z', null, { syncToken: 's' }),
    ).rejects.toBeInstanceOf(CalendarSyncTokenExpiredError);
    const url = new URL(seen[0]!.url, base);
    expect(url.searchParams.get('syncToken')).toBe('s');
    expect(url.searchParams.has('timeMin')).toBe(false);
  });

  it('getEvent returns null on 404 and 410, and throws on other errors', async () => {
    handler = (_req, res) => json(res, 404, { error: { errors: [{ reason: 'notFound' }] } });
    expect(await provider().getEvent('c', 'e')).toBeNull();
    handler = (_req, res) => json(res, 410, {});
    expect(await provider().getEvent('c', 'e')).toBeNull();
    handler = (_req, res) => json(res, 400, {});
    await expect(provider().getEvent('c', 'e')).rejects.toBeInstanceOf(CalendarRequestError);
  });

  it('creates a calendar, inserts, patches and deletes with the right requests', async () => {
    handler = (req, res) => {
      if (req.url.endsWith('/calendars'))
        return json(res, 200, { id: 'new', summary: APP_CALENDAR_NAME, accessRole: 'owner' });
      if (req.method === 'DELETE') {
        res.writeHead(204);
        return res.end();
      }
      return json(res, 200, {
        id: 'e1',
        start: time,
        end: time,
        extendedProperties: { private: { source: APP_EVENT_SOURCE, task_id: 't' } },
      });
    };
    const p = provider();
    expect((await p.createCalendar(APP_CALENDAR_NAME)).id).toBe('new');
    expect(JSON.parse(seen[0]!.body)).toEqual({ summary: APP_CALENDAR_NAME });

    const tags = { source: APP_EVENT_SOURCE, task_id: 't' };
    await p.insertEvent(calTarget, {
      id: 'abc12',
      summary: 'S',
      start: time,
      end: time,
      privateTags: tags,
    });
    expect(seen[1]).toMatchObject({
      method: 'POST',
      url: '/calendar/v3/calendars/app%40group/events',
    });
    expect(JSON.parse(seen[1]!.body)).toEqual({
      id: 'abc12',
      summary: 'S',
      start: time,
      end: time,
      extendedProperties: { private: tags },
    });

    await p.patchEvent(evTarget, { summary: 'M', privateTags: tags });
    expect(seen[2]).toMatchObject({
      method: 'PATCH',
      url: '/calendar/v3/calendars/app%40group/events/e%2F1',
    });

    await p.deleteEvent(evTarget);
    expect(seen[3]).toMatchObject({ method: 'DELETE' });
  });

  it('treats deleting an already-deleted event as success', async () => {
    handler = (_req, res) => json(res, 410, {});
    await expect(provider().deleteEvent(evTarget)).resolves.toBeUndefined();
  });

  it('retries a 401 once with a refreshed token; a second 401 is a request error, not a reconnect', async () => {
    const asked: (boolean | undefined)[] = [];
    const supplier = async (o?: { forceRefresh?: boolean }) => {
      asked.push(o?.forceRefresh);
      return asked.length === 1 ? 'stale' : 'fresh';
    };
    handler = (req, res) =>
      req.auth === 'Bearer fresh'
        ? json(res, 200, { items: [] })
        : json(res, 401, { error: { message: 'x' } });
    await provider(supplier).listCalendars();
    expect(asked).toEqual([undefined, true]);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);

    handler = (_req, res) => json(res, 401, {});
    const error = await provider()
      .listCalendars()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarRequestError);
    expect(error).not.toBeInstanceOf(CalendarAuthError);
  });

  it('sends If-Match from the target etag on patch and delete, and maps 412', async () => {
    const t = mintTarget('app@group', 'e1', '"etag-1"');
    handler = (_req, res) => json(res, 412, { error: { errors: [{ reason: 'conditionNotMet' }] } });
    await expect(provider().patchEvent(t, { privateTags: {} })).rejects.toBeInstanceOf(
      CalendarPreconditionFailedError,
    );
    await expect(provider().deleteEvent(t)).rejects.toBeInstanceOf(CalendarPreconditionFailedError);
    expect(seen.map((r) => r.ifMatch)).toEqual(['"etag-1"', '"etag-1"']);
  });

  it('maps 409 on insert to CalendarConflictError', async () => {
    handler = (_req, res) => json(res, 409, { error: { errors: [{ reason: 'duplicate' }] } });
    await expect(
      provider().insertEvent(calTarget, {
        id: 'abc12',
        summary: 'S',
        start: time,
        end: time,
        privateTags: {},
      }),
    ).rejects.toBeInstanceOf(CalendarConflictError);
  });

  it('always sends singleEvents=true, also on an incremental sync, and refuses sync with a filter', async () => {
    handler = (_req, res) => json(res, 200, { items: [], nextSyncToken: 'n' });
    await provider().listEvents('c', null, null, { syncToken: 's1' });
    expect(new URL(seen[0]!.url, base).searchParams.get('singleEvents')).toBe('true');
    await expect(
      provider().listEvents('c', null, null, { syncToken: 's1', privateTags: { source: 'x' } }),
    ).rejects.toBeInstanceOf(CalendarRequestError);
    expect(seen).toHaveLength(1);
  });

  it('maps 429, 5xx and rate-limit 403 to a retryable error with Retry-After', async () => {
    handler = (_req, res) => json(res, 429, {}, { 'retry-after': '7' });
    const e429 = await provider()
      .listCalendars()
      .catch((e: unknown) => e);
    expect(e429).toBeInstanceOf(CalendarRetryableError);
    expect((e429 as CalendarRetryableError).retryAfterMs).toBe(7000);

    handler = (_req, res) => json(res, 503, {});
    await expect(provider().listCalendars()).rejects.toBeInstanceOf(CalendarRetryableError);

    handler = (_req, res) =>
      json(res, 403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
    await expect(provider().listCalendars()).rejects.toBeInstanceOf(CalendarRetryableError);

    handler = (_req, res) => json(res, 403, { error: { errors: [{ reason: 'forbidden' }] } });
    await expect(provider().listCalendars()).rejects.toBeInstanceOf(CalendarRequestError);
  });

  it('maps a connection failure to a retryable error', async () => {
    const dead = new GoogleCalendarProvider({
      apiBase: 'http://127.0.0.1:1',
      getAccessToken: async () => 't',
    });
    await expect(dead.listCalendars()).rejects.toBeInstanceOf(CalendarRetryableError);
  });

  it('never puts a token in an error message', async () => {
    handler = (_req, res) => json(res, 500, { error: { message: 'secret-token-123' } });
    const error = (await provider(async () => 'secret-token-123')
      .listCalendars()
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('secret-token-123');
    expect(JSON.stringify(error)).not.toContain('secret-token-123');
  });
});

describe('token refresh', () => {
  const opts = () => ({
    oauthBase: base,
    clientId: 'cid',
    clientSecret: 'csecret',
    refreshToken: 'rt-secret',
  });

  it('posts the refresh grant and returns the new access token', async () => {
    handler = (_req, res) =>
      json(res, 200, { access_token: 'new-at', expires_in: 3599, token_type: 'Bearer' });
    expect(await refreshAccessToken(opts())).toEqual({
      accessToken: 'new-at',
      expiresInSeconds: 3599,
    });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/token' });
    const form = new URLSearchParams(seen[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-secret',
      client_id: 'cid',
      client_secret: 'csecret',
    });
  });

  it('maps invalid_grant to CalendarAuthError without echoing secrets', async () => {
    handler = (_req, res) =>
      json(res, 400, { error: 'invalid_grant', error_description: 'Token revoked' });
    const error = (await refreshAccessToken(opts()).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(CalendarAuthError);
    expect(error.message).not.toContain('rt-secret');
  });

  it('maps 503 to retryable and a body without access_token to a request error', async () => {
    handler = (_req, res) => json(res, 503, {});
    await expect(refreshAccessToken(opts())).rejects.toBeInstanceOf(CalendarRetryableError);
    handler = (_req, res) => json(res, 200, {});
    await expect(refreshAccessToken(opts())).rejects.toBeInstanceOf(CalendarRequestError);
  });

  it('the supplier caches until near expiry, refreshes on demand and shares concurrent refreshes', async () => {
    let now = 0;
    let calls = 0;
    const supplier = createRefreshingTokenSupplier(
      async () => ({ accessToken: `at-${(calls += 1)}`, expiresInSeconds: 3600 }),
      async () => 'rt',
      () => now,
    );
    expect(await Promise.all([supplier(), supplier()])).toEqual(['at-1', 'at-1']);
    expect(await supplier()).toBe('at-1');
    expect(await supplier({ forceRefresh: true })).toBe('at-2');
    now = 3600 * 1000;
    expect(await supplier()).toBe('at-3');
  });
});
