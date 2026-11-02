/**
 * Guard-approved write targets (spec 3.8). The brand symbol is private to this file and the only
 * way to build a value is `mintTarget` / `mintInsertTarget`, which ESLint allows only in
 * write-guard.ts. Casting to these types (`as Guarded...`) is banned outside this file too.
 */

declare const guardBrand: unique symbol;

/** Approved destination for a new event. */
export interface GuardedInsertTarget {
  readonly calendarId: string;
  readonly [guardBrand]: true;
}

/** Approved existing event (checked: in the app calendar, tagged as ours). */
export interface GuardedTarget {
  readonly calendarId: string;
  readonly eventId: string;
  /** The etag seen when the guard re-fetched the event; sent as If-Match. */
  readonly etag?: string;
  readonly [guardBrand]: true;
}

export function mintInsertTarget(calendarId: string): GuardedInsertTarget {
  return Object.freeze({ calendarId }) as GuardedInsertTarget;
}

export function mintTarget(calendarId: string, eventId: string, etag?: string): GuardedTarget {
  return Object.freeze({ calendarId, eventId, etag }) as GuardedTarget;
}
