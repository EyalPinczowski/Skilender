# 013 – Free AI providers after GitHub Models

**Status:** Accepted for the code (providers built in v0.3; both stay off until the owner confirms their no-card status) · spec 3.3 and 12.3 change proposed, **not yet approved**

## Context
Spec 3.3 names GitHub Models as the primary provider, with Groq and Gemini as fallbacks. The owner's plan decision is that GitHub Models is retired (no official page confirming this was read: needs check). Research on 2026-11-01 (`docs/setup/ai-providers.md`) read the official pages of the candidates. Gemini's free tier uses content to improve products and lets human reviewers read it, so it is out. Cloudflare Workers AI is the only candidate whose free cap, error on exhaustion and data terms were all stated on an official page. Groq's Free-plan limits and card requirement were not stated on the pages read.

## Options
1. Keep the spec as written. Not possible: the primary is gone.
2. Cloudflare Workers AI primary, Groq fallback, others excluded.
3. Add a paid provider. Rejected: breaks the $0 rule.

## Decision
Option 2.
- **Cloudflare Workers AI** (`cloudflare-ai`): Workers Free stops with an error at 10,000 Neurons a day instead of charging. Whether sign-up asks for a card is **needs check**, so it is treated like Groq: it declares `costTier: 'paid'` (refused by the guard) and is registered only when `CLOUDFLARE_FREE_PLAN_CONFIRMED=true`, which the owner sets after confirming no card was asked and the account shows Workers Free.
- **Groq** (`groq`): built, but off by default. It declares `costTier: 'paid'` so the guard refuses it, and is registered only when `GROQ_NO_CARD_CONFIRMED=true`. Free-plan limits and card requirement are **needs check**.
- A listed provider that is left out (missing credentials, malformed account id, or no confirmation) is logged as `<id> listed but not configured` at startup; the API still starts.
- Both are plain `fetch` clients with no SDK, HTTPS only, a 1 MB response cap, the key only in the `Authorization` header, redirects refused, and errors that never carry the provider's text. Failures map to the gateway contract: 429 to a quota error (with `retry-after`), 5xx, network, timeout and bad bodies to unavailable, 401, 403 and 404 to unavailable (provider-wide, so a cooldown applies), other 4xx to unavailable with `requestSpecific`.
- Endpoint URLs and model ids are marked **needs check** in code until the first real call on R&D.

## Consequences
- Free capacity is small: roughly 120 to 750 chat turns a day on Cloudflare depending on the model, so the per-user caps, the cache and the copy-prompt and rule-based fallbacks do the real work.
- Adding a provider is one file plus one entry (`docs/EXTENDING.md`).
- If neither provider is confirmed, AI stays off and the app is unchanged.

## Proposed spec change (not applied)
- 3.3 provider table: replace the GitHub Models row with Cloudflare Workers AI (primary; 10,000 Neurons per day, fails with an error when used up), keep Groq as fallback (free-plan limits needs check), drop Gemini (free-tier data is used to improve products).
- 3.3 and 12.3 text and the `AIProvider` implementations list: "Cloudflare Workers AI, Groq" instead of "GitHub Models, Groq, Gemini".
- Open question list: replace "keys for GitHub Models / Groq / Gemini" with "accounts for Cloudflare Workers AI and Groq".
