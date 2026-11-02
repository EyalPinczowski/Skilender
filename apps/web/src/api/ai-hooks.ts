import { useQuery } from '@tanstack/react-query';
import { unwrap } from './client';
import { useApi } from './context';
import type { paths } from './schema';

const USAGE = '/api/v1/ai/usage' as const;

export type AiUsage = paths[typeof USAGE]['get']['responses'][200]['content']['application/json'];

/** Today's AI usage (the user's own caps and the environment's providers). Counts only, no money. */
export function useAiUsage(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['ai-usage'],
    queryFn: ({ signal }) => unwrap(api.raw.GET(USAGE, { signal })),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}
