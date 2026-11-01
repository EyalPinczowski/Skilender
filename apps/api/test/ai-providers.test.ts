import { describe, expect, it } from 'vitest';
import { ProviderQuotaError, ProviderUnavailableError, type AIProvider } from '../src/ai/provider';
import { buildSafeRequest, type SafeAIRequest } from '../src/ai/safe-request';
import { createCloudflareAIProvider } from '../src/ai/providers/cloudflare-ai';
import { createGroqProvider } from '../src/ai/providers/groq';
import { createConfiguredProviders } from '../src/ai/providers';
import { MAX_RESPONSE_BYTES, type FetchLike } from '../src/ai/providers/http';

// The fixtures are hand-written in the documented OpenAI-compatible shape, not recorded from a
// live call (no key exists yet). Replace them with recordings after the first real call on R&D.
const SUCCESS = {
  id: 'chatcmpl-fixture',
  model: 'fixture-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the fixture.' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const KEY = 'sk-test-key-0123456789abcdef0123456789';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-11-01T10:00:00Z');

function request(json = false): SafeAIRequest {
  return buildSafeRequest(
    {
      purpose: json ? 'practice_feedback' : 'practice_message',
      system: 'You are a practice partner.',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Ask me a question.' },
      ],
      maxOutputTokens: 300,
      json,
    },
    [],
  );
}

interface Seen {
  url: string;
  init: RequestInit;
}
function recorder(respond: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return respond();
  };
  return { seen, fetch };
}
const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const makers: Record<string, (fetch: FetchLike) => AIProvider> = {
  groq: (fetch) =>
    createGroqProvider({ apiKey: KEY, noCardConfirmed: true, fetch, now: () => NOW }),
  'cloudflare-ai': (fetch) =>
    createCloudflareAIProvider({ accountId: ACCOUNT, apiToken: KEY, fetch, now: () => NOW }),
};

