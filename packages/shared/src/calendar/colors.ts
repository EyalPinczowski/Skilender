/**
 * Event colours for the app calendar (spec 3.8). Pure: a task's position in the plan in, a Google
 * event `colorId` out. Nothing here talks to Google.
 *
 * Google's classic event palette has the ids '1'..'11'. The palette below lists all eleven,
 * ordered for contrast: consecutive entries differ in hue and lightness, so tasks that are
 * neighbours in the plan's order never look alike. Ids: 1 Lavender, 2 Sage, 3 Grape, 4 Flamingo,
 * 5 Banana, 6 Tangerine, 7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato.
 *
 * The colour depends only on the order index, so a task always gets the same colour. With 12 or
 * more tasks the colours repeat every 11 tasks (index 0 and index 11 share one); the first 11
 * tasks are all distinct and any two neighbours always differ.
 */
export const EVENT_COLOR_PALETTE: readonly string[] = [
  '9', // Blueberry
  '6', // Tangerine
  '10', // Basil
  '4', // Flamingo
  '7', // Peacock
  '5', // Banana
  '3', // Grape
  '2', // Sage
  '11', // Tomato
  '1', // Lavender
  '8', // Graphite
];

/** The Google `colorId` for the task at `orderIndex` (0-based) among the plan's tasks. */
export function colorIdForTask(orderIndex: number): string {
  const n = EVENT_COLOR_PALETTE.length;
  const i = Number.isFinite(orderIndex) ? Math.trunc(orderIndex) : 0;
  return EVENT_COLOR_PALETTE[((i % n) + n) % n]!;
}
