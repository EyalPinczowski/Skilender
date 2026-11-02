import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';
import { callbackBody, calendarView, connectView, updateSourcesBody } from './schemas';
import type { CalendarService } from './service';

export interface CalendarRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the routes then answer 503. */
  db: Database | null;
  /** Null together with `db`. */
  service: CalendarService | null;
}

const errors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  409: errorResponseSchema,
  429: errorResponseSchema,
  502: errorResponseSchema,
};
const security = [{ bearerAuth: [] }];
const tags = ['calendar'];

/**
 * Google Calendar connect and disconnect (spec 3.8). Registered only when FEATURE_CALENDAR is on,
 * so with the flag off these paths do not exist (404). The user id comes from the verified token
 * only: no body field, query value or OAuth state ever names a user. No response carries a token.
 */
export const calendarRoutes: FastifyPluginAsyncZod<CalendarRoutesOptions> = async (
  app,
  { verifier, db, service },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const user = (request: FastifyRequest) => request.accountId!;

  app.get(
    '/calendar',
    {
      schema: {
        tags,
        summary: 'Calendar connection status and the calendars that block time',
        security,
        response: { 200: calendarView, ...errors },
      },
    },
    async (request) => service!.getCalendar(user(request)),
  );

  app.post(
    '/calendar/connect',
    {
      schema: {
        tags,
        summary: 'Start connecting Google Calendar',
        description:
          'Returns the Google consent URL (PKCE S256, single-use state valid for 10 minutes, only the calendar.app.created and calendar.readonly scopes). Redirect the browser there.',
        security,
        response: { 200: connectView, ...errors },
      },
    },
    async (request) => service!.startConnect(user(request)),
  );

  app.post(
    '/calendar/callback',
    {
      schema: {
        tags,
        summary: 'Finish connecting Google Calendar',
        description:
          'Send the `code` and `state` Google returned to the web app. The state must have been issued to the signed-in user and is single use. If Google granted less than both scopes, nothing is connected and the grant is revoked (400 `scopes_not_granted`).',
        security,
        body: callbackBody,
        response: { 200: calendarView, ...errors },
      },
    },
    async (request) =>
      service!.completeConnect(user(request), request.body.code, request.body.state),
  );

  app.put(
    '/calendar/sources',
    {
      schema: {
        tags,
        summary: 'Choose which calendars block study time',
        security,
        body: updateSourcesBody,
        response: { 200: calendarView, 404: errorResponseSchema, ...errors },
      },
    },
    async (request) => service!.setSources(user(request), request.body.sources),
  );

  app.delete(
    '/calendar',
    {
      schema: {
        tags,
        summary: 'Disconnect Google Calendar',
        description:
          'Deletes the events the app created (never the calendar itself and never other events), revokes the refresh token at Google (best effort) and deletes the calendar data the app stores. If Google rejects the stored credentials (409 `calendar_reconnect_required`) or cannot be reached (502), nothing is deleted and the request can be repeated after reconnecting or later.',
        security,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await service!.disconnect(user(request));
      return reply.status(204).send(null);
    },
  );
};
