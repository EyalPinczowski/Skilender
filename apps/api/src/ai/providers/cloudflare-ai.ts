import { z } from 'zod';
import { ProviderUnavailableError, type AIProvider, type AIResponse } from '../provider';
import type { SafeAIRequest } from '../safe-request';
import { postJson, systemWithJsonHint, type FetchLike } from './http';

// Base: https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1 (OpenAI-compatible).
const CF_HOST = 'https://api.cloudflare.com/client/v4/accounts'; // needs check
const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast'; // needs check (about 13 neurons per turn)
// A model the JSON-mode page lists; used for the final feedback only (about 81 neurons per turn).
const JSON_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // needs check

/** Cloudflare account ids are 32 hex characters. Anything else could rewrite the URL path. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export class CloudflareAccountIdError extends Error {
  constructor() {
    super('CLOUDFLARE_ACCOUNT_ID must be 32 hexadecimal characters.');
    this.name = 'CloudflareAccountIdError';
  }
}

export interface CloudflareAIOptions {
  accountId: string;
  /** A token limited to Workers AI. */
  apiToken: string;
  fetch?: FetchLike;
  now?: () => Date;
  chatModel?: string;
  jsonModel?: string;
}

const replySchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

/** The exact body sent (a snapshot test pins it). */
export function buildCloudflareBody(
  request: SafeAIRequest,
  models: { chat?: string; json?: string } = {},
): object {
  return {
    model: request.json ? (models.json ?? JSON_MODEL) : (models.chat ?? CHAT_MODEL),
    messages: [
      { role: 'system', content: systemWithJsonHint(request.system, request.json) },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    max_tokens: request.maxOutputTokens,
    // No response_format: JSON mode needs a schema and its error handling is unverified (needs check).
  };
}

export function createCloudflareAIProvider(options: CloudflareAIOptions): AIProvider {
  if (!ACCOUNT_ID.test(options.accountId)) throw new CloudflareAccountIdError();
  const url = `${CF_HOST}/${options.accountId}/ai/v1/chat/completions`;
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  const now = options.now ?? (() => new Date());
  return {
    id: 'cloudflare-ai',
    label: 'Cloudflare Workers AI',
    // Workers Free fails with an error at 10,000 Neurons/day instead of charging (pricing page,
    // 2026-11-01). Card at signup is still needs check (docs/setup/ai-providers.md).
    costTier: 'free',
    maxContextChars: 12_000,
    async generate(request, { signal }): Promise<AIResponse> {
      const { json } = await postJson({
        url,
        apiKey: options.apiToken,
        body: buildCloudflareBody(request, { chat: options.chatModel, json: options.jsonModel }),
        signal,
        fetch: doFetch,
        now,
      });
      const parsed = replySchema.safeParse(json);
      if (!parsed.success) throw new ProviderUnavailableError();
      return {
        text: parsed.data.choices[0]!.message.content,
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
      };
    },
  };
}
