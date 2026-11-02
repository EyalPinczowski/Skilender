import { buildBriefing, type Briefing } from '@skillstack/shared';
import type { PracticeService } from '../practice/service';
import type { SchedulingService } from '../scheduling/service';

/**
 * The day briefing (spec 3.2). The overview is always built by the shared, deterministic
 * `buildBriefing`; no AI provider is consulted, nothing is cached and nothing is written. The
 * day's blocks and warnings come from the scheduling service, which rolls missed days over
 * first, like every other read.
 *
 * Practice entries get the dynamic prompt from the practice service (the one the prompt route
 * builds, with the last same-kind next focus) and the id of an active session. The task's own
 * template stays on any failure. The job description is part of that prompt exactly as in the
 * prompt route (it is for the user to copy); it is not stored or logged here.
 */
export function createBriefingService(scheduling: SchedulingService, practice?: PracticeService) {
  return {
    async get(userId: string, planId: string, date: string): Promise<Briefing> {
      const day = await scheduling.dayPlan(userId, planId, date);
      const briefing = buildBriefing({
        date: day.date,
        blocks: day.blocks,
        tasks: day.tasks,
        earlierBlocks: day.earlierBlocks,
        pattern: day.pattern,
        overrides: day.overrides,
        warnings: day.warnings,
        finishDate: day.finishDate,
        skillIds: day.skillIds,
      });
      if (!practice) return briefing;
      const tasks = [];
      for (const t of briefing.tasks) {
        if (t.type !== 'practice') {
          tasks.push(t);
          continue;
        }
        try {
          const entry = await practice.briefingEntry(userId, planId, t.taskId);
          tasks.push({
            ...t,
            promptTemplate: entry.prompt,
            ...(entry.practiceSessionId ? { practiceSessionId: entry.practiceSessionId } : {}),
          });
        } catch {
          tasks.push(t); // the template stays
        }
      }
      return { ...briefing, tasks };
    },
  };
}

export type BriefingService = ReturnType<typeof createBriefingService>;
