import { z } from 'zod';

/**
 * A Google-Calendar-like event, reduced to the fields the busy classifier needs (spec 3.8).
 * Unknown fields are stripped, so nothing beyond title and times is kept from external events.
 */

const ResponseStatusSchema = z.enum(['needsAction', 'declined', 'tentative', 'accepted']);

/** A timed boundary (RFC 3339, offset required) or an all-day boundary (`YYYY-MM-DD`). */
export const CalendarEventTimeSchema = z.object({
  dateTime: z.iso.datetime({ offset: true }).optional(),
  date: z.iso.date().optional(),
  timeZone: z.string().optional(),
});

export const CalendarEventSchema = z.object({
  id: z.string().min(1),
  /** Changes on every edit; sent as If-Match so a write fails if the event moved on. */
  etag: z.string().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  summary: z.string().optional(),
  start: CalendarEventTimeSchema,
  end: CalendarEventTimeSchema,
  /** Google: `opaque` (shown as Busy, the default) or `transparent` (shown as Free). */
  transparency: z.enum(['opaque', 'transparent']).optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
  attendees: z
    .array(
      z.object({
        self: z.boolean().optional(),
        responseStatus: ResponseStatusSchema.optional(),
      }),
    )
    .optional(),
  /** Google adds types over time (default, outOfOffice, focusTime, workingLocation, birthday, ...). */
  eventType: z.string().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarEventInput = z.input<typeof CalendarEventSchema>;
