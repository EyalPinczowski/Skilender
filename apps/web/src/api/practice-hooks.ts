import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from './client';
import { useApi } from './context';
import { isApiError } from './errors';
import { logsKey, openTasksKey, progressKey, scheduleKey, tasksKey } from './hooks';
import type { paths } from './schema';

/**
 * Data hooks of the practice screen (spec 3.3). Scores, trends and next_focus are computed by the
 * API; nothing here derives them. Nothing marks a task done unless the caller passes markDone.
 */
type JsonOf<T> = T extends { responses: { 200: { content: { 'application/json': infer B } } } }
  ? B
  : never;
type BodyOf<T> = T extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : never;

const CONTEXT = '/api/v1/plans/{planId}/practice/context' as const;
const PROMPT = '/api/v1/plans/{planId}/tasks/{taskId}/practice/prompt' as const;
const START = '/api/v1/plans/{planId}/tasks/{taskId}/practice/sessions' as const;
const SESSION = '/api/v1/plans/{planId}/practice/sessions/{sessionId}' as const;
const FEEDBACK = '/api/v1/plans/{planId}/practice/sessions/{sessionId}/feedback' as const;
const FINISH = '/api/v1/plans/{planId}/practice/sessions/{sessionId}/finish' as const;
const MESSAGES = '/api/v1/plans/{planId}/practice/sessions/{sessionId}/messages' as const;
const ABANDON = '/api/v1/plans/{planId}/practice/sessions/{sessionId}/abandon' as const;

export type JobDescription = JsonOf<paths[typeof CONTEXT]['get']>;
export type SavedJobDescription = JsonOf<paths[typeof CONTEXT]['put']>;
export type PracticePrompt = JsonOf<paths[typeof PROMPT]['get']>;
export type SessionDetail = JsonOf<paths[typeof SESSION]['get']>;
export type PracticeSession = SessionDetail['session'];
export type PracticeFeedback = NonNullable<SessionDetail['feedback']>;
export type FinishInput = BodyOf<paths[typeof FINISH]['post']>;
export type FinishResult = JsonOf<paths[typeof FINISH]['post']>;
export type PasteInput = BodyOf<paths[typeof FEEDBACK]['post']>;
export type PasteResult = JsonOf<paths[typeof FEEDBACK]['post']>;
export type SendMessageResult = JsonOf<paths[typeof MESSAGES]['post']>;
export type PracticeChannel = BodyOf<paths[typeof START]['post']>['channel'];
/** What a finished session reports back, whichever route finished it. */
export type FinishedSession = FinishResult & { parsed?: boolean };

export const jobDescriptionKey = (planId: string) => ['practice-context', planId] as const;
export const promptKey = (planId: string, taskId: string) =>
  ['practice-prompt', planId, taskId] as const;
export const sessionKey = (planId: string, sessionId: string) =>
  ['practice-session', planId, sessionId] as const;

const mutationDefaults = { networkMode: 'always' } as const;

/** The job description saved for the plan. Personal content: kept in memory only, never persisted. */
export function useJobDescription(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: jobDescriptionKey(planId ?? ''),
    queryFn: ({ signal }) =>
      unwrap(api.raw.GET(CONTEXT, { params: { path: { planId: planId! } }, signal })),
    enabled: !!planId,
    gcTime: 60_000,
  });
}

export function useSaveJobDescription(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (jobDescription: string) =>
      unwrap(api.raw.PUT(CONTEXT, { params: { path: { planId } }, body: { jobDescription } })),
    onSuccess: (saved) => {
      queryClient.setQueryData(jobDescriptionKey(planId), {
        jobDescription: saved.jobDescription,
        updatedAt: saved.jobDescription === '' ? null : saved.updatedAt,
      });
      // The ready-made prompt includes the job description, so every prompt is stale now.
      void queryClient.invalidateQueries({ queryKey: ['practice-prompt', planId] });
    },
  });
}

/** The ready-made prompt for a practice task. Saves nothing. */
export function usePracticePrompt(planId: string | undefined, taskId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: promptKey(planId ?? '', taskId),
    queryFn: ({ signal }) =>
      unwrap(api.raw.GET(PROMPT, { params: { path: { planId: planId!, taskId } }, signal })),
    enabled: !!planId && enabled,
    gcTime: 60_000,
  });
}

