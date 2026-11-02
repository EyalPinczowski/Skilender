import type { AiUsage } from '../../api/ai-hooks';

/** The meter appears only once a day's AI use is close to the limit (owner decision). */
export const METER_THRESHOLD = 0.8;

const CATEGORIES = [
  ['practiceMessages', 'Chat messages'],
  ['practiceFeedback', 'AI feedback'],
  ['dayOverview', 'Day overviews'],
] as const;

/** Pure: what the meter shows, or null while it stays hidden. Counts only, never money. */
export function meterModel(usage: AiUsage) {
  if (!usage.configured) return null;
  const rows = CATEGORIES.map(([key, label]) => ({ label, ...usage.user[key] })).filter(
    (row) => row.cap > 0,
  );
  const used = rows.reduce((sum, row) => sum + row.used, 0);
  const cap = rows.reduce((sum, row) => sum + row.cap, 0);
  if (cap <= 0) return null;
  const nearLimit =
    used / cap >= METER_THRESHOLD || rows.some((row) => row.used / row.cap >= METER_THRESHOLD);
  if (!nearLimit) return null;
  const active = usage.providers.find((p) => p.configured && p.available);
  return { rows, used, cap, provider: active?.label ?? null };
}
