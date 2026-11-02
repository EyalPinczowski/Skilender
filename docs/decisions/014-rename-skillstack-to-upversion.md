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

## Intentionally kept
These still say "skillstack" because renaming them would break live infrastructure or silently reset stored state:
- Postgres internals in `packages/db`: the advisory-lock key `skillstack:migrate:<schema>` (`migrate.ts`) and the `skillstack.app_password` / `skillstack.backup_password` settings (`passwords.ts`, migrations, `test/setup.sql`). Applied migration files are untouched.
- Hosting names and addresses: Render services `skillstack-api` and `skillstack-api-rnd` (`render.yaml`), the Cloudflare Worker names `skillstack-web` and `skillstack-web-rnd` (`wrangler.jsonc`, `docs/setup/deployments.md`), and any live hostnames.
- GitHub repository URLs (`github.com/EyalPinczowski/skillstack`) and the repo-name examples that point at it (`<owner>/skillstack` in `docs/setup/backup.md`, the repo-name question in the spec).
- Browser storage keys: `skillstack.theme`, `skillstack.plan`, `skillstack.practice.*` and the E2E-only `skillstack.e2e.access-token`. Changing them would reset users' settings and saved practice sessions.
- Names of the owner's private resources used as examples in the backup guide and the Phase 0 review (`skillstack-private`, `skillstack-backup.key`, `skillstack-public`).

## Consequences
- Old and new names coexist in infrastructure until the owner renames those resources. Nothing breaks in the meantime.
- Historical documents say "Upversion (formerly Skillstack)" on first mention.
- The export download file is now `upversion-export.json`.

## Follow-ups for the owner
- Rename the GitHub repository, then update the repo URLs (issue template config, docs) and the remote on local clones.
- Optionally rename the Render services and the Cloudflare Worker/Vercel project. This changes live addresses, so update the API base URL and CORS settings in the same step.
- Run a formal trademark search (USPTO, EUIPO, Israel): **needs check**.
- Domains: upversion.com and upversion.co are registered by others. An "upVersion Consulting LLC" (product design consulting) uses upversion.co. Buying a domain costs money and needs owner approval under the $0 rule; v1.0 uses the free hosting address.
