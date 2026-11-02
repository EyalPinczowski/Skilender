import type { PracticeHistoryItem } from '../../api/practice-hooks';

type Source = NonNullable<PracticeHistoryItem['source']>;

/** "mock_interview" becomes "Mock interview". Kinds are free strings from the plan. */
export function kindLabel(kind: string): string {
  const text = kind.replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Practice';
}

const SOURCE_LABEL: Record<Source, string> = {
  model_json: 'AI feedback',
  model_repaired: 'AI feedback',
  pasted_block: 'Pasted feedback',
  free_text: 'Free text',
  self_rubric: 'Self-check',
};

export const sourceLabel = (source: Source | null): string =>
  source ? SOURCE_LABEL[source] : 'No feedback';

/** "7.5" or "7": at most one decimal, as the API rounds it. */
export const scoreText = (n: number): string => String(Math.round(n * 10) / 10);

export function deltaText(delta: number | null): string {
  if (delta === null) return 'first score';
  if (delta === 0) return 'same as the one before';
  return `${delta > 0 ? 'up' : 'down'} ${scoreText(Math.abs(delta))} from the one before`;
}
