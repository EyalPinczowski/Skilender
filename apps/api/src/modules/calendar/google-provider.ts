import { CalendarEventSchema, type CalendarEvent } from '@skillstack/shared';
import {
  CalendarAuthError,
  CalendarConflictError,
  CalendarPreconditionFailedError,
  CalendarRequestError,
  CalendarRetryableError,
  CalendarSyncTokenExpiredError,
} from './errors';
import type {
  CalendarInfo,
  CalendarProvider,
  EventInsert,
  EventPage,
  EventPatch,
  GuardedInsertTarget,
  GuardedTarget,
  ListEventsOptions,
} from './provider';

/**
 * Google Calendar implementation of CalendarProvider, over the global `fetch`.
 * Base URLs come from config so e2e can point at a local stub. Nothing here logs; access tokens
 * and refresh tokens are only ever placed in request headers or bodies, never in messages.
 * Endpoint paths and field names follow Google's Calendar API v3 as recalled: needs check.
 */

/** Returns a current access token. `forceRefresh` asks for a new one (after a 401). */
export type AccessTokenSupplier = (options?: { forceRefresh?: boolean }) => Promise<string>;

export interface GoogleProviderOptions {
  /** e.g. https://www.googleapis.com/calendar/v3 (no trailing slash). */
  apiBase: string;
  getAccessToken: AccessTokenSupplier;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES_GUARD = 1000;

const enc = encodeURIComponent;

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** The `error` string (OAuth) or first `errors[].reason` (Calendar API) of a JSON error body. */
async function errorReason(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const o = body as { error?: unknown };
    if (typeof o.error === 'string') return o.error;
    if (typeof o.error === 'object' && o.error !== null) {
      const errors = (o.error as { errors?: unknown }).errors;
      const first = Array.isArray(errors)
        ? (errors[0] as { reason?: unknown } | undefined)
        : undefined;
      if (typeof first?.reason === 'string') return first.reason;
    }
  } catch {
    // Not JSON: fall through.
  }
  return null;
}

/** Maps a non-2xx response to a typed error. Never includes the body in the message. */
async function toError(res: Response, tokenEndpoint = false): Promise<Error> {
  const reason = await errorReason(res);
  const status = res.status;
  // Only the token endpoint can say the grant is gone. A Calendar API 401 (even after a forced
  // refresh) is a request error, not a reason to make the user reconnect.
  if (tokenEndpoint && (reason === 'invalid_grant' || reason === 'invalid_client')) {
    return new CalendarAuthError(reason);
  }
  if (!tokenEndpoint && status === 412) return new CalendarPreconditionFailedError();
  if (!tokenEndpoint && status === 409) return new CalendarConflictError();
  if (
    status === 429 ||
    status >= 500 ||
    (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))
  ) {
    return new CalendarRetryableError(reason ?? `http_${status}`, status, retryAfterMs(res));
  }
  return new CalendarRequestError(reason ?? `http_${status}`, status);
}

async function send(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Network failure or timeout. The cause is dropped on purpose: it can echo the URL.
    throw new CalendarRetryableError('network', null);
  }
}

function toEvent(raw: unknown): CalendarEvent {
  // Cancelled stubs (sync, showDeleted) come without start/end.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { status?: unknown }).status === 'cancelled'
  ) {
    raw = { start: {}, end: {}, ...raw };
  }
  const parsed = CalendarEventSchema.safeParse(raw);
  if (!parsed.success) throw new CalendarRequestError('malformed_event', null);
  return parsed.data;
}

const isGone = (error: unknown) =>
  error instanceof CalendarRequestError && (error.status === 404 || error.status === 410);

const ACCESS_ROLES = new Set(['owner', 'writer', 'reader', 'freeBusyReader']);

function toCalendar(raw: unknown): CalendarInfo {
  const o = (raw ?? {}) as {
    id?: unknown;
    summary?: unknown;
    primary?: unknown;
    accessRole?: unknown;
  };
  if (typeof o.id !== 'string' || o.id === '')
    throw new CalendarRequestError('malformed_calendar', null);
  const role =
    typeof o.accessRole === 'string' && ACCESS_ROLES.has(o.accessRole) ? o.accessRole : 'unknown';
  return {
    id: o.id,
    name: typeof o.summary === 'string' ? o.summary : '',
    primary: o.primary === true,
    accessRole: role as CalendarInfo['accessRole'],
  };
}

