import {
  formatTime,
  splitByDay,
  type Block,
  type BusyInterval,
  type DayOverride,
} from '@skillstack/shared';
import type { UserContext } from '../../db/database';

/** The engine's last schedulable minute (23:59); `HH:MM` times stop there. */
const LAST_MINUTE = 24 * 60 - 1;

/**
 * What the user's calendar contributes to scheduling (spec 3.8): busy time that is subtracted
 * from capacity, whole days the user cancelled, and blocks the user fixed by moving them.
 * All three are empty when nothing is synced, and then scheduling is unchanged.
 */
export interface CalendarInputs {
  busy: BusyInterval[];
  /** Dates of all-day events marked as blocking; each becomes a day off. */
  dayOffs: string[];
  lockedBlocks: Block[];
}

export const NO_CALENDAR: CalendarInputs = { busy: [], dayOffs: [], lockedBlocks: [] };

export interface BusyRow {
  date: string;
  start_minute: number;
  end_minute: number;
  kind: 'busy' | 'tentative' | 'all_day';
  blocks_day: boolean;
}

export interface LockedRow {
  reason: 'moved' | 'deleted';
  task_id: string;
  starts_at: Date;
  ends_at: Date;
}

/**
 * Reads the calendar rows that matter for one plan. Runs inside the caller's transaction, so
 * row-level security limits every row to the signed-in user; `userId` is the verified id from
 * the token and is only repeated in the WHERE clause as a second guard.
 *
 * Only `kind = 'busy'` rows count as busy time. Tentative rows are shown in the calendar view
 * but never counted; all-day rows count only when `blocks_day` is set, and then they cancel
 * the whole day instead of subtracting minutes. Locked-block rows with reason 'moved' are
 * locked blocks; rows with reason 'deleted' are busy time (the slot is skipped).
 */
export async function loadCalendarInputs(
  ctx: UserContext,
  userId: string,
  planId: string,
  timeZone: string,
  /** `fromDate`: rows before it are not read (nothing earlier can be planned or frozen). */
  options: { fromDate?: string } = {},
): Promise<CalendarInputs> {
  // Rows are written only by the calendar sync, and only for calendars with blocks_time set
  // (the sync work package enforces that); this read trusts the table and does not filter
  // by calendar.
  const busyRows = await ctx.client.query<BusyRow>(
    `select date::text as date, start_minute, end_minute, kind, blocks_day
     from ${ctx.schema}.calendar_busy
     where user_id = $1 and (kind = 'busy' or (kind = 'all_day' and blocks_day))
       and ($2::date is null or date >= $2::date)
     order by date, start_minute, external_event_id`,
    [userId, options.fromDate ?? null],
  );
  const lockedRows = await ctx.client.query<LockedRow>(
    `select task_id, reason, starts_at, ends_at from ${ctx.schema}.calendar_locked_blocks
     where user_id = $1 and plan_id = $2 order by starts_at, block_key`,
    [userId, planId],
  );
  return calendarInputsFromRows(busyRows.rows, lockedRows.rows, timeZone);
}

/** Pure mapping from rows to engine inputs. */
export function calendarInputsFromRows(
  busyRows: BusyRow[],
  lockedRows: LockedRow[],
  timeZone: string,
): CalendarInputs {
  const busy: BusyInterval[] = [];
  const dayOffs = new Set<string>();
  for (const r of busyRows) {
    if (r.kind === 'all_day') {
      if (r.blocks_day) dayOffs.add(r.date);
    } else if (r.kind === 'busy') {
      const end = Math.min(r.end_minute, LAST_MINUTE);
      if (end > r.start_minute) {
        busy.push({ date: r.date, start: formatTime(r.start_minute), end: formatTime(end) });
      }
    }
  }
  const lockedBlocks: Block[] = [];
  for (const r of lockedRows) {
    for (const i of splitByDay(r.starts_at.getTime(), r.ends_at.getTime(), timeZone)) {
      const end = Math.min(i.endMinute, LAST_MINUTE);
      if (end <= i.startMinute) continue;
      if (r.reason === 'deleted') {
        // The user deleted the block in the calendar: that time is unavailable and the task is
        // planned elsewhere (owner decision), so it is busy time, not a lock.
        busy.push({ date: i.date, start: formatTime(i.startMinute), end: formatTime(end) });
        continue;
      }
      lockedBlocks.push({
        taskId: r.task_id,
        date: i.date,
        start: formatTime(i.startMinute),
        end: formatTime(end),
        minutes: end - i.startMinute,
        kind: 'locked',
      });
    }
  }
  return { busy, dayOffs: [...dayOffs].sort(), lockedBlocks };
}

/**
 * The plan's overrides with the calendar's blocking all-day events added as days off. A day
 * off from the calendar replaces any override the user set for that date (the day is cancelled
 * whatever its hours were). With no day-offs the same array is returned.
 */
export function withDayOffs(overrides: DayOverride[], dayOffs: string[]): DayOverride[] {
  if (dayOffs.length === 0) return overrides;
  const off = new Set(dayOffs);
  return [
    ...overrides.filter((o) => !off.has(o.date)),
    ...dayOffs.map((date): DayOverride => ({ date, isStudyDay: false })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
