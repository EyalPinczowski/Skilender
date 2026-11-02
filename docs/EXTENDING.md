# Extending Skilender

Each extension point is meant to be **one new file plus a config entry, with no change to the core**. This guide is filled in as the interfaces are built (see `docs/decisions/`); until then it records the intended shape.

| Extension | Interface | Where | Status |
|---|---|---|---|
| A new calendar | `CalendarProvider` | `apps/api/src/modules/calendar` | Planned (v0.3b) |
| A new AI model provider | `AIProvider` | `apps/api/src/ai` | Built; Cloudflare Workers AI and Groq in v0.3 |
| A new notification channel | `NotificationChannel` | `apps/api/src/modules/notifications` | Planned |
| A progress importer | `ProgressSource` | `apps/api/src/modules/progress` | Planned |
| A data exporter | `Exporter` | `apps/api/src/modules/export` | Planned |

## Rules every extension follows

- The calendar write guard sits above `CalendarProvider`, so a new provider cannot write to events the app did not create.
- An `AIProvider` declares `costTier`; paid providers are refused unless the owner enables them with a spending cap.
- No personal details (name, email, phone, links) are sent to a model.
- New features ship behind a feature flag (all off by default).
- Business logic stays in the API and in `packages/shared`; the web app only renders what the API returns.

## Adding an AI provider

A provider is one file plus one entry. The gateway (`apps/api/src/ai/gateway.ts`) already handles budgets, fallback, cooldowns, caching and redaction, so none of it changes.

1. **Write `apps/api/src/ai/providers/<id>.ts`** exporting a factory that returns an `AIProvider` (`provider.ts`): `id`, `label`, `costTier`, `maxContextChars` and `generate(request, { signal })`.
   - Use `postJson` from `providers/http.ts`. It enforces HTTPS, sends the key only as `Authorization: Bearer`, refuses redirects, caps the body at 1 MB, passes the abort signal on, and maps failures: 429 to `ProviderQuotaError` (with `retry-after`), 5xx, network, timeout and bad bodies to `ProviderUnavailableError`, other 4xx to `ProviderUnavailableError(true)`.
   - Parse the reply with Zod and throw `ProviderUnavailableError` on anything unexpected. Never copy provider text, URLs or the key into an error or a log line.
   - Take `fetch` as an option so tests need no network.
   - Declare `costTier: 'free'` only when the provider's official pages say the free plan needs no card and stops (not charges) at its limit. Otherwise declare `'paid'` and keep it off until the owner has confirmed it.
2. **Register it** in `providers/index.ts` (one factory line that reads its credentials and returns `null` when they are missing) and add its id to `PROVIDER_IDS` in `apps/api/src/config.ts`.
3. **Add env names** to `.env.example` and, as `sync: false` entries without values, to both services in `render.yaml`. Add `AI_BUDGET_<ID>_DAILY` to the docs.
4. **Test it** like `apps/api/test/ai-providers.test.ts`: fixtures for success, 429 with `retry-after`, 5xx, other 4xx, malformed JSON, timeout and oversized body, and a snapshot of the request body so no field is added by accident.
5. **Document it** in `docs/setup/ai-providers.md` with the page and date for every claim, and mark anything unread as needs check. Mark endpoint URLs and model ids needs check until a real call has confirmed them.