function eventBody(e: Partial<EventInsert> & { id?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (e.id !== undefined) body.id = e.id;
  if (e.summary !== undefined) body.summary = e.summary;
  if (e.description !== undefined) body.description = e.description;
  if (e.start !== undefined) body.start = e.start;
  if (e.end !== undefined) body.end = e.end;
  if (e.privateTags !== undefined) body.extendedProperties = { private: e.privateTags };
  return body;
}

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleProviderOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** One authorised request. On 401 it retries once with a freshly refreshed token. */
  private async call(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<Response> {
    const url = `${this.options.apiBase}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.options.getAccessToken(
        attempt > 0 ? { forceRefresh: true } : undefined,
      );
      const res = await send(
        this.doFetch,
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(ifMatch ? { 'if-match': ifMatch } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        this.timeoutMs,
      );
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw await toError(res);
      return res;
    }
  }

  private async json(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<unknown> {
    const res = await this.call(method, path, body, ifMatch);
    try {
      return await res.json();
    } catch {
      throw new CalendarRequestError('malformed_response', res.status);
    }
  }

  /** calendarList.list needs the calendar.readonly scope (we request it); app.created alone is not enough. */
  async listCalendars(): Promise<CalendarInfo[]> {
    const calendars: CalendarInfo[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < MAX_PAGES_GUARD; i += 1) {
      const query = new URLSearchParams(pageToken ? { pageToken } : {});
      const data = (await this.json('GET', `/users/me/calendarList?${query}`)) as {
        items?: unknown[];
        nextPageToken?: string;
      };
      for (const item of data.items ?? []) calendars.push(toCalendar(item));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return calendars;
  }

  async listEvents(
    calendarId: string,
    timeMin: string | null,
    timeMax: string | null,
    options: ListEventsOptions = {},
  ): Promise<EventPage> {
    const query = new URLSearchParams({ maxResults: '250' });
    const filter = Object.entries(options.privateTags ?? {});
    if (options.syncToken && filter.length > 0) {
      // Google does not allow extended-property filters on an incremental sync.
      throw new CalendarRequestError('sync_token_with_filter', null);
    }
    // Recurring events are expanded so each occurrence is its own busy interval. A sync must use
    // the same value as the listing that produced its token, so it is always set.
    query.set('singleEvents', 'true');
    if (options.syncToken) {
      // Google rejects a syncToken combined with a time window.
      query.set('syncToken', options.syncToken);
    } else {
      if (timeMin) query.set('timeMin', timeMin);
      if (timeMax) query.set('timeMax', timeMax);
    }
    if (options.pageToken) query.set('pageToken', options.pageToken);
    if (options.showDeleted) query.set('showDeleted', 'true');
    for (const [k, v] of filter) {
      query.append('privateExtendedProperty', `${k}=${v}`);
    }
    let data: { items?: unknown[]; nextPageToken?: string; nextSyncToken?: string };
    try {
      data = (await this.json(
        'GET',
        `/calendars/${enc(calendarId)}/events?${query}`,
      )) as typeof data;
    } catch (error) {
      // 410 on a listing means the sync token is too old: the caller does a full listing.
      if (options.syncToken && error instanceof CalendarRequestError && error.status === 410) {
        throw new CalendarSyncTokenExpiredError();
      }
      throw error;
    }
    return {
      events: (data.items ?? []).map(toEvent),
      nextPageToken: data.nextPageToken ?? null,
      nextSyncToken: data.nextSyncToken ?? null,
    };
  }

  async createCalendar(name: string): Promise<CalendarInfo> {
    return toCalendar(await this.json('POST', '/calendars', { summary: name }));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    try {
      return toEvent(
        await this.json('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`),
      );
    } catch (error) {
      if (error instanceof CalendarRequestError && isGone(error)) return null;
      throw error;
    }
  }

  async insertEvent(target: GuardedInsertTarget, event: EventInsert): Promise<CalendarEvent> {
    return toEvent(
      await this.json('POST', `/calendars/${enc(target.calendarId)}/events`, eventBody(event)),
    );
  }

  async patchEvent(target: GuardedTarget, patch: EventPatch): Promise<CalendarEvent> {
    return toEvent(
      await this.json(
        'PATCH',
        `/calendars/${enc(target.calendarId)}/events/${enc(target.eventId)}`,
        eventBody(patch),
        target.etag,
      ),
    );
  }

  async deleteEvent(target: GuardedTarget): Promise<void> {
    try {
      await this.call(
        'DELETE',
        `/calendars/${enc(target.calendarId)}/events/${enc(target.eventId)}`,
        undefined,
        target.etag,
      );
    } catch (error) {
      // Already gone, which is what was asked for.
      if (isGone(error)) return;
      throw error;
    }
  }
}

export interface RefreshOptions {
  /** e.g. https://oauth2.googleapis.com (no trailing slash); the endpoint is `${oauthBase}/token`. */
  oauthBase: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RefreshedToken {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresInSeconds: number;
}

/**
 * Exchanges a refresh token for a new access token. `invalid_grant` (revoked, expired or
 * password-changed) and `invalid_client` become CalendarAuthError; 429/5xx become retryable.
 */
export async function refreshAccessToken(options: RefreshOptions): Promise<RefreshedToken> {
  const res = await send(
    options.fetch ?? globalThis.fetch,
    `${options.oauthBase}/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: options.refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) throw await toError(res, true);
  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new CalendarRequestError('malformed_response', res.status);
  }
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new CalendarRequestError('malformed_response', res.status);
  }
  const expires =
    typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return { accessToken: data.access_token, expiresInSeconds: expires };
}

/**
 * An AccessTokenSupplier that refreshes on demand and caches the token until shortly before it
 * expires. Concurrent callers share one refresh. `getRefreshToken` is called per refresh so the
 * caller decides where the (decrypted) token comes from.
 */
export function createRefreshingTokenSupplier(
  refresh: (refreshToken: string) => Promise<RefreshedToken>,
  getRefreshToken: () => Promise<string>,
  now: () => number = Date.now,
): AccessTokenSupplier {
  const SKEW_MS = 60_000;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  return async (options) => {
    if (!options?.forceRefresh && cached && cached.expiresAt - SKEW_MS > now()) return cached.token;
    inflight ??= (async () => {
      try {
        const result = await refresh(await getRefreshToken());
        cached = { token: result.accessToken, expiresAt: now() + result.expiresInSeconds * 1000 };
        return result.accessToken;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}
