import type { AIConfig } from '../../config';
import type { AIProvider } from '../provider';
import { CloudflareAccountIdError, createCloudflareAIProvider } from './cloudflare-ai';
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
  /** Called with the id of a listed provider that was left out. Never gets a secret value. */
  onNotConfigured: (id: string) => void = () => undefined,
): AIProvider[] {
  const factories: Record<string, (() => AIProvider | null) | undefined> = {
    fake: () => createFakeProvider({ appEnv }),
    'cloudflare-ai': () => {
      const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
      const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
      // Left off until the owner confirms no card was asked and the account shows Workers Free.
      if (!accountId || !apiToken || env.CLOUDFLARE_FREE_PLAN_CONFIRMED !== 'true') return null;
      try {
        return createCloudflareAIProvider({ accountId, apiToken, freePlanConfirmed: true });
      } catch (error) {
        if (error instanceof CloudflareAccountIdError) return null; // a bad id must not crash startup
        throw error;
      }
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
    if (!provider && factories[id]) onNotConfigured(id);
    return provider ? [provider] : [];
  });
}
