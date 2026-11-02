# Google Calendar setup (owner guide)

Calendar sync is optional and off by default (`FEATURE_CALENDAR`). Do these steps once per environment. Costs $0: do not enable billing. If any screen asks for a card, stop.

Google's console screens and limits change. Anything marked **needs check** has not been confirmed in Google's current documentation.

## 1. Create the project

1. Open the Google Cloud console and create a new project, for example "app-calendar". Use a separate project from the one used for sign-in.
2. Do not link a billing account.
3. APIs & Services → Library → enable **Google Calendar API**.

## 2. Consent screen

1. APIs & Services → OAuth consent screen (Google Auth Platform) → user type **External**.
2. Fill in the app name, support email and developer contact email.
3. Add only these two scopes, nothing else:
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `https://www.googleapis.com/auth/calendar.readonly`
4. Publishing status: **Publish app** to **In production**, without verification. In Testing status refresh tokens expire after 7 days (**needs check**), which breaks sync every week.
5. What to expect without verification (all **needs check**):
   - Users see a "Google hasn't verified this app" warning and must click through it.
   - The number of users is capped (about 100 over the project's lifetime).
   - Verification needs a domain, a privacy policy and a review of the scopes. It must be done before calendar sync is opened to the public (see `docs/FUTURE.md`).

## 3. OAuth client

1. APIs & Services → Credentials → Create credentials → OAuth client ID → **Web application**.
2. Authorized redirect URIs:
   - `<rnd web origin>/calendar/callback`
   - `<prod web origin>/calendar/callback`
   - `http://localhost:5173/calendar/callback` (the dev server port needs check)
3. Copy the client id and secret into Render only. Never commit them or paste them in chat.

## 4. Render environment variables

Set these in Render for each environment (R&D and production), as secrets:

| Variable               | Value                                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | from the OAuth client                                               |
| `GOOGLE_CLIENT_SECRET` | from the OAuth client                                               |
| `GOOGLE_REDIRECT_URI`  | `<web origin>/calendar/callback`, exactly as listed in step 3       |
| `CALENDAR_TOKEN_KEYS`  | `v1:<base64>`, where the value comes from `openssl rand -base64 32` |
| `FEATURE_CALENDAR`     | `true`                                                              |

Use a different key for each environment. To rotate, generate a new key, put it first with the next id (`v2:<new>,v1:<old>`), and keep the old one until no stored token needs it. Back up the keys somewhere private: losing them means every user must reconnect.

## 5. Smoke-test checklist

Run these once on R&D with a throwaway Google account before relying on the behaviour. Record the result next to each item and update ADR 014 if something differs.

- [ ] `calendars.insert` works with only the two scopes (creates the app's secondary calendar).
- [ ] `calendarList.list` works with only the two scopes and returns the user's calendars.
- [ ] `events.get` on a deleted event still returns `extendedProperties` and the etag.
- [ ] `events.patch` with `status=confirmed` restores a deleted event.
- [ ] A write with a stale `If-Match` etag fails with 412.
- [ ] In Testing status, the refresh token stops working after 7 days (confirms why production status is needed).
- [ ] Revoking access on the Google Account permissions page makes the next sync show "Reconnect calendar".
- [ ] Disconnect in the app deletes only the events the app created.
- [ ] A full `events.list` with `timeMin`/`timeMax`/`singleEvents=true` returns a `nextSyncToken` on its last page, and a later call with only that token (plus `singleEvents=true`) returns just the changes, cancelled events included. The sync engine depends on this; if not, every sync is a full listing (correct, but more calls).
- [ ] An incremental call with an expired or invalid token answers HTTP 410 (the engine then does a full listing of that calendar).
- [ ] Re-inserting an event with the id of a deleted (cancelled) event of the app answers 409, and `events.get` still returns its tags, so the write guard restores it. If the tags are missing the engine falls back to the next id generation (up to 3).
- [ ] A listing of the app calendar with `showDeleted=true` returns events the user deleted as `status=cancelled`; a moved event shows new `start`/`end` (the engine compares them with the times it last wrote).
