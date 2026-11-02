import type { PracticeFeedback, PracticePrompt, SessionDetail } from '../api/practice-hooks';
import { json } from './helpers';
import { PLAN_ID, TASKS, planRoutes, taskView } from './plan-fixtures';

export const BASE = `/api/v1/plans/${PLAN_ID}`;
export const TASK_ID = 'practice1';
export const SESSION_ID = '33333333-3333-4333-8333-333333333333';
export const STARTED_AT = '2026-11-10T09:00:00.000Z';

export const practiceTask = taskView({
  id: TASK_ID,
  title: 'Mock interview',
  type: 'practice',
  estHours: 0.5,
  doneHours: 0,
  status: 'pending',
  order: 5,
  practiceKind: 'behavioral',
  howToSteps: ['Set a timer', 'Answer out loud', 'Write down one lesson'],
});

export const tasksWithPractice = () => [...TASKS, practiceTask];

export const promptBody = (overrides: Partial<PracticePrompt> = {}): PracticePrompt => ({
  persona: { id: 'behavioral', label: 'Behavioral interviewer' },
  prompt: 'Act as a behavioral interviewer.\nAsk me three questions.\n\nEnd with ===FEEDBACK===.',
  inputs: {
    nextFocus: 'Quantify the result',
    nextFocusFrom: 'old-session',
    topics: ['Intro to SQL'],
    jobDescriptionIncluded: false,
    redactions: 0,
  },
  feedbackFormat: '===FEEDBACK===\nscore: 7/10\n===END===',
  ...overrides,
});

export const sessionBody = (
  overrides: Partial<SessionDetail['session']> = {},
  feedback: PracticeFeedback | null = null,
): SessionDetail => ({
  session: {
    id: SESSION_ID,
    planId: PLAN_ID,
    taskId: TASK_ID,
    kind: 'behavioral',
    persona: 'behavioral',
    channel: 'external',
    status: 'active',
    plannedMinutes: 30,
    startedAt: new Date().toISOString(),
    endedAt: null,
    prompt: 'Act as a behavioral interviewer.',
    inputs: {
      nextFocusFromSession: null,
      topicTaskIds: [],
      jobDescriptionIncluded: false,
      redactions: 0,
    },
    ...overrides,
  },
  messages: [],
  feedback,
});

export const feedbackBody = (overrides: Partial<PracticeFeedback> = {}): PracticeFeedback => ({
  source: 'pasted_block',
  score: 7,
  strengths: 'Clear structure.',
  improve: 'Add numbers.',
  nextFocus: 'Quantify the result',
  raw: null,
  createdAt: '2026-11-10T09:40:00.000Z',
  ...overrides,
});

export function finishedBody(
  overrides: {
    feedback?: PracticeFeedback | null;
    loggedHours?: number | null;
    status?: 'pending' | 'in_progress' | 'done' | 'skipped';
    parsed?: boolean;
  } = {},
) {
  const feedback = overrides.feedback === undefined ? feedbackBody() : overrides.feedback;
  return {
    session: sessionBody({ status: 'finished', endedAt: '2026-11-10T09:40:00.000Z' }).session,
    feedback,
    loggedHours: overrides.loggedHours === undefined ? 0.5 : overrides.loggedHours,
    task: { status: overrides.status ?? 'in_progress', doneHours: 0.5 },
    replayed: false,
    parsed: overrides.parsed ?? true,
  };
}

/** Plan routes with the practice task in the list and quiet practice defaults. */
export function practiceRoutes(
  extra: Record<string, (request: Request) => Response | Promise<Response>> = {},
) {
  return planRoutes({
    [`GET ${BASE}/tasks`]: () => json({ tasks: tasksWithPractice() }),
    [`GET ${BASE}/tasks/${TASK_ID}/practice/prompt`]: () => json(promptBody()),
    [`GET ${BASE}/practice/context`]: () => json({ jobDescription: '', updatedAt: null }),
    ...extra,
  });
}
