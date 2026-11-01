# Free AI providers

AI is optional. With no provider configured the whole app works with templates and rules. This page records what is known about each free provider. Each claim has the official page it came from and the date it was read. Anything not read on an official page is **needs check**. Limits change, so re-check before relying on them.

**GitHub Models is retired** and is no longer a provider (see [ADR 013](../decisions/013-free-ai-providers-after-github-models.md)).

Never add a payment method to any of these accounts. If a sign-up screen asks for one, stop and ask the owner.

## Cloudflare Workers AI (primary, `cloudflare-ai`)

| Claim | Status | Page | Read |
| --- | --- | --- | --- |
| 10,000 Neurons per day at no charge; resets at 00:00 UTC | Verified | developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-11-01 |
| After the free allocation, further operations **fail with an error** (no silent charge on Workers Free) | Verified | developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-11-01 |
| Paid overage ($0.011 per 1,000 Neurons) exists only on Workers Paid, a plan change the owner must make | Verified | developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-11-01 |
| Text generation: 300 requests per minute unless the model requires Paid | Verified | developers.cloudflare.com/workers-ai/platform/limits/ | 2026-11-01 |
| Neurons per 1M tokens (input / output): llama-3.1-8b-instruct-fp8-fast 4,119 / 34,868; llama-3.3-70b-instruct-fp8-fast 26,668 / 204,805 | Verified | developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-11-01 |
| About 13 Neurons per chat turn on the 8B model and about 81 on the 70B model (1,500 tokens in, 200 out) | Our arithmetic, not a provider fact | | 2026-11-01 |
| Customer content is not used to train models; inputs and outputs are not retained beyond processing (AI Gateway logging would retain them, so it is not used) | Verified | developers.cloudflare.com/workers-ai/platform/data-usage/ | 2026-11-01 |
| OpenAI-compatible base `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` with `/chat/completions` | Verified | developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/ | 2026-11-01 |
| JSON mode needs `response_format: json_schema`, lists llama-3.3-70b-instruct-fp8-fast among supported models, and can fail with "JSON Mode couldn't be met" | Verified | developers.cloudflare.com/workers-ai/features/json-mode/ | 2026-11-01 |
| A card is needed to sign up for the free plan | **Needs check** (pages are silent) | | |
| HTTP status returned when the daily allocation is exhausted | **Needs check** (pages say "error" only). A non-429 4xx is treated as a request-specific failure with no cooldown, so the per-day budget in Neurons (`AI_BUDGET_CLOUDFLARE_AI_DAILY`) is the real guard | | |
| Commercial-use, age and region terms for the free plan | **Needs check** (read cloudflare.com/legal/terms) | | |
| Whether the chosen models carry a beta or deprecation badge; answer quality | **Needs check** | | |
| Endpoint path and model ids in `cloudflare-ai.ts` | **Needs check** until the first real call on R&D | | |

Code: `apps/api/src/ai/providers/cloudflare-ai.ts`. Chat turns use the 8B model; the JSON feedback uses the 70B model. The code does not send `response_format` (JSON mode needs a schema and its errors are unverified); it asks for JSON in the system prompt and the practice pipeline repairs or retries the output.

Set the budget in the same unit the gateway counts. The gateway counts calls, so derive a call budget from the Neuron arithmetic above, for example about 70 percent of 10,000 Neurons at about 13 to 81 Neurons per call.

## Groq (fallback, `groq`)