describe.each(Object.entries(makers))('%s provider contract', (id, make) => {
  const run = (fetch: FetchLike, signal = new AbortController().signal) =>
    make(fetch).generate(request(), { signal });

  it('returns the text and model on success', async () => {
    const { fetch, seen } = recorder(() => jsonResponse(SUCCESS));
    const out = await run(fetch);
    expect(out.text).toBe('Hello from the fixture.');
    expect(out.model).toBe('fixture-model');
    expect(seen).toHaveLength(1);
  });

  it('uses HTTPS, keeps the key in the Authorization header only and refuses redirects', async () => {
    const { fetch, seen } = recorder(() => jsonResponse(SUCCESS));
    await run(fetch);
    const call = seen[0]!;
    expect(call.url.startsWith('https://')).toBe(true);
    expect(call.url).not.toContain(KEY);
    expect(call.url).not.toContain('?');
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(call.init.body)).not.toContain(KEY);
    expect(call.init.redirect).toBe('error');
  });

  it('maps 429 to ProviderQuotaError with the retry-after header', async () => {
    const { fetch } = recorder(
      () =>
        new Response('{"error":"secret detail"}', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
    );
    const error = await run(fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect((error as ProviderQuotaError).retryAfter).toEqual(new Date(NOW.getTime() + 30_000));
    expect((error as Error).message).not.toContain('secret');
  });

  it('maps 429 without retry-after to a quota error with no date', async () => {
    const { fetch } = recorder(() => new Response('', { status: 429 }));
    const error = await run(fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect((error as ProviderQuotaError).retryAfter).toBeUndefined();
  });

  it('maps 5xx to ProviderUnavailableError (not request specific)', async () => {
    const { fetch } = recorder(() => new Response('upstream broke', { status: 503 }));
    const error = await run(fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).requestSpecific).toBe(false);
  });

  it('maps other 4xx to a request-specific ProviderUnavailableError', async () => {
    for (const status of [400, 401, 404, 422]) {
      const { fetch } = recorder(() => new Response('bad', { status }));
      const error = await run(fetch).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).requestSpecific).toBe(true);
    }
  });

  it('maps a network failure to ProviderUnavailableError without its message', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError(`connect failed for Bearer ${KEY}`);
    };
    const error = await run(fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('maps a malformed JSON body to ProviderUnavailableError', async () => {
    const { fetch } = recorder(() => new Response('{"choices": [', { status: 200 }));
    await expect(run(fetch)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps a well-formed body with no answer to ProviderUnavailableError', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: '' } }] }]) {
      const { fetch } = recorder(() => jsonResponse(body));
      await expect(run(fetch)).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  it('stops when the abort signal fires (timeout)', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const controller = new AbortController();
    const pending = run(fetch, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(ProviderUnavailableError);
  });

  it('rejects a body over the size cap by content-length', async () => {
    const { fetch } = recorder(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
    );
    await expect(run(fetch)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('rejects a streamed body over the size cap with no content-length', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > MAX_RESPONSE_BYTES * 3) controller.close();
      },
    });
    const { fetch } = recorder(() => new Response(stream, { status: 200 }));
    await expect(run(fetch)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(sent).toBeLessThan(MAX_RESPONSE_BYTES * 2);
  });
});

describe('request bodies (no extra fields)', () => {
  async function bodyOf(make: (f: FetchLike) => AIProvider, json: boolean) {
    const { fetch, seen } = recorder(() => jsonResponse(SUCCESS));
    await make(fetch).generate(request(json), { signal: new AbortController().signal });
    return JSON.parse(String(seen[0]!.init.body)) as unknown;
  }

  it('groq chat', async () => {
    expect(await bodyOf(makers.groq!, false)).toMatchInlineSnapshot(`
      {
        "max_completion_tokens": 300,
        "messages": [
          {
            "content": "You are a practice partner.",
            "role": "system",
          },
          {
            "content": "Hi",
            "role": "user",
          },
          {
            "content": "Hello",
            "role": "assistant",
          },
          {
            "content": "Ask me a question.",
            "role": "user",
          },
        ],
        "model": "llama-3.3-70b-versatile",
      }
    `);
  });
  it('groq json', async () => {
    expect(await bodyOf(makers.groq!, true)).toMatchInlineSnapshot(`
      {
        "max_completion_tokens": 300,
        "messages": [
          {
            "content": "You are a practice partner.

      Reply with one JSON object only, with no other text.",
            "role": "system",
          },
          {
            "content": "Hi",
            "role": "user",
          },
          {
            "content": "Hello",
            "role": "assistant",
          },
          {
            "content": "Ask me a question.",
            "role": "user",
          },
        ],
        "model": "llama-3.3-70b-versatile",
        "response_format": {
          "type": "json_object",
        },
      }
    `);
  });
  it('cloudflare chat', async () => {
    expect(await bodyOf(makers['cloudflare-ai']!, false)).toMatchInlineSnapshot(`
      {
        "max_tokens": 300,
        "messages": [
          {
            "content": "You are a practice partner.",
            "role": "system",
          },
          {
            "content": "Hi",
            "role": "user",
          },
          {
            "content": "Hello",
            "role": "assistant",
          },
          {
            "content": "Ask me a question.",
            "role": "user",
          },
        ],
        "model": "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
      }
    `);
  });
  it('cloudflare json', async () => {
    expect(await bodyOf(makers['cloudflare-ai']!, true)).toMatchInlineSnapshot(`
      {
        "max_tokens": 300,
        "messages": [
          {
            "content": "You are a practice partner.

      Reply with one JSON object only, with no other text.",
            "role": "system",
          },
          {
            "content": "Hi",
            "role": "user",
          },
          {
            "content": "Hello",
            "role": "assistant",
          },
          {
            "content": "Ask me a question.",
            "role": "user",
          },
        ],
        "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      }
    `);
  });
});

describe('Groq specifics', () => {
  it('reads the remaining-requests header into rateLimit', async () => {
    const { fetch } = recorder(() =>
      jsonResponse(SUCCESS, { headers: { 'x-ratelimit-remaining-requests': '812' } }),
    );
    const out = await makers.groq!(fetch).generate(request(), {
      signal: new AbortController().signal,
    });
    expect(out.rateLimit).toEqual({ remainingRequests: 812 });
  });

  it('ignores a malformed rate-limit header', async () => {
    const { fetch } = recorder(() =>
      jsonResponse(SUCCESS, { headers: { 'x-ratelimit-remaining-requests': 'lots' } }),
    );
    const out = await makers.groq!(fetch).generate(request(), {
      signal: new AbortController().signal,
    });
    expect(out.rateLimit).toBeUndefined();
  });

  it('is paid (refused by the guard) until the no-card check is confirmed', () => {
    expect(createGroqProvider({ apiKey: KEY }).costTier).toBe('paid');
    expect(createGroqProvider({ apiKey: KEY, noCardConfirmed: true }).costTier).toBe('free');
  });
});

describe('Cloudflare specifics', () => {
  it('rejects an account id that could change the URL path', () => {
    for (const accountId of ['', '../x', `${ACCOUNT}/..`, 'abc']) {
      expect(() => createCloudflareAIProvider({ accountId, apiToken: KEY })).toThrow();
    }
  });

  it('puts the account id in the path and is a free-tier provider', async () => {
    const { fetch, seen } = recorder(() => jsonResponse(SUCCESS));
    const provider = makers['cloudflare-ai']!(fetch);
    await provider.generate(request(), { signal: new AbortController().signal });
    expect(seen[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`,
    );
    expect(provider.costTier).toBe('free');
  });
});

describe('registration', () => {
  const ai = { providerOrder: ['cloudflare-ai', 'groq'] };
  it('skips providers without credentials', () => {
    expect(createConfiguredProviders(ai, 'rnd', {})).toEqual([]);
  });
  it('registers cloudflare-ai with its credentials, and groq only once confirmed', () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: KEY, GROQ_API_KEY: KEY };
    expect(createConfiguredProviders(ai, 'rnd', env).map((p) => p.id)).toEqual(['cloudflare-ai']);
    expect(
      createConfiguredProviders(ai, 'rnd', { ...env, GROQ_NO_CARD_CONFIRMED: 'true' }).map(
        (p) => p.id,
      ),
    ).toEqual(['cloudflare-ai', 'groq']);
  });
});
