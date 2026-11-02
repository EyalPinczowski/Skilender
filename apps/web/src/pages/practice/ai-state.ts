import { isAiUnavailable, isApiError } from '../../api/errors';

export const REDACTION_NOTICE = 'Removed contact details before sending';
export const AI_CAN_BE_WRONG = 'AI feedback can be wrong. Check facts, links and numbers yourself.';

/** Why the AI cannot answer: its daily cap is used, or no provider can answer now. */
export type AiDown = 'cap' | 'unavailable';

export function aiDownReason(error: unknown): AiDown | null {
  if (!isAiUnavailable(error)) return null;
  return isApiError(error) && error.code === 'ai_user_cap' ? 'cap' : 'unavailable';
}