| Claim | Status | Page | Read |
| --- | --- | --- | --- |
| A Free tier exists; a payment method is needed "to upgrade from the Free tier to the Developer tier" | Verified | console.groq.com/docs/billing-faqs | 2026-11-01 |
| Whether sign-up itself asks for a card | **Needs check** | | |
| Free-plan rate limits | **Needs check**. The page showed only the Developer-plan table (for example gpt-oss-120b: 30 requests per minute, 1,000 per day, 8,000 tokens per minute, 200,000 tokens per day, per organization). Read the Free numbers in the console under Settings, Limits | console.groq.com/docs/rate-limits | 2026-11-01 |
| Limit reached returns 429 with a `retry-after` header | Verified | console.groq.com/docs/rate-limits | 2026-11-01 |
| By default Groq does not retain inference data; logs are kept up to 30 days for reliability and abuse; Zero Data Retention can be switched on in Data Controls | Verified | console.groq.com/docs/your-data | 2026-11-01 |
| Use of free-tier prompts for training | **Needs check** (page silent) | | |
| `json_object` response format works on all models and needs an explicit JSON instruction in the prompt | Verified | console.groq.com/docs/structured-outputs | 2026-11-01 |
| llama-3.3-70b-versatile is a production model | Verified | console.groq.com/docs/models | 2026-11-01 |
| Commercial use on the free plan | **Needs check** | | |
| Endpoint, model id, `max_completion_tokens` name and the `x-ratelimit-remaining-requests` header | **Needs check** until the first real call | | |

Code: `apps/api/src/ai/providers/groq.ts`. **Groq is off by default.** It declares `costTier: 'paid'` (so the guard refuses it) and the factory skips it unless `GROQ_NO_CARD_CONFIRMED=true`. The owner sets that only after confirming and recording that the free plan needs no card and Zero Data Retention is on.

## Not used

| Provider | Reason | Page | Read |
| --- | --- | --- | --- |
| GitHub Models | Retired | n/a | n/a |
| Gemini free tier | Free-tier content is used to improve products and read by human reviewers; not for personal data | ai.google.dev/gemini-api/terms | 2026-11-01 |
| Cerebras | Free credits need a verified payment method | inference-docs.cerebras.ai/support/rate-limits | 2026-11-01 |
| OpenRouter `:free` | 50 requests per day unless credits are bought | openrouter.ai/docs/api-reference/limits | 2026-11-01 |
| Hugging Face Inference Providers | No free credits for free users | huggingface.co/docs/inference-providers/pricing | 2026-11-01 |
| SambaNova | No-card free tier, but 20 requests per day per model; kept as a possible emergency fallback, data terms not read (needs check) | docs.sambanova.ai/docs/en/models/rate-limits | 2026-11-01 |
| Mistral, Together, Fireworks, Cohere, NVIDIA NIM | Terms or limits could not be verified, or a card or purchase is needed | various | 2026-11-01 |

## Environment variables

Names only; values are entered in the Render dashboard (`render.yaml` uses `sync: false`) and never committed.

| Name | Used by | Notes |
| --- | --- | --- |
| `AI_PROVIDERS` | gateway | Comma list in fallback order, for example `cloudflare-ai,groq`. Empty means AI is off |
| `AI_BUDGET_CLOUDFLARE_AI_DAILY`, `AI_BUDGET_GROQ_DAILY` | gateway | Calls per UTC day. No budget means the provider is skipped |
| `CLOUDFLARE_ACCOUNT_ID` | `cloudflare-ai` | 32 hexadecimal characters |
| `CLOUDFLARE_API_TOKEN` | `cloudflare-ai` | Token limited to Workers AI only |
| `GROQ_API_KEY` | `groq` | |
| `GROQ_NO_CARD_CONFIRMED` | `groq` | `true` only after the owner's check above |

A provider whose credentials are missing is left out and reported as not configured.

## Owner checks before turning a provider on

1. Cloudflare: sign up, confirm no card prompt on the Free plan, confirm the plan shows Workers Free, create a token limited to Workers AI, read the terms (commercial use, age, region), make one test call and note the Neurons used and the exact status when the allocation runs out.
2. Groq: sign up, confirm no card prompt, screenshot the Free limits table, switch on Zero Data Retention, read the terms for training and commercial use.
3. Do not enable AI Gateway logging or caching on Cloudflare.
