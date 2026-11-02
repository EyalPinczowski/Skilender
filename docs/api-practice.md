# Practice API (v1), without a model

Spec 3.3. Base path `/api/v1/plans/:planId`. Every route sits behind the Terms guard (403 `terms_not_accepted` until the current terms and privacy are accepted). The same rules as the other plan routes: a bearer token, the user is the token's `sub`, a `user_id` in a body is rejected (400), another user's plan, task or session answers 404 exactly like a missing one, and every error has the shape `{ "error": { "code", "message", "requestId" } }`. Text containing U+0000 answers 422. The live contract is `GET /api/v1/openapi.json`.

Sessions on the `external` and `self` channels need no model. The `in_app` channel (chat with a model, model feedback) is described under "In-app chat" below and needs an AI provider; with none, it answers 503 `ai_unavailable` and the other channels keep working.

| Method and path                         | What it does                                                                 | Success | Errors                  |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------- | ----------------------- |
| `GET /practice/context`                 | The saved job description                                                    | 200     | 404                     |
| `PUT /practice/context`                 | Save it (`""` clears), returns `redactionsPreview`                           | 200     | 400, 404, 422           |
| `GET /tasks/:taskId/practice/prompt`    | The ready-made prompt and what went into it. Saves nothing                   | 200     | 404, 422                |
| `POST /tasks/:taskId/practice/sessions` | Start a session `{ id, channel: in_app \| external \| self }`               | 201/200 | 400, 404, 409, 422, 503 |
| `GET /practice/sessions/:sessionId`     | Session, messages, feedback                                                  | 200     | 404                     |
| `POST /practice/sessions/:id/messages`  | One chat turn `{ id, content }` (in-app only)                                | 201/200 | 400, 404, 409, 422, 429, 503 |
| `POST /practice/sessions/:id/feedback`  | Paste feedback `{ text, markDone?, logHours? }` and finish                   | 201/200 | 400, 404, 409, 422      |
| `POST /practice/sessions/:id/finish`    | Finish with a rubric, an entered score or nothing `{ markDone, logHours?, rubric?, enteredScore?, aiFeedback? }` | 201/200 | 400, 404, 409, 422, 429, 503 |
| `POST /practice/sessions/:id/abandon`   | Give up: nothing logged, task untouched                                      | 200     | 404, 409                |
| `GET /practice/history?kind&from&to&limit` | Finished sessions, newest first, no text                                  | 200     | 400, 404                |
| `GET /practice/trends?from&to`          | Score points and `last`, `average`, `delta` per kind                         | 200     | 400, 404                |

## Rules

- **Done-marking.** A task is marked done only with `markDone: true`, and only through the tasks service (`completeTask`). Feedback of any kind never marks anything done on its own. `finish` requires `markDone` so the choice is always explicit; on the paste route it defaults to `false`. Logging hours also goes through the tasks service (`addLog`), which moves a `pending` task to `in_progress` as it does everywhere; the task is never closed by logging. A session is never moved from `finished` back to `active` (a database trigger enforces it); practising again means a new session. Marking a `skipped` task done answers 409 (reopen it first).
- **No cross-module SQL.** The practice SQL reads and writes only the four practice tables, the `events` table (its own `practice.*` events: writes go through the plans repository, and the practice repository reads back the `practice.finished` event of one session for replay checks) and the user's own name and email (to hide them from prompts). Facts about tasks (type, steps, estimate, status) and every change to them come from the tasks service, which offers transaction-scoped variants (`getTaskIn`, `addLogIn`, `completeTaskIn`) so a finish can use them inside its own transaction. The database still has the foreign key from a session to its task.
- **Job description (Tier 2).** Stored once per plan in `practice_contexts`. It is in the prompt returned by `GET .../practice/prompt` (for the user to copy) after personal details are removed, but **never** in a session's stored `prompt_used`, in an event or in a log line (`prompt_inputs.jobDescriptionIncluded` records only that it was used).
- **Personal details.** Prompts are built with the shared allowlist builder, with the user's email, its local part and name tokens as known identifiers. If something personal survives, the answer is 422 `pii_blocked`.

## In-app chat

Spec 3.3, channel `in_app`. Needs at least one configured AI provider (see the AI gateway); the whole project works with AI off.

