# `ody trigger --generate` — AI test-fixture generation — Design

> Status: approved design (2026-05-31). Implements wishlist item **#10 (AI-generated test
> fixtures)** from the competitor gap analysis — deferred out of the `ody` CLI design
> ([2026-05-31-ody-cli-design.md](2026-05-31-ody-cli-design.md)) and now picked up as its
> own feature. Builds directly on the CLI + public REST API shipped in PR #5 / PR #6.

## Context & goal

Odyhook is a self-hosted webhook router. The `ody` CLI (in `cli/`) already lets a developer
stream live events to localhost (`ody listen`) and push test payloads into a source
(`ody trigger <slug> --data @file.json | --replay <eventId>`).

Writing those test payloads by hand is the friction this feature removes. A developer
testing a Stripe or GitHub integration shouldn't have to hunt down a realistic
`payment_intent.succeeded` body — they should be able to describe what they want in plain
English and have a realistic fixture generated and delivered. This is wishlist **#10**, the
natural follow-on to the CLI's `trigger` command.

**Scope:** generate one realistic JSON fixture from a free-text description, grounded in the
source's real event history, then deliver it through the existing ingest path. Provider/event
taxonomies, multi-fixture batches, AI-suggested headers, and a saved fixture library are
explicitly **out of scope** (see "Out of scope").

## Foundation it builds on (already shipped)

- **BYOK Anthropic, server-side only.** Each user's Anthropic key is stored encrypted in the
  `UserApiKey` table and read via `anthropicFor(userId)` / `getUserApiKey(userId)` in
  [src/lib/anthropic.ts](../../../src/lib/anthropic.ts). The CLI holds only an `ody_` API
  token and has no Anthropic key — so **generation must happen server-side.**
- **AI grounding precedent.** `compileRule` in
  [src/lib/ai/rule-compiler.ts](../../../src/lib/ai/rule-compiler.ts) already grounds a Claude
  call in a handful of recent sample events and strips ```` ```json ```` code-fences from the
  response. This feature reuses that exact pattern.
- **API conventions.** `withApiAuth` in `src/lib/api/handler.ts` centralizes token auth,
  rate-limiting, and the 401/404/400/429 error mapping. `auth.userId` is available inside the
  handler. The `/api/v1/listen` route is the reference for the source-ownership check.
- **CLI send-path.** `ody trigger` in
  [cli/src/commands/trigger.ts](../../../cli/src/commands/trigger.ts) already POSTs a body to
  `/api/ingest/<slug>` with `--header` overlays via `buildTriggerRequest`. The generated
  fixture is delivered through that same path — no new send infra.

## Command

A new flag on the existing `trigger` command:

| Invocation | Behaviour |
|---|---|
| `ody trigger <slug> --generate "<description>"` | Ask the server to generate a realistic JSON fixture for `<description>`, print it, then POST it to the source's ingest URL. |
| `ody trigger <slug> --generate "<description>" --dry-run` | Generate and print the fixture only — do **not** send it. |
| `ody trigger <slug> --generate "<description>" --header K:V` | As above; `--header` flags overlay the ingest POST exactly as they do for `--data`. |

`--generate` is mutually exclusive with `--data` and `--replay` (the three are the input
modes of `trigger`; supplying more than one is a usage error).

## Server side — `POST /api/v1/fixtures`

A new endpoint generates the fixture. It **only generates** — it never ingests. Delivery is
the CLI's job, which keeps generation previewable (`--dry-run`) and idempotent, and reuses the
existing ingest path.

```
POST /api/v1/fixtures
  Request body:  { "source": "<slug>", "prompt": "<free-text description>" }
  Response 200:  { "body": "<generated JSON string>", "model": "<model id>", "groundedOn": <n> }
