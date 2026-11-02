/**
 * The id of the running practice session is remembered so a reload picks it up again. It is only
 * an id: no prompt, job description or feedback is ever stored in the browser.
 */
const PREFIX = 'upversion.practice.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const keyOf = (planId: string, taskId: string) => `${PREFIX}${planId}.${taskId}`;

/** The remembered id, or null when there is none or it is not a UUID (never used unchecked). */
export function readStoredSession(planId: string, taskId: string): string | null {
  try {
    const value = window.localStorage.getItem(keyOf(planId, taskId));
    return isSessionId(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredSession(planId: string, taskId: string, sessionId: string | null) {
  try {
    if (sessionId && isSessionId(sessionId)) {
      window.localStorage.setItem(keyOf(planId, taskId), sessionId);
    } else window.localStorage.removeItem(keyOf(planId, taskId));
  } catch {
    // Without storage the page still works; a reload just starts from the start panel.
  }
}

/** Forgets every remembered session, for example when the person signs out. */
export function clearStoredSessions() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Nothing to clear without storage.
  }
}
