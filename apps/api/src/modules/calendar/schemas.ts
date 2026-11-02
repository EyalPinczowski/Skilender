import { z } from 'zod';
import { noNulCharacters } from '../../validation';

export const calendarStatus = z.enum(['connected', 'needs_reconnect', 'disconnected']);

export const calendarSourceView = z.object({
  calendarId: z.string(),
  name: z.string(),
  /** Whether events in this calendar are subtracted from capacity. */
  blocksTime: z.boolean(),
});

/** Never carries a token, ciphertext or the app calendar's id. */
export const calendarView = z.object({
  status: calendarStatus,
  lastSyncedAt: z.iso.datetime().nullable(),
  /** A short machine code such as `invalid_grant`; null when the last call worked. */
  lastErrorCode: z.string().nullable(),
  sources: z.array(calendarSourceView),
});

export const connectView = z.object({
  /** Send the browser here; Google redirects back to the web app with `code` and `state`. */
  authorizationUrl: z.url(),
});

/** Strict: a `userId` or any other unknown key is rejected, never ignored. */
export const callbackBody = noNulCharacters(
  z.strictObject({
    code: z.string().min(1).max(2048),
    state: z.string().min(16).max(256),
  }),
);

export const updateSourcesBody = noNulCharacters(
  z.strictObject({
    sources: z
      .array(z.strictObject({ calendarId: z.string().min(1).max(500), blocksTime: z.boolean() }))
      .min(1)
      .max(200),
  }),
);

/** Strict and optional: an empty body (or none) is a normal sync; `userId` or anything else is rejected. */
export const syncBody = noNulCharacters(
  z.strictObject({
    /** Skip the five-minute throttle (still at most once a minute). */
    force: z.boolean().optional(),
  }),
);

export const syncView = z.object({
  /** `cached`: synced within the last five minutes, so Google was not called. */
  status: z.enum(['synced', 'cached']),
  syncedAt: z.iso.datetime().nullable(),
  /** Tasks whose blocks moved because of the calendar (busy events, day-offs, locked blocks). */
  movedTaskIds: z.array(z.string()),
  finishChanged: z.boolean(),
  /** Plain-English change summary to show the user. */
  text: z.string(),
});
