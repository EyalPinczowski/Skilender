import {
  addDays,
  compareDates,
  schedule,
  summarizeChanges,
  weekday,
  type AdjustableInputs,
  type ChangeSummary,
  type DayOverride,
  type ScheduleResult,
  type Task,
  type WeekPattern,
} from '@upversion/shared';
import type { Database } from '../../db/database';
import { HttpError } from '../../errors';
import { NO_CALENDAR, withDayOffs } from '../calendar/inputs';
import type { DayContext, DaysService } from '../days/service';
import type { PlanDetail } from '../plans/schemas';

export interface ScheduleView {
  today: string;
  timezone: string;
  finishDate: string | null;
  blocks: ScheduleResult['blocks'];
  warnings: ScheduleResult['warnings'];
}

/** The plan's skill ids from `plans.summary.skillIds`; anything that is not a string list is dropped. */
export function planSkillIds(summary: Record<string, unknown>): string[] {
  const raw = summary.skillIds;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
}

/** Everything the day briefing needs about one day, from one consistent read. */
export interface DayPlanView {
  date: string;
  /** True when the blocks are the stored snapshot of a frozen day. */
  frozen: boolean;
  /** The blocks planned for `date`. */
  blocks: ScheduleResult['blocks'];
  /** Frozen blocks of the days before `date`. */
  earlierBlocks: ScheduleResult['blocks'];
  /** Engine warnings; empty for a frozen day (its plan is no longer being computed). */
  warnings: ScheduleResult['warnings'];
  finishDate: string | null;
  /** The tasks as they stood at the start of `date`. */
  tasks: Task[];
  pattern: WeekPattern;
  overrides: DayOverride[];
  /** Skill ids stored on the plan (`plans.summary.skillIds`); empty when the plan has none. */
  skillIds: string[];
}

export interface PreviewChanges {
  today?: string;
  pattern?: WeekPattern;
  /** Added to the plan's overrides; an entry for an existing date replaces it. */
  overrides?: DayOverride[];
  /** Dates whose override would be removed. */
  removeOverrideDates?: string[];
}

export interface PreviewView {
  today: string;
  summary: ChangeSummary;
  current: Pick<ScheduleView, 'finishDate' | 'warnings'>;
  proposed: Pick<ScheduleView, 'finishDate' | 'warnings' | 'blocks'>;
}

export interface OpenTask {
  taskId: string;
  title: string;
  type: Task['type'];
  /** `skipped` only for a task skipped after it was planned on an earlier day (carried over). */
  status: 'pending' | 'in_progress' | 'skipped';
  estHours: number;
  doneHours: number;
  remainingHours: number;
  /** Dates of this week on which the task has blocks (frozen or still to come), ascending. */
  plannedDates: string[];
  /** Earlier frozen days on which the task was planned and is still not done, ascending. */
  carriedOverFrom: string[];
}

export interface OpenTasksView {
  today: string;
  /** The week is Sunday to Saturday in the plan's time zone and holds `today`. */
  weekStart: string;
  weekEnd: string;
  tasks: OpenTask[];
}

/**
 * The read side of scheduling: loads a plan, brings its stored past days up to date and hands
 * both to the pure engine in @upversion/shared. No scheduling rule lives here. The only write
 * is the automatic freezing of days that have passed (see the days service).
 */
