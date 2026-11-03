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
