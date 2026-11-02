import { z } from 'zod';
import { ProviderUnavailableError, type AIProvider, type AIResponse } from '../provider';
import type { SafeAIRequest } from '../safe-request';
import { postJson, systemWithJsonHint, type FetchLike } from './http';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'; // needs check
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // needs check (a production model on 2026-11-01)

export interface GroqOptions {
  apiKey: string;
  /**
   * True only after the owner has confirmed that the Groq free plan needs no payment method and
   * recorded the evidence (plan decision D4). Until then the tier is `paid`, which the guard
   * refuses, so Groq cannot run by accident.
   */
  noCardConfirmed?: boolean;
  fetch?: FetchLike;
  now?: () => Date;
  model?: string;
}

const replySchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

/** The exact body sent (a snapshot test pins it, so no field is added by accident). */
export function buildGroqBody(request: SafeAIRequest, model = GROQ_MODEL): object {
  return {
    model,
    messages: [
      { role: 'system', content: systemWithJsonHint(request.system, request.json) },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    max_completion_tokens: request.maxOutputTokens, // needs check (older name: max_tokens)
    ...(request.json ? { response_format: { type: 'json_object' } } : {}),
  };
}

export function createGroqProvider(options: GroqOptions): AIProvider {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  return {
    id: 'groq',
    label: 'Groq',
    costTier: options.noCardConfirmed === true ? 'free' : 'paid',
    maxContextChars: 12_000,
    async generate(request, { signal }): Promise<AIResponse> {
      const { json, headers } = await postJson({
        url: GROQ_URL,
        apiKey: options.apiKey,
        body: buildGroqBody(request, options.model),
        signal,
        fetch: doFetch,
        now,
      });
      const parsed = replySchema.safeParse(json);
      if (!parsed.success) throw new ProviderUnavailableError();
      const remaining = headers.get('x-ratelimit-remaining-requests'); // needs check: header name
      const remainingRequests =
        remaining !== null && /^\d{1,9}$/.test(remaining) ? Number(remaining) : undefined;
      return {
        text: parsed.data.choices[0]!.message.content,
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        ...(remainingRequests !== undefined ? { rateLimit: { remainingRequests } } : {}),
      };
    },
  };
}