/** One session, or null when it does not exist (the API answers 404). */
export function usePracticeSession(planId: string | undefined, sessionId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: sessionKey(planId ?? '', sessionId ?? ''),
    queryFn: async ({ signal }): Promise<SessionDetail | null> => {
      try {
        return await unwrap(
          api.raw.GET(SESSION, {
            params: { path: { planId: planId!, sessionId: sessionId! } },
            signal,
          }),
        );
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!planId && !!sessionId,
  });
}

export function useStartSession(planId: string, taskId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (input: { id: string; channel: PracticeChannel }) =>
      unwrap(api.raw.POST(START, { params: { path: { planId, taskId } }, body: input })),
    onSuccess: (detail) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(planId, detail.session.id), {
        ...detail,
        feedback: null,
      });
    },
  });
}

function useAfterFinish(planId: string) {
  const queryClient = useQueryClient();
  return (result: FinishedSession) => {
    queryClient.setQueryData<SessionDetail | null>(
      sessionKey(planId, result.session.id),
      (old) => ({
        session: result.session,
        messages: old?.messages ?? [],
        feedback: result.feedback,
      }),
    );
    // The task, the day's hours, the plan progress and the next prompt may all have changed.
    for (const key of [
      tasksKey(planId),
      progressKey(planId),
      scheduleKey(planId),
      openTasksKey(planId),
      logsKey(planId),
      ['day', planId],
      ['briefing', planId],
      ['practice-prompt', planId],
      ['practice-history', planId],
      ['practice-trends', planId],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** Finishes with a rubric, an entered score or nothing. `markDone` is always an explicit choice. */
export function useFinishSession(planId: string, sessionId: string) {
  const api = useApi();
  const after = useAfterFinish(planId);
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: FinishInput) =>
      unwrap(api.raw.POST(FINISH, { params: { path: { planId, sessionId } }, body })),
    onSuccess: after,
  });
}

/** Finishes with a pasted feedback block (or any text, saved as plain text when it is not a block). */
export function usePasteFeedback(planId: string, sessionId: string) {
  const api = useApi();
  const after = useAfterFinish(planId);
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: PasteInput) =>
      unwrap(api.raw.POST(FEEDBACK, { params: { path: { planId, sessionId } }, body })),
    onSuccess: after,
  });
}

/** Gives up: nothing is logged and the task is untouched. */
export function useAbandonSession(planId: string, sessionId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: () => unwrap(api.raw.POST(ABANDON, { params: { path: { planId, sessionId } } })),
    onSuccess: (result) => {
      queryClient.setQueryData<SessionDetail | null>(sessionKey(planId, sessionId), (old) => ({
        session: result.session,
        messages: old?.messages ?? [],
        feedback: null,
      }));
    },
  });
}

/**
 * One chat turn. The caller picks the message id and keeps it for a retry of the same text: the API
 * then answers with the stored pair instead of calling a model again.
 */
export function useSendMessage(planId: string, sessionId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (input: { id: string; content: string }) =>
      unwrap(api.raw.POST(MESSAGES, { params: { path: { planId, sessionId } }, body: input })),
    onSuccess: (result) => {
      queryClient.setQueryData<SessionDetail | null>(sessionKey(planId, sessionId), (old) => {
        if (!old) return old;
        const known = new Set(old.messages.map((m) => m.id));
        const added: SessionDetail['messages'] = [];
        const seq = result.userMessage.seq;
        if (!known.has(result.userMessage.id)) added.push(result.userMessage);
        if (result.switched && !result.replayed) {
          added.push({
            id: `note-${result.reply.id}`,
            seq: seq + 1,
            role: 'note',
            content: `Continuing on ${result.switched.toLabel}.`,
            providerId: result.switched.to,
            model: null,
            redacted: false,
            createdAt: result.userMessage.createdAt,
          });
        }
        if (!known.has(result.reply.id)) {
          added.push({
            id: result.reply.id,
            seq: seq + added.length + 1,
            role: 'assistant',
            content: result.reply.content,
            providerId: result.reply.providerId,
            model: result.reply.model,
            redacted: false,
            createdAt: result.userMessage.createdAt,
          });
        }
        return { ...old, messages: [...old.messages, ...added] };
      });
      // The stored transcript is the truth (real note and reply ids and order).
      void queryClient.invalidateQueries({ queryKey: sessionKey(planId, sessionId) });
      void queryClient.invalidateQueries({ queryKey: ['ai-usage'] });
    },
    onError: () => {
      // A superseded or in-progress turn: show what the server really holds.
      void queryClient.invalidateQueries({ queryKey: sessionKey(planId, sessionId) });
    },
  });
}
