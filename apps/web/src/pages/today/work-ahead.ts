import {
  addDays,
  compareDates,
  dayCapacity,
  findOverride,
  studyWindow,
  totalMinutes,
} from '@upversion/shared';
import type { Block, DayOverride, WeekPattern } from '../../api/client';
import { formatHours, weekdayShort } from '../../lib/format';

/** Extra hours the person can add to a study day. */
export const EXTRA_HOUR_CHOICES = [1, 2, 3] as const;

export interface TodayCapacity {
  isStudyDay: boolean;
  /** The hours today has now (0 on a day off). */
  hours: number;
  /** The longest a day can be: the study window minus lunch. */
  windowHours: number;
  /** The exception saved for today, if any. */
  override: DayOverride | undefined;
}

export function todayCapacity(
  pattern: WeekPattern,
  overrides: DayOverride[],
  today: string,
): TodayCapacity {
  const cap = dayCapacity(today, pattern, overrides);
  return {
    isStudyDay: cap.isStudyDay,
    hours: cap.baseMinutes / 60,
    windowHours: totalMinutes(studyWindow(pattern)) / 60,
    override: findOverride(today, overrides),
  };
}

/** Minutes of study that the proposed schedule has on `date` beyond the current one. */
export function addedMinutes(current: Block[], proposed: Block[], date: string): number {
  const sum = (blocks: Block[]) =>
    blocks.filter((b) => b.date === date).reduce((total, b) => total + b.minutes, 0);
  return sum(proposed) - sum(current);
}

function firstTaskOn(blocks: Block[], date: string): string | undefined {
  return blocks.filter((b) => b.date === date).sort((a, b) => a.start.localeCompare(b.start))[0]
    ?.taskId;
}

function minutesOn(blocks: Block[], date: string, taskId: string): number {
  return blocks
    .filter((b) => b.date === date && b.taskId === taskId)
    .reduce((sum, b) => sum + b.minutes, 0);
}

/**
 * One sentence on what the extra time does to the next work, from the schedule as it is now and
 * as it would be: the first task of the next day with work now starts today, or more of it moves
 * into today. Empty when nothing from a later day moves.
 */
export function workAheadEffect(
  current: Block[],
  proposed: Block[],
  today: string,
  titleOf: (taskId: string) => string,
): string {
  const nextDay = [...new Set(current.map((b) => b.date))]
    .filter((d) => compareDates(d, today) > 0)
    .sort(compareDates)[0];
  if (!nextDay) return '';
  const taskId = firstTaskOn(current, nextDay);
  if (!taskId) return '';
  const before = minutesOn(current, today, taskId);
  const after = minutesOn(proposed, today, taskId);
  if (after <= before) return '';
  const when = nextDay === addDays(today, 1) ? 'Tomorrow’s' : `${weekdayShort(nextDay)}’s`;
  if (before === 0) return `${when} first task, ${titleOf(taskId)}, now starts today.`;
  return `${formatHours((after - before) / 60)} more of ${titleOf(taskId)}, ${when} first task, moves into today.`;
}

/** The time of day ("HH:MM") and date at `ms` in a time zone. */
function clockIn(ms: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * True when a block the proposal adds or changes today starts before the current time in the plan's
 * zone. The scheduler plans from the start of the day, so extra hours late in the day can land in
 * the past; the person is told instead of being offered time that is gone.
 */
export function hasPassedBlock(
  current: Block[],
  proposed: Block[],
  today: string,
  nowMs: number,
  timeZone: string,
): boolean {
  const now = clockIn(nowMs, timeZone);
  if (now.date !== today) return false;
  const key = (b: Block) => `${b.taskId}|${b.start}|${b.end}`;
  const before = new Set(current.filter((b) => b.date === today).map(key));
  return proposed.some((b) => b.date === today && !before.has(key(b)) && b.start < now.time);
}