```

- Wrapped in `withApiAuth` (token auth + rate limit reused).
- Validates the JSON body with Zod: `source` and `prompt` are required non-empty strings.
- Verifies the authenticated user **owns** the requested source (`prisma.source.findFirst`
  on `{ slug, userId: auth.userId }`) — 404 if not found, mirroring `/api/v1/listen`.
- **Grounding:** fetches up to 5 of the source's most recent `Event` rows (`bodyRaw`,
  newest-first) and passes them — plus the source's `verifyStyle` hint
  (`stripe` / `github` / `generic-sha256` / none) — to Claude as context, so the generated
  fixture matches the shape the user actually receives. `groundedOn` reports how many sample
  events were used (0 when the source has no history, in which case Claude generates from
  provider knowledge alone).
- Calls `anthropicFor(auth.userId)` with `MODEL_DEFAULT` (Sonnet — fixture realism matters and
  the cost is the user's under BYOK).
- Extracts the text block, strips code-fences, and `JSON.parse`-validates it. The fence-strip
  + parse logic currently living inline in `rule-compiler.ts` is extracted into a shared
  `extractJsonText(raw: string): string` helper (new `src/lib/ai/json.ts`) and reused by both
  call sites — a small targeted cleanup to avoid a third copy.
- Returns the **stringified** JSON body (so the CLI can forward the exact bytes Claude
  produced, byte-for-byte, as the ingest payload).

### New module: fixture generator

`src/lib/ai/fixtures.ts` — `generateFixture(userId, prompt, sampleBodies, verifyStyle)`:
builds the grounded prompt, calls Claude, runs `extractJsonText` + `JSON.parse`, and returns
`{ body, model, groundedOn }`. Pure-ish and unit-testable with a mocked Anthropic client,
mirroring how `compileRule` is structured. The route handler is a thin wrapper: auth →
ownership → fetch samples → `generateFixture` → respond.

The system prompt instructs Claude to: output only a single JSON object (no prose, no
markdown), produce a realistic payload for the described event, ground field shapes in the
provided samples when present, and respect the provider hinted by `verifyStyle`.

## CLI side

`ody trigger <slug> --generate "<desc>" [--dry-run] [--header K:V]...`

1. Resolve host + token from config/env; error "run `ody login` first" if absent.
2. Reject combining `--generate` with `--data`/`--replay` (usage error, non-zero exit).
3. POST `{ source: slug, prompt: desc }` to `<host>/api/v1/fixtures` with the bearer token.
   - 401 → "token rejected; re-run `ody login`"; 404 → "source not found: <slug>";
     400 → print the server's message (covers "no Anthropic key" and "model returned invalid
     JSON"); 429 → respect `Retry-After`.
4. Print the generated fixture (always — transparency) along with a `groundedOn` note.
5. If `--dry-run`: stop here (exit 0).
6. Otherwise build the ingest POST via `buildTriggerRequest(cfg, slug, body, headers)` (the
   existing helper) and send it; print `HTTP <status> <response>`; non-2xx → non-zero exit.

A small `buildGenerateRequest(cfg, slug, prompt)` pure helper constructs the `/api/v1/fixtures`
request for unit-testing without network.

## Error handling

- **No Anthropic key configured** → `anthropicFor` throws `NoUserApiKeyError`; the route catches
  it and returns `400 validation_error` with the message "No Anthropic API key configured (set
  one in Settings → API Keys)." The CLI prints it and exits non-zero. (The error set in
  `src/lib/api/respond.ts` has no `server_error` code, so a 400 with a clear message is the
  right mapping for this user-actionable condition.)
- **Model returns non-JSON** → `extractJsonText` + `JSON.parse` throws; the route returns
  `400 validation_error` "the model did not return valid JSON — try rephrasing the description."
- **Unknown/unowned slug** → `404 not_found`.
- **Token rejected** → `401 unauthorized`. **Rate limited** → `429` with `Retry-After`.
- The generated fixture is delivered through the normal ingest path, so the source's own
  signature verification still applies. **Caveat:** if the source has `verifyStyle` set with a
  signing secret, a generated (unsigned) fixture will be rejected at ingest with the usual
  signature error — the same as a hand-written `--data` payload. Documented in the command help.

## Testing strategy

**Server (Vitest, mocked Anthropic):**
- `extractJsonText`: strips ```` ```json ```` / ```` ``` ```` fences, returns inner JSON, passes
  through already-bare JSON, leaves the string for `JSON.parse` to reject when malformed.
- `generateFixture`: builds a grounded prompt including the sample bodies, returns the parsed
  body + `groundedOn` count; throws on non-JSON model output; works with zero samples.
- `POST /api/v1/fixtures` route (mirrors `listen/route.test.ts`): 401 without a token, 404 for
  an unknown slug, 404 for another user's source, 400 when the user has no Anthropic key, 200 +
  `{ body, model, groundedOn }` for an owned source (with the Anthropic client mocked).

**CLI (Vitest, mocked `fetch`):**
- `buildGenerateRequest` targets `/api/v1/fixtures` with the bearer header and `{source,prompt}`.
- `--generate` happy path: posts to `/api/v1/fixtures`, then posts the returned body to
  `/api/ingest/<slug>`.
- `--dry-run`: prints the fixture and makes **no** ingest POST.
- `--generate` combined with `--data`/`--replay` → usage error, non-zero exit, no network.

## Build sequence

1. Extract `extractJsonText` into `src/lib/ai/json.ts`; refactor `rule-compiler.ts` to use it
   (no behaviour change; existing tests stay green).
2. `src/lib/ai/fixtures.ts` — `generateFixture` + unit tests (mocked Anthropic).
3. `POST /api/v1/fixtures` route + auth/ownership/no-key/success tests.
4. CLI: `--generate` / `--dry-run` flags on `trigger`, `buildGenerateRequest` helper, mutual
   exclusivity, + tests. Update the dispatcher usage text and `cli/README.md`.
5. Docs: `cli/README.md` "Generate test events" section; an `infra/README.md` note on the new
   `/api/v1/fixtures` endpoint.

## Out of scope (deferred to future plans)

- Provider/event-type flags (`--provider stripe --event payment_intent.succeeded`) — needs a
  maintained taxonomy.
- Generating multiple fixtures in one call.
- AI-suggested headers (e.g. `X-GitHub-Event`) returned alongside the body — v1 sends body only
  with `content-type: application/json` plus any manual `--header` overlays.
- A saved/named fixture library on disk.
- A separate `ody generate` subcommand that only prints — `--generate --dry-run` already covers
  the "print, don't send" use case.
