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
  // This environment's own budget per provider (SPEC 3.3: requests used today against the quota).
  const providers = usage.providers
    .filter((p) => p.configured && p.budget !== null && p.budget > 0)
    .map((p) => ({ label: p.label, used: p.usedToday, cap: p.budget as number }));
  const near = (x: { used: number; cap: number }) => x.used / x.cap >= METER_THRESHOLD;
  if (!(near({ used, cap }) || rows.some(near) || providers.some(near))) return null;
  const active = usage.providers.find((p) => p.configured && p.available);
  return { rows, providers, used, cap, provider: active?.label ?? null };
}
