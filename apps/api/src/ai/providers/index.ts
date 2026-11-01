import type { AIConfig } from '../../config';
import type { AIProvider } from '../provider';
import { createCloudflareAIProvider } from './cloudflare-ai';
import { createFakeProvider } from './fake';
import { createGroqProvider } from './groq';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The one place that maps a provider id from `AI_PROVIDERS` to its implementation. A provider is
 * one file plus one entry here (and its id in `PROVIDER_IDS` in config.ts). An id with no
 * entry, or whose credentials are not set, is left out and reported as not configured.
 *
 * Credentials come from `env` (default `process.env`) and are only ever handed to the provider.
 */
export function createConfiguredProviders(
  ai: Pick<AIConfig, 'providerOrder'>,
  appEnv: string,
  env: Env = process.env,
): AIProvider[] {
  const factories: Record<string, (() => AIProvider | null) | undefined> = {
    fake: () => createFakeProvider({ appEnv }),
    'cloudflare-ai': () => {
      const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
      const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
      return accountId && apiToken ? createCloudflareAIProvider({ accountId, apiToken }) : null;
    },
    // Left off until the owner confirms the free plan needs no card (GROQ_NO_CARD_CONFIRMED=true).
    groq: () => {
      const apiKey = env.GROQ_API_KEY?.trim();
      return apiKey && env.GROQ_NO_CARD_CONFIRMED === 'true'
        ? createGroqProvider({ apiKey, noCardConfirmed: true })
        : null;
    },
  };
  return ai.providerOrder.flatMap((id) => {
    const provider = factories[id]?.();
    return provider ? [provider] : [];
  });
}