export function createSchedulingService(db: Database, days: DaysService) {
  /**
   * The first date the engine may change. Nothing is scheduled before the plan starts, and a
   * frozen day (ended, or rolled over) is never scheduled again: the schedule continues on the
   * first date from `viewDay` that is not frozen.
   */
  const engineToday = (c: DayContext, viewDay: string): string => {
    const frozen = new Set(c.snapshots.map((s) => s.date));
    let day = compareDates(viewDay, c.plan.startDate) < 0 ? c.plan.startDate : viewDay;
    while (frozen.has(day)) day = addDays(day, 1);
    return day;
  };

  /** The overrides with the calendar's blocking all-day events added as days off. */
  const withCalendarDays = (c: DayContext, overrides: DayOverride[]) =>
    withDayOffs(overrides, c.calendar.dayOffs);

  /**
   * Runs the engine with the user's synced calendar: busy events are subtracted from capacity
   * (spec 3.8), blocking all-day events are days off, blocks the user moved in the calendar
   * keep their time, and the time of a block the user deleted there is busy (skipped). `useCalendar: false` gives the plan as if nothing were synced.
   *
   * A locked block that overlaps a busy event: the engine does not move the locked block (the
   * user's own placement wins) and does not warn about the overlap with busy time. Other
   * blocks avoid both. The locked minutes still count against the day's capacity, which busy
   * time has already reduced, so the day may fill earlier (pinned by a test in
   * calendar-capacity.test.ts).
   */
  const run = (
    c: DayContext,
    pattern: WeekPattern,
    overrides: DayOverride[],
    viewDay: string,
    tasks: Task[] = c.plan.tasks,
    useCalendar = true,
  ) => {
    const calendar = useCalendar ? c.calendar : NO_CALENDAR;
    return schedule({
      tasks,
      pattern,
      overrides: useCalendar ? withCalendarDays(c, overrides) : overrides,
      busy: calendar.busy,
      lockedBlocks: calendar.lockedBlocks,
      today: engineToday(c, viewDay),
      frozenBlocks: c.snapshots.flatMap((s) => s.blocks),
    });
  };

  const mergeOverrides = (plan: PlanDetail, changes: PreviewChanges): DayOverride[] => {
    const removed = new Set(changes.removeOverrideDates ?? []);
    const replaced = new Map((changes.overrides ?? []).map((o) => [o.date, o]));
    return [
      ...plan.overrides.filter((o) => !removed.has(o.date) && !replaced.has(o.date)),
      ...replaced.values(),
    ].sort((a, b) => compareDates(a.date, b.date));
  };

  /**
   * Pure: schedules the plan as it is and with the proposed inputs (same frozen days, same
   * first date the engine may change) and compares them. Nothing is read or saved here.
   */
  const compareProposal = (c: DayContext, proposed: AdjustableInputs): PreviewView => {
    const before = run(c, c.pattern, c.plan.overrides, c.today);
    const after = run(c, proposed.pattern, proposed.overrides, c.today, proposed.tasks);
    return {
      today: c.today,
      summary: summarizeChanges(before, after, {
        today: engineToday(c, c.today),
        pattern: proposed.pattern,
        overrides: withCalendarDays(c, proposed.overrides),
        tasks: proposed.tasks,
      }),
      current: { finishDate: before.finishDate, warnings: before.warnings },
      proposed: { finishDate: after.finishDate, warnings: after.warnings, blocks: after.blocks },
    };
  };

  return {
    compareProposal,

    /**
     * The change summary for what the calendar did to the plan: the schedule without the synced
     * calendar compared with the schedule with it (same frozen days, same first date). Its
     * `movedTaskIds` are the tasks whose blocks moved because of busy events, blocking all-day
     * events or locked blocks, which is what the user sees after a sync. With nothing synced
     * nothing moved. Saves nothing but the automatic freezing of days that have passed.
     */
    async calendarImpact(userId: string, planId: string): Promise<ChangeSummary> {
      return db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        const without = run(c, c.pattern, c.plan.overrides, c.today, c.plan.tasks, false);
        const withCal = run(c, c.pattern, c.plan.overrides, c.today);
        return summarizeChanges(without, withCal, {
          today: engineToday(c, c.today),
          pattern: c.pattern,
          overrides: withCalendarDays(c, c.plan.overrides),
          tasks: c.plan.tasks,
        });
      });
    },

    async getSchedule(userId: string, planId: string, today?: string): Promise<ScheduleView> {
      return db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        const day = today ?? c.today;
        const result = run(c, c.pattern, c.plan.overrides, day);
        return {
          today: day,
          timezone: c.pattern.timezone,
          finishDate: result.finishDate,
          blocks: result.blocks,
          warnings: result.warnings,
        };
      });
    },

    /**
     * The plan for one day, as it was or is: a frozen day (ended, or rolled over) gives its
     * stored blocks; today gives the engine's blocks and warnings, planned from the tasks as
     * they stood at the start of the day (the same input that freezes the day later). A future
     * date, a date before the plan began or a past date with no stored snapshot answers 422.
     * Saves nothing but the automatic freezing of days that have passed.
     */
    async dayPlan(userId: string, planId: string, date: string): Promise<DayPlanView> {
      return db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        if (compareDates(date, c.today) > 0) {
          throw new HttpError(422, 'unprocessable', 'A future day has no briefing yet.');
        }
        if (compareDates(date, c.firstDay) < 0) {
          throw new HttpError(422, 'unprocessable', 'A day before the plan began has no briefing.');
        }
        const tasks = await days.tasksAt(ctx, userId, c, date);
        const earlierBlocks = c.snapshots
          .filter((s) => compareDates(s.date, date) < 0)
          .flatMap((s) => s.blocks);
        const base = {
          date,
          tasks,
          earlierBlocks,
          pattern: c.pattern,
          overrides: c.plan.overrides,
          skillIds: planSkillIds(c.plan.summary),
        };
        const snap = c.snapshots.find((s) => s.date === date);
        if (snap) {
          return { ...base, frozen: true, blocks: snap.blocks, warnings: [], finishDate: null };
        }
        if (date !== c.today) {
          throw new HttpError(422, 'unprocessable', 'That day is no longer stored.');
        }
        const result = run(c, c.pattern, c.plan.overrides, date, tasks);
        return {
          ...base,
          frozen: false,
          blocks: result.blocks.filter((b) => b.date === date),
          warnings: result.warnings,
          finishDate: result.finishDate,
        };
      });
    },

    /** Computes the schedule the changes would give and compares it; saves nothing but frozen past days. */
    async preview(userId: string, planId: string, changes: PreviewChanges): Promise<PreviewView> {
      return db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        const pattern = changes.pattern ?? c.pattern;
        const day = changes.today ?? c.today;
        const overrides = mergeOverrides(c.plan, changes);

        const before = run(c, c.pattern, c.plan.overrides, day);
        const after = run(c, pattern, overrides, day);
        return {
          today: day,
          summary: summarizeChanges(before, after, {
            today: engineToday(c, day),
            pattern,
            overrides: withCalendarDays(c, overrides),
            tasks: c.plan.tasks,
          }),
          current: { finishDate: before.finishDate, warnings: before.warnings },
          proposed: {
            finishDate: after.finishDate,
            warnings: after.warnings,
            blocks: after.blocks,
          },
        };
      });
    },

    /**
     * Tasks to show as "open" in the weekly view: not done, and either planned this week (a
     * frozen day of the week or a block still to come) or carried over, meaning planned on an
     * earlier frozen day and still open. A skipped task is shown only when it is carried over
     * (it was planned on an earlier day and then skipped), so the user can reconsider it
     * (spec 9); it is never planned ahead.
     */
    async openTasks(userId: string, planId: string, today?: string): Promise<OpenTasksView> {
      return db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        const day = today ?? c.today;
        const weekStart = addDays(day, -weekday(day));
        const weekEnd = addDays(weekStart, 6);
        const result = run(c, c.pattern, c.plan.overrides, day);

        const carried = new Map<string, Set<string>>();
        for (const s of c.snapshots) {
          if (compareDates(s.date, day) > 0) continue;
          for (const b of s.blocks) {
            const dates = carried.get(b.taskId) ?? new Set<string>();
            dates.add(s.date);
            carried.set(b.taskId, dates);
          }
        }
        const planned = new Map<string, Set<string>>();
        for (const b of result.blocks) {
          if (compareDates(b.date, weekStart) < 0 || compareDates(b.date, weekEnd) > 0) continue;
          const dates = planned.get(b.taskId) ?? new Set<string>();
          dates.add(b.date);
          planned.set(b.taskId, dates);
        }

        const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort(compareDates);
        const tasks: OpenTask[] = [];
        for (const t of c.plan.tasks) {
          if (t.status === 'done') continue;
          const plannedDates = sorted(planned.get(t.id));
          const carriedOverFrom = sorted(carried.get(t.id));
          if (plannedDates.length === 0 && carriedOverFrom.length === 0) continue;
          tasks.push({
            taskId: t.id,
            title: t.title,
            type: t.type,
            status: t.status,
            estHours: t.estHours,
            doneHours: t.doneHours,
            remainingHours: Math.max(0, t.estHours - t.doneHours),
            plannedDates,
            carriedOverFrom,
          });
        }
        return { today: day, weekStart, weekEnd, tasks };
      });
    },
  };
}

export type SchedulingService = ReturnType<typeof createSchedulingService>;
