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
