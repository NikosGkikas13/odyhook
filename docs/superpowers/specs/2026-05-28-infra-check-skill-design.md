# Infra-Check Skill — Design

**Date:** 2026-05-28
**Status:** Approved, pending implementation plan

## Problem

Infra docs and config files drift out of sync with the code. Env vars get added in
code but never land in `.env.example`; version pins in infra docs go stale; renames
leave dead references behind; new routes/models/services and architecture-shaping
features never get documented. This is invisible until someone follows a stale doc and
breaks something.

We want a **global** skill that runs on **every `git push`**, detects likely infra
staleness introduced by the commits being pushed, and gives the user a chance to fix
the docs before the push lands.

## Goals

- Catch infra/doc drift at push time, across all repos on the machine.
- Block a push when docs are actively wrong or incomplete, with a clean escape hatch.
- Keep the shell layer dumb; let Claude do the judgment.
- Never wedge the user's ability to push (fail-open on any error).

## Non-goals

- Not a linter or test runner — purely about doc/config ↔ code consistency.
- Not auto-committing fixes silently. Any edit goes through an interactive Claude session the user drives.
- Not a server-side / CI check. This is a local pre-push hook only.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Trigger point | Local git `pre-push` hook |
| Infra-file detection | Built-in heuristic glob patterns (zero-config) |
| Action when stale found | Block, then offer to update interactively |
| Check scope | env-drift, version-drift, dead-reference, structural-drift, architecture-change |
| Install scope | Per-repo install command (explicit, no surprises) |
| Pre-filter | Always invoke Claude (no diff pre-filtering) |
| Malformed/failed analysis | Fail **open** (warn, exit 0) |
| Blocking threshold | Block on `high`+`medium`; `low` is FYI only |

## Architecture

### Layout

```
~/.claude/skills/infra-check/
├── SKILL.md          # instructions Claude follows when the hook calls it
├── pre-push.sh       # hook script template (symlinked into repos at install time)
└── install.sh        # one-liner installer, run inside any repo

<repo>/.git/hooks/pre-push   # symlink → ~/.claude/skills/infra-check/pre-push.sh
```

- Global skill under `~/.claude/skills/` (not a plugin skill — independent of marketplace versioning).
- Symlink so skill updates propagate to all installed repos for free; install falls back to a copy where symlinks aren't possible.

### Data flow (on `git push`)

1. `pre-push` receives `<local-ref> <local-sha> <remote-ref> <remote-sha>` lines on stdin.
2. Compute push range `<remote-sha>..<local-sha>`. New branch → diff against merge-base with the remote default branch.
3. Match the built-in infra glob against the repo. If nothing matches → exit 0 (nothing to keep in sync), no Claude call.
4. Collect context bundle:
   - `git diff --name-status <range>`
   - `git diff <range>` (capped — see Caps)
   - full contents of matched infra files
5. Invoke `claude -p "<prompt referencing infra-check skill>"` with the bundle on stdin, `--output-format json`.
6. Parse the JSON report (schema below):
   - `stale: []` or only `low` findings → print any FYI, exit 0 (push proceeds).
   - any `high`/`medium` finding → print summary to `/dev/tty`, go to 7.
7. Prompt on `/dev/tty`: `[u]pdate now / [a]bort`.
   - `u` → `exec claude` (interactive) pre-loaded with the report; user fixes docs, re-runs `git push`. Push stays blocked until then.
   - `a` → exit 1 (push blocked). User may bypass with `git push --no-verify`.

`git push --no-verify` skips the hook entirely — no special handling needed.

### Report contract (JSON)

Claude's final output is exactly one JSON object:

```json
{
  "stale": [
    {
      "file": ".env.example",
      "category": "env-drift",
      "severity": "high",
      "finding": "Code reads process.env.RATE_LIMIT_PER_SEC (src/lib/ratelimit.ts:83) but .env.example doesn't list it.",
      "suggestion": "Add RATE_LIMIT_PER_SEC and RATE_LIMIT_BURST with defaults + comment."
    }
  ],
  "summary": "1 high finding: .env.example missing rate-limit vars introduced in this push."
}
```

- `category` ∈ `env-drift | version-drift | dead-reference | structural-drift | architecture-change`
- `severity` ∈ `high | medium | low`
- The hook only reads `stale` (block decision) and `summary` (print). The rest feeds the interactive fix session.
- Malformed JSON or non-zero `claude` exit → fail open: print a one-line warning, exit 0.

### Checks

| Category | What Claude looks for |
|---|---|
| `env-drift` | `process.env.X` reads in changed code with no matching `.env.example` entry (and vice-versa); infra docs naming env vars that don't match reality |
| `version-drift` | Version pins in infra docs that no longer match `package.json`; new deps not mentioned where the stack is documented |
| `dead-reference` | Infra docs referencing files, npm scripts, commands, paths, or old product names/domains removed or renamed in this push |
| `structural-drift` | New `src/app/api/**` routes, new `prisma/schema.prisma` models, or new `docker-compose.*` services not reflected in ARCHITECTURE/infra docs |
| `architecture-change` | A new feature in this push that materially shapes the system's architecture and should be documented for future reference |

**Severity guidance** (so Claude is consistent):
- `high` = doc actively wrong/misleading; following it breaks something.
- `medium` = doc incomplete; missing a real thing that exists.
- `low` = cosmetic / stale-but-harmless.

**Blocking threshold:** block on any `high` or `medium`; `low`-only findings print as FYI and the push proceeds.

### Caps & edge cases

- **Diff cap:** ~2,000 lines / ~200 KB. If exceeded, send `--name-status` + infra file contents only and tell Claude the diff was truncated.
- **Infra glob (built-in):** `Dockerfile*`, `docker-compose*.y*ml`, `*.tf`, `*.tfvars`, `k8s/**`, `helm/**`, `infra/**`, `.github/workflows/**`, `Caddyfile`, `*.nginx`, `nginx.conf`, `.env.example`, `*.env.example`, `ARCHITECTURE.md`, `DEPLOY.md`, root `README.md`.
- Branch deletion / zero commits → exit 0.
- New branch, no remote counterpart → diff against merge-base with the default branch.
- `claude` not on PATH → warn, exit 0.
- Non-TTY context (CI, scripted push) → skip the prompt, print findings, exit 0 (don't wedge automation).

### Install command (`install.sh`, run from a repo root)

- Verify inside a git repo.
- If `.git/hooks/pre-push` exists and isn't ours → refuse, tell user to back it up first (never clobber an existing hook).
- Otherwise symlink `~/.claude/skills/infra-check/pre-push.sh` → `.git/hooks/pre-push`, `chmod +x`.
- Print confirmation, how to uninstall (`rm .git/hooks/pre-push`), and how to bypass (`--no-verify`).

## Testing

- Unit-ish shell tests for `pre-push.sh`: range computation, glob matching (no infra → exit 0), JSON parsing (empty / low-only / high / malformed → correct exit codes), non-TTY skip.
- `install.sh`: refuses to clobber, creates symlink, idempotent re-install.
- Manual end-to-end in this repo: introduce a known drift (e.g. remove a var from `.env.example`), push, confirm it blocks and the fix session opens; confirm `--no-verify` bypasses.

## Open risks

- Token cost on every push is accepted (explicit decision). Large diffs mitigated by the cap.
- Skill-prompt consistency: Claude must reliably emit the JSON contract. Mitigated by fail-open and a strict schema in SKILL.md.
