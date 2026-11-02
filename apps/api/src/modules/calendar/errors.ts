/**
 * Typed calendar errors. Messages carry a short code and an HTTP status only: never a token,
 * a response body or an event title.
 */

/** The credentials no longer work (HTTP 401, `invalid_grant`, revoked consent). The user must reconnect. */
export class CalendarAuthError extends Error {
  constructor(public readonly code: string) {
    super(`Calendar authorisation failed (${code})`);
    this.name = 'CalendarAuthError';
  }
}

/** Worth trying again later: HTTP 429, 5xx, a rate-limit 403 or a network failure. */
export class CalendarRetryableError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`Calendar request failed, retry later (${code})`);
    this.name = 'CalendarRetryableError';
  }
}

/** The sync token is too old (HTTP 410): drop it and do a full listing. */
export class CalendarSyncTokenExpiredError extends Error {
  constructor() {
    super('Calendar sync token expired');
    this.name = 'CalendarSyncTokenExpiredError';
  }
}

/** Any other failed request (bad request, forbidden, unexpected response). Not retryable. */
export class CalendarRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null,
  ) {
    super(`Calendar request failed (${code}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'CalendarRequestError';
  }
}
