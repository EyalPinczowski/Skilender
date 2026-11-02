# 014 – Rename Skillstack to Upversion

**Status:** Accepted (owner approved the rename)

## Context
Several existing learning and skills products already use the name "Skillstack": the SkillStack® skills-tracking system from Idaho, an Irish SkillStack learning platform, and a UNSW Skillstack badge. Sharing a name with them risks confusion and a trademark conflict. None of this was checked against a trademark register (needs check).

## Options
1. Keep "Skillstack". Rejected: the overlap above.
2. Rename to "Upversion".
3. Wait for a later release. Rejected: the cost of renaming grows with every file and public page.

## Decision
Option 2. "Upversion" replaces "Skillstack" in the UI, the PWA manifest, the docs, the legal drafts, the code (`APP_NAME`, npm scope `@upversion/*`), the catalog build scripts and generated files, and the calendar the app creates and writes to (spec 3.8, ADR 002: the calendar is named "Upversion", the iCalendar `PRODID` is `-//Upversion//Schedule export//EN`, the UID host is `@upversion`, and the task header is `X-UPVERSION-TASK-ID`). The tagline changes in the same commit, from "build your skills, one block at a time" to "A study plan that improves with you".

## Second pass: everything renamed
The first commit kept some identifiers to avoid breaking live infrastructure. The owner then decided to rename everything, so a second commit (`refactor: rename remaining skillstack identifiers to upversion`) changed all of them:
- Postgres internals in `packages/db`: the advisory-lock key is now `upversion:migrate:<schema>` and the transaction-local settings are `upversion.app_password` / `upversion.backup_password` (`passwords.ts`). Both sides of each are set and read in the same statement, and no SQL file or applied migration reads them, so no migration was touched.
- Hosting names: Render services `upversion-api` and `upversion-api-rnd` (`render.yaml`), Cloudflare Workers `upversion-web` and `upversion-web-rnd` (`wrangler.jsonc`, `docs/setup/deployments.md`).
- Repository URLs and repo-name examples (`github.com/EyalPinczowski/upversion`, `<owner>/upversion`, the spec's repo-name question).
- Names of the owner's private resources used as examples (`upversion-private`, `upversion-backup.key`, `upversion-public`). They are only examples.
- Browser storage keys: `upversion.theme`, `upversion.plan`, `upversion.practice.*` and the E2E-only `upversion.e2e.access-token`. So that nobody loses settings or saved practice sessions, `apps/web/src/lib/legacy-storage.ts` runs once at app start (first thing in `mount`). For every `skillstack.*` localStorage key it copies the value to the `upversion.*` key if that is absent, then removes the old key. It is idempotent and tolerates storage that throws. The E2E token key needs no migration.

The only remaining "skillstack" text is deliberate: this ADR, the "(formerly Skillstack)" notes, the ADR index row, and the legacy-storage migration with its tests, which must name the old keys.

### Cutover
The live Render services and Cloudflare Workers still carry the old names until the owner renames them. Follow "Renaming the live services (Skillstack to Upversion cutover)" in [`docs/setup/deployments.md`](../setup/deployments.md), and rename the Cloudflare Worker before the change reaches `rnd` builds, because the name in `wrangler.jsonc` must match the dashboard.

## Consequences
- Until the owner does the cutover, the repository and the live services disagree on names; a Cloudflare build fails if the Worker is not renamed first.
- Historical documents say "Upversion (formerly Skillstack)" on first mention.
- The export download file is now `upversion-export.json`.

## Follow-ups for the owner
- Do the cutover steps in `docs/setup/deployments.md`.
- Run a formal trademark search (USPTO, EUIPO, Israel): **needs check**.
- Domains: upversion.com and upversion.co are registered by others. An "upVersion Consulting LLC" (product design consulting) uses upversion.co. Buying a domain costs money and needs owner approval under the $0 rule; v1.0 uses the free hosting address.