- **Opener.** Creating an `in_app` session returns one fixed message (role `assistant`, no provider) built from the persona and the task's first step. No model is called; it counts as a call avoided. With no provider available the create answers 503 `ai_unavailable` and nothing is stored.
- **A turn: `POST .../messages { id, content }`** (`content` 1 to 4000 characters, `id` chosen by the client). The text is neutralised and has personal details removed (the user's own email, name tokens, phone numbers, links) **before it is stored**; `userMessage.redacted` says so. If something personal survives, 422 `pii_blocked` and nothing is sent or stored.
  1. **Transaction 1 (short, committed before any network call):** lock the session row, replay or conflict check on the message id, refuse a fresh pending turn (409 `turn_in_progress`), check a provider could answer, store the user message, **reserve one of the user's daily `practice_message` calls**, set `pending_turn_id` / `pending_since`.
  2. **No transaction open:** build the request with `buildSafeRequest` and the user's known identifiers (the system text is the persona plus the stored task setup; the fixed opener is folded into it so the transcript starts with the user), send the **whole earlier transcript** (cut to the smallest provider limit by `truncateHistory`, notes excluded), call the gateway with `userCap: 'already_reserved'`.
  3. **Transaction 2:** store a `note` (when the provider changed: "Continuing on {label}.") and the reply, record the provider in `providers_used`, clear the pending marker. After any failure the marker is cleared in its own transaction and the user message stays; a stale marker (older than 60 s, for example after a crash) is ignored and replaced by the next turn.
  - **Idempotency.** The same id with the same text after an answer returns the stored pair with 200 and `replayed: true`, with no model call and no new reserve. The same id with other text is 409. The same id after a failure retries the stored message (and counts again against the cap).
  - **Answer.** `{ userMessage, reply: { id, content, providerId, model }, switched: { from, fromLabel, to, toLabel, reason } | null, usage: { used, cap }, replayed }`. `model` and `providerId` are shown only if they look like a plain slug (letters, digits, `.`, `_`, `:`, `/`, `-`, at most 100 characters); otherwise `null`. Replies are plain text: render them as text, never as HTML or links.
  - **Errors.** 429 `ai_user_cap` (the user's daily calls; other users unaffected) and 503 `ai_unavailable` carry `fallbacks: ["copy_prompt", "self_rubric"]`; 429 `rate_limited` is the per-user window of 20 turns a minute (in memory, per API instance); 409 `turn_in_progress`; 422 for a non-`in_app` session. Provider error text never reaches a response or a log; only provider ids and codes do.
- **AI feedback: `POST .../finish { markDone, logHours?, aiFeedback: true }`** (not combinable with `rubric` or `enteredScore`; 5 a minute per user). The user must have said something. One `practice_feedback` call is reserved and the turn marked pending (so a message or a second finish meanwhile is 409), the model is asked for JSON, and then the normal one-transaction finish saves the result:
  - valid JSON: source `model_json`;
  - JSON that needed local repair (code fences, single quotes, `"7/10"`, `nextFocus`, trailing commas): source `model_repaired`, **no retry** (counted as a call avoided);
  - anything else: **one retry** ("Return only valid JSON ..."), reserved against the user's feedback calls and skipped at the cap; if that is still not JSON, or fails, the first text is saved as `free_text` with no score. Nothing is lost and the finish still succeeds.
  - If the first call fails (provider down, cap), the answer is 503 or 429 with `fallbacks`, the session stays active and can finish with a rubric, an entered score or pasted feedback.
  - **Done-marking is never automatic**: the task is marked done only with `markDone: true`. A repeated identical `finish` is a replay (200) with no model call.
- The pasted-feedback route also works on `in_app` sessions.

Decisions and limits:

- The stored prompt has no job description, so the chat does not see it either (a follow-up could rebuild it per turn).
- The per-user turn window is in memory (one instance on the free plan).
- **Merged turns.** A message that failed and was not retried stays stored, but only the newest of a run of user messages with no answer between them is sent to the model; older unanswered ones are dropped from the request, so the size stays bounded. The newest 60 turns are taken, the transcript starts with a user turn, and history is then cut to the smallest provider limit (a one-line "earlier turns omitted" note stays on the oldest kept turn).
- **Retrying an older id.** Retrying a failed message after a later message was sent is 409 `message_superseded` (the stored pair of a message is only ever its own reply).
- **Stale pending.** A turn is treated as dead after `max(60 s, 2 x AI_TURN_TIMEOUT_MS + 15 s)`. The reply (or AI feedback) is saved only if the session is still active and the turn still owns the marker; otherwise it is dropped and the call answers 409 `turn_superseded`. A plain finish or abandon during a turn therefore wins, and no late reply is appended.
- A retry that needed local repair is saved as `model_repaired`. An AI finish with `markDone` on a skipped task is 409 before any model call.

## Prompt

`GET /tasks/:taskId/practice/prompt` returns `{ persona, prompt, inputs, feedbackFormat }`. 422 when the task is not a practice. `inputs` says what was used, with no extra text:

- `nextFocus` / `nextFocusFrom`: the `next_focus` of the **newest finished session of the same kind in this plan that left a non-empty one**, and that session's id. Free-text feedback has no next focus, so it is skipped; an abandoned or active session never counts; another kind never contributes. A task without a `practiceKind` has the kind `general`.
- `topics`: titles of the **other** tasks the user logged time on in the last 7 plan-local days (today and the six before), newest first, at most 10. (Skill ids are not on tasks, so none are sent.)
- `jobDescriptionIncluded`, `redactions` (how many personal details were removed).

## Day briefing

`GET /plans/:planId/days/:date/briefing` stays deterministic and AI-free (no provider call, nothing stored, no event). For each `practice` task of **today** (plan-local date; past days are frozen and keep the stored template and no session id), the `promptTemplate` field now holds the same prompt as `GET .../practice/prompt` (persona, task setup, the last same-kind `next_focus`, recent topics), built by the practice service's `briefingEntry`. It is read-only: it shows what the user would copy, so the job description is included exactly as in the prompt route (after personal details are removed) and, as there, never stored or logged. `practiceSessionId` is set only while a session for that task is `active`. If building the prompt fails, that entry keeps the task's own template and has no `practiceSessionId`: an expected 404/422 (for example `pii_blocked`) silently, anything else with a warning log of the error class and code only (never the message). Plans without practice tasks are unchanged.

## Sessions

- **Create.** Idempotent on the client's `id`: the same id with the same task and channel answers 200 with the stored session; the same id for anything else is 409. A second **active** session on a task is 409 with code `practice_session_active` and the existing id in the message. Two simultaneous starts are serialised by the plan row lock, so exactly one wins. Writes `practice.started`. `planned_minutes` is the task estimate in minutes. The stored prompt is the one **without** the job description.
- **Abandon.** Takes the session row lock, so it and a finish on the same session run one after the other: the first wins and the other answers 409 and changes nothing. Active to `abandoned`, `ended_at` set, nothing else changes (no log, task untouched), no event. Repeating it is 200. A finished session is 409.

## Finishing: order and idempotency

A session finishes **exactly once**, through whichever of `feedback` or `finish` comes first.

1. **Feedback source, decided explicitly.** Pasted feedback and a self-check never combine: `POST .../feedback` finishes the session with the pasted result (`pasted_block`, or `free_text` for text that is not a block) and carries no rubric. `POST .../finish` takes **at most one** of `rubric` (source `self_rubric`, score `10 x ticked / total` from the task's steps, or four generic steps when it has none) or `enteredScore` (a score out of `max`, normalised to 0 to 10, source `self_rubric`), or neither (no feedback row, the session still finishes, for example to log time). Sending both is 400. A `finish` after a paste is a replay (below), not a way to add a rubric.
2. **One transaction.** The whole finish runs in one transaction: lock the session row and confirm it is still active; then, through the tasks service in the same transaction, the hours log (one log per session, with an id derived from the session id) and, only with `markDone`, `completeTask`; then the feedback, the session `finished` and the `practice.finished` event. Any failure, including a 409, rolls everything back: no log, no status change, no event. So a failed finish can be retried with different options, and a racing abandon or second finish leaves nothing behind when it loses. The log is dated the plan-local day the session **started**.
3. **Replay.** A call on an already finished session answers **200** with `replayed: true` and applies nothing, if the feedback matches what was stored (pasted: the same text; rubric or score: the same result; `finish` with no feedback matches any stored feedback) **and** `markDone` and `logHours` equal what the first call used (they are kept, as numbers and booleans only, in the `practice.finished` event, read back by the practice repository). Anything else is 409 and changes nothing. Two simultaneous identical calls give one 201 and one 200, one log and one event; two with different `markDone` give one 201 and one 409, and the task matches the one that won. A call on an abandoned session is 409.
4. **Free text.** Text without a readable `===FEEDBACK===` block is saved as `free_text` (score null, `raw` holds the text) with a normal 201 and `parsed: false`. A pasted block that parses has `parsed: true`.

## Events (never any text)

- `practice.started { sessionId, taskId, kind, channel }`
- `practice.finished { sessionId, taskId, kind, source | null, score | null, minutes, markedDone, loggedHours | null }`

`kind` is the task's practice kind. Feedback text, the job description and transcripts are never in an event. The existing `task.logged` / `task.completed` events are written by the tasks service as usual.

## History and trends

- History lists **finished** sessions only: `{ id, taskId, kind, channel, startedAt, minutes, score | null, source | null }`, newest first. `from` and `to` are plan-local dates of the day the session started. `limit` defaults to 50, at most 200.
- Trends use scored finished sessions (free text and no-feedback sessions have no score), the newest 1000 in the range, oldest first. `points` carry the plan-local date, the score and the source so the client can tell a self-check from a pasted score; `last`, `average` and `delta` come from `trendsByKind` in the shared package.

## Notes

- The replay check finds the `practice.finished` event by `payload ->> 'sessionId'` within the plan's events. An index on that would need a migration, so none is added; the plan's events are few and already indexed by user and plan.
- A unique-index violation for a second active session is mapped to 409 `practice_session_active` as a backstop to the plan lock.

## Data

Tables `practice_contexts`, `practice_sessions`, `practice_messages`, `practice_feedback` (migration 0009) are covered by the account export and by account deletion (checked by `accounts.test.ts`), and by the row-level-security tests in `packages/db`.

## Not tested here / follow-ups

- The chat is tested with the fake provider only (no real provider has been called). The real providers' behaviour on a mid-conversation 429, their token limits and response times are "needs check" until the owner's first real call on R&D.
- Cancelling a request (the client going away) is not wired from the route to the gateway; the turn finishes and is stored.
