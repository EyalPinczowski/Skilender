import { GENERIC_RUBRIC_STEPS } from '@skilender/shared';
import type { FinishChoice } from './FinishDialog';

/** Screen-reader announcements happen at these two moments only (spec 3.D). */
export const FIVE_MINUTES_LEFT = '5 minutes left.';
export const TIME_IS_UP = 'Planned time is up. You can keep going; the timer now counts over time.';
export const FIVE_MINUTES = 5 * 60;

const pad = (n: number) => String(n).padStart(2, '0');

/** `mm:ss`, or `h:mm:ss` from one hour. */
export function clock(seconds: number): string {
  const s = Math.abs(Math.trunc(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** One step of the self-check; `index` is its position in the task's own steps (what the API takes). */
export interface RubricStep {
  text: string;
  index: number;
}

/**
 * The steps the self-check lists: the task's own (blank ones left out, positions kept), or the
 * generic ones when it has none.
 */
export function rubricSteps(howToSteps: readonly string[]): RubricStep[] {
  const own = howToSteps
    .map((text, index) => ({ text, index }))
    .filter((step) => step.text.trim() !== '');
  if (own.length > 0) return own;
  return GENERIC_RUBRIC_STEPS.map((text, index) => ({ text, index }));
}

export function describeChoice(choice: FinishChoice): string {
  switch (choice.kind) {
    case 'rubric':
      return `Self-check: ${choice.checkedSteps.length} of ${choice.total} steps ticked.`;
    case 'score':
      return `Your score: ${choice.score} out of ${choice.max}.`;
    case 'paste':
      return `Pasted feedback (${choice.text.trim().length} characters).`;
    case 'ai':
      return 'The AI will write feedback from your chat. It can be wrong.';
    case 'none':
      return 'No feedback will be saved.';
  }
}
