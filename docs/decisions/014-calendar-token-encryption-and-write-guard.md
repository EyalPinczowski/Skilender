# 014 – Calendar token encryption and write guard

**Status:** Accepted · calendar feature (v0.3b). Builds on ADR 002 (scopes and write guard) and ADR 006 (OAuth production status).

## Context
Calendar sync stores a long-lived Google refresh token and writes to a user's real calendar. A leaked token or a write to the wrong event would destroy trust. The details below were not fixed by ADR 002 and 006.

## Decision
- **Token encryption.** Refresh tokens are encrypted with AES-256-GCM before they reach the database. The user id and the key id are bound in as associated data, so a ciphertext copied to another user or relabelled with another key id fails to decrypt. Tokens are decrypted only in the backend and never sent to the browser.
- **Key rotation.** `CALENDAR_TOKEN_KEYS` holds keys as `<id>:<base64 of 32 bytes>`, comma separated, newest first. New tokens use the first key; older keys stay to decrypt existing tokens. With `FEATURE_CALENDAR=true` the API refuses to start without a valid key.
- **Branded write guard.** Only one code path can write to Google Calendar. It accepts a branded type that can be produced only by checking that the event is in the app's own secondary calendar and carries the app's `extendedProperties.private` tag. Any other target throws. This sits above the `CalendarProvider` interface.
- **Deterministic event ids.** Each study block maps to one event id derived from the block, so a retried request or a lost response never creates a duplicate.
- **Fixed neutral source tag.** The tag value (`APP_EVENT_SOURCE`) is a constant that does not depend on the product name, so a rename never orphans existing events.
- **Disconnect and account delete remove events only.** The app deletes the events it created and the calendar data and token it stores. It never deletes the secondary calendar itself or anything else in the user's Google account.
- **User-deleted blocks mean unavailable time.** If the user deletes a study block in Google Calendar, the app treats that slot as time the user does not want to study, and reschedules around it instead of recreating the event. (Relies on Google keeping `extendedProperties` and the etag on a deleted event: **needs check**, see `docs/google-calendar-setup.md`.)
- **Busy source.** The primary calendar is the default busy source; other calendars are opt-in.
- **Separate Google Cloud project.** Calendar uses its own Google Cloud project and OAuth client, apart from the sign-in client, so the sensitive scopes and any future verification do not affect sign-in.

## Consequences
- A tampered or mis-keyed ciphertext fails closed, and the user sees "Reconnect calendar".
- Rotating a key needs no downtime or re-encryption; old keys can be removed once no token uses them.
- Tests must prove that a write to a foreign event throws and that ciphertexts do not decrypt for another user id or key id.
- Google behaviours this relies on are listed as smoke tests in `docs/google-calendar-setup.md`.
