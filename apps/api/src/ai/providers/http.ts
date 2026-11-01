import { ProviderQuotaError, ProviderUnavailableError } from '../provider';

/** Largest response body a provider call will read. Anything bigger is treated as a failure. */
export const MAX_RESPONSE_BYTES = 1_000_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PostJsonOptions {
  url: string;
  /** Sent as `Authorization: Bearer <key>`. Never put in the URL, a log line or an error. */
  apiKey: string;
  body: unknown;
  signal: AbortSignal;
  fetch: FetchLike;
  now: () => Date;
}

export interface JsonReply {
  json: unknown;
  headers: Headers;
}

/** Longest `retry-after` that is believed; a larger value is clamped (a provider bug or a trap). */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Parses `retry-after` (whole seconds or an HTTP date) into a date, or undefined. */
export function parseRetryAfter(value: string | null, now: Date): Date | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  let ms: number;
  if (/^\d{1,9}$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now.getTime();
  }
  return new Date(now.getTime() + Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS));
}

/** Reads at most `MAX_RESPONSE_BYTES` of the body, or throws `ProviderUnavailableError`. */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderUnavailableError();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderUnavailableError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * POSTs a JSON body over HTTPS and returns the parsed JSON reply. Maps failures to the gateway
 * contract: 429 -> `ProviderQuotaError` (with `retry-after`), 5xx, network, timeout, an oversized
 * or malformed body -> `ProviderUnavailableError`, any other 4xx -> `ProviderUnavailableError`
 * with `requestSpecific: true`. No error carries the provider's text, the URL or the key.
 */
export async function postJson(options: PostJsonOptions): Promise<JsonReply> {
  if (!options.url.startsWith('https://')) throw new ProviderUnavailableError();
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(options.body),
      signal: options.signal,
      // A redirect would forward the Authorization header to another host.
      redirect: 'error',
    });
  } catch {
    throw new ProviderUnavailableError();
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderQuotaError(
      parseRetryAfter(response.headers.get('retry-after'), options.now()),
    );
  }
  if (response.status >= 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderUnavailableError(response.status < 500);
  }
  let text: string;
  try {
    text = await readCapped(response);
  } catch {
    throw new ProviderUnavailableError();
  }
  try {
    return { json: JSON.parse(text) as unknown, headers: response.headers };
  } catch {
    throw new ProviderUnavailableError();
  }
}

/** The system prompt, plus a plain instruction when the caller wants a JSON object back. */
export function systemWithJsonHint(system: string, json: boolean): string {
  return json ? `${system}\n\nReply with one JSON object only, with no other text.` : system;
}
