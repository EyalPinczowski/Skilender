import { createHash, randomBytes } from 'node:crypto';
import { CalendarRequestError, CalendarRetryableError } from './errors';

/**
 * Google OAuth 2.0 pieces for the connect flow: PKCE, the authorization URL, the code exchange and
 * token revocation. Nothing here logs. Codes, verifiers and tokens only travel in request bodies or
 * the returned URL, and error messages carry a short reason code and nothing else.
 * Endpoint paths and parameter names follow Google's OAuth docs as recalled: needs check.
 */

/** The only two scopes the app ever asks for (spec 3.8). */
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

/** Google's authorization endpoint (needs check). It is a browser URL, never fetched by the API. */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const DEFAULT_TIMEOUT_MS = 15_000;

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: a 64-character verifier (within 43 to 128) and its SHA-256 challenge. */
export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** A random single-use state nonce (256 bits). */
export const createStateNonce = () => randomBytes(32).toString('base64url');

export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPES.join(' '),
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
  }).toString();
  return url.toString();
}

export interface OAuthClientOptions {
  oauthBase: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface CodeExchangeResult {
  accessToken: string;
  /** Null when Google did not issue one (the caller must treat that as a failure). */
  refreshToken: string | null;
  scopes: string[];
}

/** Google refused the code (expired, used, wrong verifier or redirect URI). Not retryable. */
export class OAuthCodeRejectedError extends Error {
  constructor(public readonly code: string) {
    super(`Authorization code rejected (${code})`);
    this.name = 'OAuthCodeRejectedError';
  }
}

async function post(
  options: OAuthClientOptions,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  try {
    return await (options.fetch ?? globalThis.fetch)(`${options.oauthBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // The cause is dropped on purpose: it can echo the URL.
    throw new CalendarRetryableError('network', null);
  }
}

async function reasonOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' && /^[a-z_]{1,60}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

/** Exchanges an authorization code (plus the PKCE verifier) for tokens. */
export async function exchangeAuthorizationCode(
  options: OAuthClientOptions,
  code: string,
  verifier: string,
): Promise<CodeExchangeResult> {
  const res = await post(options, '/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
  });
  if (!res.ok) {
    const reason = await reasonOf(res);
    if (res.status === 429 || res.status >= 500) {
      throw new CalendarRetryableError(reason ?? `http_${res.status}`, res.status);
    }
    // invalid_grant, invalid_request, redirect_uri_mismatch ...: the code cannot be used.
    throw new OAuthCodeRejectedError(reason ?? `http_${res.status}`);
  }
  let data: { access_token?: unknown; refresh_token?: unknown; scope?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new CalendarRequestError('malformed_response', res.status);
  }
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new CalendarRequestError('malformed_response', res.status);
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === 'string' && data.refresh_token !== ''
        ? data.refresh_token
        : null,
    scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/**
 * Revokes a token at Google. Best effort by design: never throws, returns whether Google accepted
 * it.
 */
export async function revokeToken(options: OAuthClientOptions, token: string): Promise<boolean> {
  try {
    const res = await post(options, '/revoke', { token });
    return res.ok;
  } catch {
    return false;
  }
}
