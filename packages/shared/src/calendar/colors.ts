/**
 * Event colours for the app calendar (spec 3.8). Pure: the plan's ordered tasks in, a Google
 * event `colorId` per task out. Nothing here talks to Google.
 *
 * Google's classic event palette has only the ids '1'..'11', so a colour per task is impossible
 * (a plan has more tasks). Instead a colour belongs to a GROUP: one course or one exam. Tasks
 * that share an `externalRef` (for example the parts of one multi-part course) are one group;
 * a task without it is its own group. Practice, admin and CV tasks are not groups: they all get
 * graphite, so courses and exams stand out in the calendar.
 *
 * Groups take the colours below in the order they first appear in the plan, cycling. The input
 * is ALL the plan's tasks (done ones included), so a colour never shifts when tasks are
 * finished. The ten colours are ordered for contrast and cycle every 10 groups, so two groups
 * that follow each other never share a colour; with more than 10 groups colours repeat.
 * Ids: 9 Blueberry, 6 Tangerine, 10 Basil, 4 Flamingo, 7 Peacock, 5 Banana, 3 Grape, 2 Sage,
 * 11 Tomato, 1 Lavender; 8 Graphite is kept for the non-course tasks.
 */
export const EVENT_COLOR_PALETTE: readonly string[] = [
  '9',
  '6',
  '10',
  '4',
  '7',
  '5',
  '3',
  '2',
  '11',
  '1',
];

/** Colour of practice, admin and CV tasks. */
export const NEUTRAL_COLOR_ID = '8';

export interface ColorTask {
  id: string;
  type: string;
  externalRef?: string | null | undefined;
}

/** Task id to Google `colorId`, for the plan's tasks given in plan order. */
export function colorIdsForTasks(tasks: readonly ColorTask[]): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const t of tasks) {
    if (t.type !== 'course' && t.type !== 'cert_exam') {
      out.set(t.id, NEUTRAL_COLOR_ID);
      continue;
    }
    const key = t.externalRef ? `ref:${t.externalRef}` : `id:${t.id}`;
    let color = groups.get(key);
    if (color === undefined) {
      color = EVENT_COLOR_PALETTE[groups.size % EVENT_COLOR_PALETTE.length]!;
      groups.set(key, color);
    }
    out.set(t.id, color);
  }
  return out;
}
