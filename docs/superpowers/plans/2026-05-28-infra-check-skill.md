# Infra-Check Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global skill + per-repo git pre-push hook that detects when infra docs/config have drifted from code in the commits being pushed, and lets the user fix them before the push lands.

**Architecture:** A thin bash `pre-push.sh` hook gathers structured push context (diff, infra files, repo metadata) and hands it to `claude -p`, which returns a strict JSON report. The hook parses the report, blocks on high/medium findings, and on "update" opens an interactive Claude session to fix the docs. The skill (`SKILL.md`) is the human-readable / manually-invocable counterpart. An `install.sh` symlinks the hook into any repo.

**Tech Stack:** bash (must be 3.2-compatible — macOS default), `python3` (JSON parse, fail-open if absent), `git`, `claude` CLI. No jq dependency.

---

## Environment notes (read before starting)

- **macOS ships bash 3.2.** No associative arrays, no `${var,,}`, no `mapfile`. Use `case` for case-insensitive matches, `<<<` here-strings and `[[ ]]` are fine.
- The skill lives at `~/.claude/skills/infra-check/` which is **not** under the hooksmith repo. Task 1 runs `git init` there so each task can commit and we get version history for the skill. The design spec + this plan live in the hooksmith repo and are already committed separately.
- `claude` is at `~/.local/bin/claude`; `python3` at `/usr/bin/python3`. Both confirmed present.
- The hook fails **open**: any missing tool, errored analysis, or malformed report → warn and allow the push.

## File structure

```
~/.claude/skills/infra-check/
├── SKILL.md            # human-readable skill: checks, severity, JSON contract, manual usage
├── pre-push.sh         # the hook (single self-contained file; all functions + guarded main)
├── install.sh          # installs the hook into the current repo (symlink, refuses to clobber)
└── tests/
    ├── helpers.sh      # assert_eq / assert_contains / run-in-temp-repo helpers
    ├── run.sh          # runs every test_*.sh, reports pass/fail
    ├── test_evaluate_report.sh
    ├── test_compute_range.sh
    ├── test_match_infra_files.sh
    ├── test_collect_context.sh
    ├── test_run_analysis.sh
    ├── test_main_flow.sh
    └── test_install.sh
```

**`pre-push.sh` is one file** (not split into a `lib.sh`) to avoid symlink path-resolution pain: git invokes `.git/hooks/pre-push` (a symlink), and resolving a sibling file from a symlinked script is fragile across BSD/GNU `readlink`. Tests source `pre-push.sh` with `INFRA_CHECK_LIB_ONLY=1` set so the guarded `main` does not run, then call individual functions.

**Function contract (locked — keep names/signatures identical across tasks):**

| Function | Signature | Returns |
|---|---|---|
| `compute_range` | `compute_range <local_sha> <remote_sha>` | echoes `SKIP`, or `<base>..<tip>` |
| `list_infra_globs` | `list_infra_globs` | echoes patterns, one per line |
| `match_infra_files` | `match_infra_files` (cwd = repo) | echoes matched tracked paths, sorted unique |
| `collect_context` | `collect_context <range>` | echoes the context bundle (text) |
| `analysis_prompt` | `analysis_prompt` | echoes the prompt string for `claude -p` |
| `run_analysis` | `run_analysis <context>` | echoes raw claude output; returns 127 if claude unavailable |
| `evaluate_report` | `evaluate_report` (JSON on stdin) | line 1 = `PROCEED\|FYI\|BLOCK\|ERROR`, rest = summary/findings |
| `main` | `main` (ref lines on stdin) | exit 0 = allow, exit 1 = block |

**Constants (defined once at top of `pre-push.sh`):**

```bash
ZERO_SHA="0000000000000000000000000000000000000000"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DIFF_LINE_CAP=2000
DIFF_BYTE_CAP=204800
```

---

### Task 1: Scaffold skill dir, git repo, and test harness

**Files:**
- Create: `~/.claude/skills/infra-check/tests/helpers.sh`
- Create: `~/.claude/skills/infra-check/tests/run.sh`
- Create: `~/.claude/skills/infra-check/pre-push.sh` (skeleton only)
- Create: `~/.claude/skills/infra-check/tests/test_smoke.sh`

- [ ] **Step 1: Create the directory and init git**

```bash
mkdir -p ~/.claude/skills/infra-check/tests
cd ~/.claude/skills/infra-check
git init -q
```

- [ ] **Step 2: Write the test helpers**

Create `~/.claude/skills/infra-check/tests/helpers.sh`:

```bash
#!/usr/bin/env bash
# Shared test helpers. bash 3.2 compatible.

TESTS_RUN=0
TESTS_FAILED=0

assert_eq() {
  # assert_eq <actual> <expected> <message>
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$1" != "$2" ]]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "  FAIL: $3"
    echo "    expected: [$2]"
    echo "    actual:   [$1]"
  fi
}

assert_contains() {
  # assert_contains <haystack> <needle> <message>
  TESTS_RUN=$((TESTS_RUN + 1))
  case "$1" in
    *"$2"*) : ;;
    *)
      TESTS_FAILED=$((TESTS_FAILED + 1))
      echo "  FAIL: $3"
      echo "    expected to contain: [$2]"
      echo "    in:                  [$1]"
      ;;
  esac
}

# Create a throwaway git repo, cd into it, echo its path.
make_temp_repo() {
  local d
  d=$(mktemp -d)
  cd "$d" || return 1
  git init -q
  git config user.email "t@t.t"
  git config user.name "t"
  echo "$d"
}

# Path to pre-push.sh under test.
SCRIPT_UNDER_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pre-push.sh"

# Source pre-push.sh as a library (guarded main will NOT run).
load_script() {
  INFRA_CHECK_LIB_ONLY=1 source "$SCRIPT_UNDER_TEST"
}
```

- [ ] **Step 3: Write the test runner**

Create `~/.claude/skills/infra-check/tests/run.sh`:

```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
total=0
failed=0
for t in test_*.sh; do
  [[ -e "$t" ]] || continue
  echo "== $t =="
  # Each test file runs in its own subshell and prints a final line: "RESULT <run> <failed>"
  out=$(bash "$t")
  echo "$out"
  line=$(printf '%s\n' "$out" | grep '^RESULT ' | tail -1)
  r=$(echo "$line" | awk '{print $2}')
  f=$(echo "$line" | awk '{print $3}')
  total=$((total + ${r:-0}))
  failed=$((failed + ${f:-0}))
done
echo "================"
echo "TOTAL: $total run, $failed failed"
[[ "$failed" -eq 0 ]]
```

- [ ] **Step 4: Write the pre-push.sh skeleton with the guard**

Create `~/.claude/skills/infra-check/pre-push.sh`:

```bash
#!/usr/bin/env bash
# infra-check pre-push hook. bash 3.2 compatible. Fails OPEN on any error.
set -u

ZERO_SHA="0000000000000000000000000000000000000000"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DIFF_LINE_CAP=2000
DIFF_BYTE_CAP=204800

# --- functions added in later tasks go here ---

main() {
  exit 0
}

# Guard: when sourced by tests with INFRA_CHECK_LIB_ONLY=1, do not run main.
if [[ -z "${INFRA_CHECK_LIB_ONLY:-}" ]]; then
  main "$@"
fi
```

- [ ] **Step 5: Write a smoke test**

Create `~/.claude/skills/infra-check/tests/test_smoke.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
load_script
assert_eq "$ZERO_SHA" "0000000000000000000000000000000000000000" "ZERO_SHA constant loads"
assert_eq "$DIFF_LINE_CAP" "2000" "DIFF_LINE_CAP constant loads"
echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 6: Run the harness — verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/run.sh`
Expected: ends with `TOTAL: 2 run, 0 failed` and exit code 0.

- [ ] **Step 7: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "scaffold infra-check skill dir + test harness"
```

---

### Task 2: `evaluate_report` — JSON report → decision (pure)

**Files:**
- Modify: `~/.claude/skills/infra-check/pre-push.sh` (add `evaluate_report`)
- Create: `~/.claude/skills/infra-check/tests/test_evaluate_report.sh`

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_evaluate_report.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
load_script

empty='{"stale": [], "summary": "all good"}'
out=$(printf '%s' "$empty" | evaluate_report)
assert_eq "$(printf '%s\n' "$out" | head -1)" "PROCEED" "empty stale -> PROCEED"

low='{"stale":[{"file":"README.md","category":"dead-reference","severity":"low","finding":"f","suggestion":"s"}],"summary":"1 low"}'
out=$(printf '%s' "$low" | evaluate_report)
assert_eq "$(printf '%s\n' "$out" | head -1)" "FYI" "low-only -> FYI"

high='{"stale":[{"file":".env.example","category":"env-drift","severity":"high","finding":"missing X","suggestion":"add X"}],"summary":"1 high"}'
out=$(printf '%s' "$high" | evaluate_report)
assert_eq "$(printf '%s\n' "$out" | head -1)" "BLOCK" "high -> BLOCK"
assert_contains "$out" "missing X" "BLOCK body includes finding"

med='{"stale":[{"file":"infra/README.md","category":"version-drift","severity":"medium","finding":"stale pin","suggestion":"bump"}],"summary":"1 medium"}'
out=$(printf '%s' "$med" | evaluate_report)
assert_eq "$(printf '%s\n' "$out" | head -1)" "BLOCK" "medium -> BLOCK"

# JSON embedded in prose / fences must still parse (extract first { .. last }).
fenced='Here is the report:
```json
{"stale": [], "summary": "ok"}
```
done'
out=$(printf '%s' "$fenced" | evaluate_report)
assert_eq "$(printf '%s\n' "$out" | head -1)" "PROCEED" "fenced JSON extracted"

bad='not json at all'
out=$(printf '%s' "$bad" | evaluate_report)
assert_eq "$(printf '%s\n' "$out" | head -1)" "ERROR" "malformed -> ERROR (fail open)"

echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_evaluate_report.sh`
Expected: FAILs (function `evaluate_report` not defined → empty output, assertions fail).

- [ ] **Step 3: Implement `evaluate_report`**

In `pre-push.sh`, replace the `# --- functions added in later tasks go here ---` line with:

```bash
evaluate_report() {
  # Reads claude output (JSON, possibly wrapped in prose) on stdin.
  # Prints: line 1 = PROCEED|FYI|BLOCK|ERROR ; remaining lines = summary/findings.
  python3 - <<'PY'
import sys, json
raw = sys.stdin.read()
s, e = raw.find('{'), raw.rfind('}')
if s == -1 or e == -1 or e < s:
    print("ERROR"); print("no JSON object found"); sys.exit(0)
try:
    data = json.loads(raw[s:e+1])
except Exception as ex:
    print("ERROR"); print(str(ex)); sys.exit(0)
stale = data.get("stale", [])
summary = data.get("summary", "")
if not isinstance(stale, list):
    print("ERROR"); print("'stale' is not a list"); sys.exit(0)
sev = {(x.get("severity") or "low") for x in stale if isinstance(x, dict)}
if not stale:
    print("PROCEED"); sys.exit(0)
if sev & {"high", "medium"}:
    print("BLOCK")
    if summary: print(summary)
    for x in stale:
        if isinstance(x, dict):
            print("  [%s] %s: %s" % (x.get("severity"), x.get("file"), x.get("finding")))
else:
    print("FYI")
    if summary: print(summary)
PY
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_evaluate_report.sh`
Expected: `RESULT 7 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "feat: evaluate_report parses JSON report into push decision"
```

---

### Task 3: `compute_range` + range constants

**Files:**
- Modify: `~/.claude/skills/infra-check/pre-push.sh` (add `compute_range`, `default_remote_ref`)
- Create: `~/.claude/skills/infra-check/tests/test_compute_range.sh`

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_compute_range.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
load_script

# Branch deletion: local sha all zeros -> SKIP
out=$(compute_range "$ZERO_SHA" "abc123")
assert_eq "$out" "SKIP" "deletion -> SKIP"

# Normal update: existing remote sha -> range
out=$(compute_range "newsha" "oldsha")
assert_eq "$out" "oldsha..newsha" "normal update -> range"

# New branch in a real temp repo: remote sha all zeros -> base..tip,
# where base is the empty tree (no remote to merge-base against).
repo=$(make_temp_repo)
echo "hello" > a.txt
git add a.txt; git commit -qm "first"
tip=$(git rev-parse HEAD)
out=$(compute_range "$tip" "$ZERO_SHA")
assert_eq "$out" "${EMPTY_TREE}..${tip}" "new branch, no remote -> empty-tree..tip"
cd /; rm -rf "$repo"

echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_compute_range.sh`
Expected: FAIL (function not defined).

- [ ] **Step 3: Implement `compute_range` and `default_remote_ref`**

Add to `pre-push.sh` (below `evaluate_report`):

```bash
default_remote_ref() {
  # Best-effort: origin/HEAD -> origin/main -> origin/master. Empty if none.
  local r
  for r in "origin/HEAD" "origin/main" "origin/master"; do
    if git rev-parse --verify --quiet "$r" >/dev/null 2>&1; then
      echo "$r"; return 0
    fi
  done
  echo ""
}

compute_range() {
  # compute_range <local_sha> <remote_sha> -> "SKIP" or "<base>..<tip>"
  local local_sha="$1" remote_sha="$2"
  if [[ "$local_sha" == "$ZERO_SHA" ]]; then
    echo "SKIP"; return 0
  fi
  if [[ "$remote_sha" == "$ZERO_SHA" ]]; then
    local def base
    def=$(default_remote_ref)
    if [[ -n "$def" ]]; then
      base=$(git merge-base "$local_sha" "$def" 2>/dev/null) || base=""
    fi
    [[ -z "${base:-}" ]] && base="$EMPTY_TREE"
    echo "${base}..${local_sha}"; return 0
  fi
  echo "${remote_sha}..${local_sha}"
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_compute_range.sh`
Expected: `RESULT 3 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "feat: compute_range resolves push range incl. new-branch + deletion"
```

---

### Task 4: `match_infra_files` + `list_infra_globs`

**Files:**
- Modify: `~/.claude/skills/infra-check/pre-push.sh`
- Create: `~/.claude/skills/infra-check/tests/test_match_infra_files.sh`

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_match_infra_files.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
load_script

# Repo with several infra + non-infra files.
repo=$(make_temp_repo)
mkdir -p infra .github/workflows k8s src
echo x > Dockerfile
echo x > docker-compose.prod.yml
echo x > Caddyfile
echo x > .env.example
echo x > ARCHITECTURE.md
echo x > README.md
echo x > infra/notes.md
echo x > .github/workflows/deploy.yml
echo x > k8s/deploy.yaml
echo x > main.tf
echo x > src/index.ts          # NOT infra
echo x > docs/README.md 2>/dev/null || { mkdir -p docs; echo x > docs/README.md; }  # nested README NOT matched
git add -A; git commit -qm "files"

out=$(match_infra_files)
assert_contains "$out" "Dockerfile" "matches Dockerfile"
assert_contains "$out" "docker-compose.prod.yml" "matches compose"
assert_contains "$out" "Caddyfile" "matches Caddyfile"
assert_contains "$out" ".env.example" "matches .env.example"
assert_contains "$out" "ARCHITECTURE.md" "matches ARCHITECTURE.md"
assert_contains "$out" "README.md" "matches root README.md"
assert_contains "$out" "infra/notes.md" "matches infra/**"
assert_contains "$out" ".github/workflows/deploy.yml" "matches workflows/**"
assert_contains "$out" "k8s/deploy.yaml" "matches k8s/**"
assert_contains "$out" "main.tf" "matches *.tf"

# negatives
case "$out" in *"src/index.ts"*) echo "  FAIL: src/index.ts should not match"; TESTS_FAILED=$((TESTS_FAILED+1));; esac
TESTS_RUN=$((TESTS_RUN+1))
case "$out" in *"docs/README.md"*) echo "  FAIL: nested README should not match"; TESTS_FAILED=$((TESTS_FAILED+1));; esac
TESTS_RUN=$((TESTS_RUN+1))

cd /; rm -rf "$repo"

# Repo with NO infra files -> empty output.
repo2=$(make_temp_repo)
echo x > app.js; git add -A; git commit -qm "x"
out=$(match_infra_files)
assert_eq "$out" "" "no infra files -> empty"
cd /; rm -rf "$repo2"

echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_match_infra_files.sh`
Expected: FAIL (function not defined).

- [ ] **Step 3: Implement the matchers**

Add to `pre-push.sh`:

```bash
list_infra_globs() {
  cat <<'EOF'
Dockerfile*
docker-compose*.yml
docker-compose*.yaml
*.tf
*.tfvars
Caddyfile
*.nginx
nginx.conf
.env.example
*.env.example
ARCHITECTURE.md
DEPLOY.md
EOF
}

match_infra_files() {
  # Echoes matched tracked paths (sorted, unique). cwd must be a git repo.
  local f b
  git ls-files | while IFS= read -r f; do
    b="${f##*/}"
    # Directory-prefix matches.
    case "$f" in
      infra/*|.github/workflows/*|k8s/*|helm/*) echo "$f"; continue ;;
    esac
    # Root README.md only (exact, no slash).
    if [[ "$f" == "README.md" ]]; then echo "$f"; continue; fi
    # Basename glob matches.
    case "$b" in
      Dockerfile*|docker-compose*.yml|docker-compose*.yaml|*.tf|*.tfvars|Caddyfile|*.nginx|nginx.conf|.env.example|*.env.example|ARCHITECTURE.md|DEPLOY.md)
        echo "$f"; continue ;;
    esac
  done | sort -u
}
```

Note: `list_infra_globs` is the documented reference list; `match_infra_files` implements the same set via `case` (faster, no per-file glob loop). They must stay in sync — the test above is the guard.

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_match_infra_files.sh`
Expected: `RESULT 14 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "feat: match_infra_files detects infra paths via built-in heuristics"
```

---

### Task 5: `collect_context` with diff cap

**Files:**
- Modify: `~/.claude/skills/infra-check/pre-push.sh`
- Create: `~/.claude/skills/infra-check/tests/test_collect_context.sh`

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_collect_context.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
load_script

repo=$(make_temp_repo)
echo "VERSION=1" > .env.example
git add -A; git commit -qm "base"
base=$(git rev-parse HEAD)
printf 'VERSION=1\nNEW_VAR=2\n' > .env.example
echo "console.log(process.env.NEW_VAR)" > app.js
git add -A; git commit -qm "add var"
tip=$(git rev-parse HEAD)
range="${base}..${tip}"

out=$(collect_context "$range")
assert_contains "$out" "=== CHANGED FILES ===" "has changed-files section"
assert_contains "$out" ".env.example" "lists changed infra file"
assert_contains "$out" "=== INFRA FILES PRESENT ===" "has infra-present section"
assert_contains "$out" "=== INFRA FILE CONTENTS ===" "has infra-contents section"
assert_contains "$out" "NEW_VAR" "includes infra file body"
assert_contains "$out" "=== DIFF ===" "has diff section"
assert_contains "$out" "app.js" "diff mentions changed code file"
cd /; rm -rf "$repo"

# Large diff -> truncated marker, no full diff body.
repo2=$(make_temp_repo)
echo "x" > Dockerfile; git add -A; git commit -qm "base"
base2=$(git rev-parse HEAD)
# Generate >2000 changed lines.
python3 -c "print('\n'.join('line %d'%i for i in range(5000)))" > big.txt
git add -A; git commit -qm "big"
tip2=$(git rev-parse HEAD)
out=$(collect_context "${base2}..${tip2}")
assert_contains "$out" "diff truncated" "large diff is truncated"
cd /; rm -rf "$repo2"

echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_collect_context.sh`
Expected: FAIL (function not defined).

- [ ] **Step 3: Implement `collect_context`**

Add to `pre-push.sh`:

```bash
collect_context() {
  # collect_context <range> -> structured text bundle on stdout.
  local range="$1"
  local infra diff lines bytes

  echo "=== CHANGED FILES ==="
  git diff --name-status "$range" 2>/dev/null
  echo ""

  infra=$(match_infra_files)
  echo "=== INFRA FILES PRESENT ==="
  echo "$infra"
  echo ""

  echo "=== INFRA FILE CONTENTS ==="
  if [[ -n "$infra" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      echo "--- $f ---"
      cat "$f" 2>/dev/null
      echo ""
    done <<< "$infra"
  fi

  echo "=== DIFF ==="
  diff=$(git diff "$range" 2>/dev/null)
  lines=$(printf '%s\n' "$diff" | wc -l | tr -d ' ')
  bytes=${#diff}
  if [[ "$lines" -gt "$DIFF_LINE_CAP" || "$bytes" -gt "$DIFF_BYTE_CAP" ]]; then
    echo "[diff truncated: ${lines} lines / ${bytes} bytes exceeds cap; judge from CHANGED FILES above]"
  else
    printf '%s\n' "$diff"
  fi
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_collect_context.sh`
Expected: `RESULT 9 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "feat: collect_context bundles diff + infra files with size cap"
```

---

### Task 6: `analysis_prompt` + `run_analysis` (mockable claude)

**Files:**
- Modify: `~/.claude/skills/infra-check/pre-push.sh`
- Create: `~/.claude/skills/infra-check/tests/test_run_analysis.sh`

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_run_analysis.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
load_script

# analysis_prompt mentions the contract essentials.
p=$(analysis_prompt)
assert_contains "$p" "JSON" "prompt mentions JSON output"
assert_contains "$p" "stale" "prompt mentions stale array"
assert_contains "$p" "severity" "prompt mentions severity"

# Mock claude that echoes canned JSON regardless of args/stdin.
tmpd=$(mktemp -d)
cat > "$tmpd/fake-claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null   # drain stdin
echo '{"stale": [], "summary": "ok"}'
EOF
chmod +x "$tmpd/fake-claude"

out=$(INFRA_CHECK_CLAUDE="$tmpd/fake-claude" run_analysis "some context")
assert_contains "$out" '"stale"' "run_analysis returns claude output"

# Missing claude -> return code 127.
INFRA_CHECK_CLAUDE="$tmpd/does-not-exist" run_analysis "x" >/dev/null 2>&1
assert_eq "$?" "127" "missing claude -> 127"

rm -rf "$tmpd"
echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_run_analysis.sh`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement `analysis_prompt` and `run_analysis`**

Add to `pre-push.sh`:

```bash
analysis_prompt() {
  cat <<'EOF'
You are the infra-check pre-push reviewer. Use the infra-check skill's guidance.
The push context (changed files, infra files + contents, diff) is on stdin.

Detect infra/doc drift introduced by THIS push, in these categories:
- env-drift: code reads process.env.X with no matching .env.example entry (or vice-versa); docs naming env vars that no longer match reality.
- version-drift: version pins in infra docs that no longer match package.json; new deps not mentioned where the stack is documented.
- dead-reference: docs referencing files, scripts, commands, paths, or old product names/domains removed or renamed in this push.
- structural-drift: new API routes, DB models, or compose services not reflected in ARCHITECTURE/infra docs.
- architecture-change: a new feature in this push that materially shapes the system's architecture and should be documented.

Severity: high = doc actively wrong/misleading (following it breaks something);
medium = doc incomplete (missing a real thing that exists);
low = cosmetic / stale-but-harmless.

Only report drift caused or revealed by THIS push. Do not invent issues.

Output ONLY a single JSON object, no prose, no markdown fences:
{"stale":[{"file":"<path>","category":"<one of the five>","severity":"high|medium|low","finding":"<what's wrong>","suggestion":"<how to fix>"}],"summary":"<one line>"}
If nothing is stale, output {"stale":[],"summary":"clean"}.
EOF
}

run_analysis() {
  # run_analysis <context> -> echoes raw claude output. Returns 127 if claude unavailable.
  local context="$1"
  local claude_cmd="${INFRA_CHECK_CLAUDE:-claude}"
  if [[ "$claude_cmd" == */* ]]; then
    [[ -x "$claude_cmd" ]] || return 127
  else
    command -v "$claude_cmd" >/dev/null 2>&1 || return 127
  fi
  printf '%s' "$context" | "$claude_cmd" -p "$(analysis_prompt)" 2>/dev/null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_run_analysis.sh`
Expected: `RESULT 5 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "feat: analysis_prompt + run_analysis (mockable claude invocation)"
```

---

### Task 7: `main` wiring + exit codes + non-TTY behavior

**Files:**
- Modify: `~/.claude/skills/infra-check/pre-push.sh` (replace stub `main`)
- Create: `~/.claude/skills/infra-check/tests/test_main_flow.sh`

**Behavior contract for `main` (reads ref lines on stdin):**
- No git / no python3 → warn, exit 0.
- All ref lines resolve to `SKIP` (deletion/empty) → exit 0.
- No infra files in repo → exit 0.
- `claude` unavailable or errored → warn, exit 0 (fail open).
- Report `PROCEED` → exit 0. `FYI` → print FYI to stderr, exit 0. `ERROR` → warn, exit 0.
- Report `BLOCK`:
  - **Interactive (/dev/tty available):** print findings, prompt `[u]pdate / [a]bort`. `u` → run `claude` (foreground, attached to tty) to fix docs, then exit 1 (push stays blocked; user re-pushes after committing). Anything else → exit 1.
  - **Non-interactive (no tty, e.g. CI):** print findings to stderr, exit 0 (don't wedge automation).

Note: we run claude in the **foreground then exit 1** rather than `exec`-ing it — because `exec`'s exit code would become the hook's, and a clean claude exit would let git proceed with an un-fixed push.

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_main_flow.sh`. These drive `main` through `pre-push.sh` run as a real script (not sourced), piping ref lines on stdin, with a mocked claude:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

SCRIPT="$SCRIPT_UNDER_TEST"

make_mock_claude() {
  # make_mock_claude <json-to-emit> -> path to executable
  local d; d=$(mktemp -d)
  printf '#!/usr/bin/env bash\ncat >/dev/null\ncat <<JSON\n%s\nJSON\n' "$1" > "$d/claude"
  chmod +x "$d/claude"
  echo "$d/claude"
}

run_hook() {
  # run_hook <mock-claude-or-empty> <ref-line>  -> sets HOOK_OUT, HOOK_RC
  local mc="$1" ref="$2"
  if [[ -n "$mc" ]]; then
    HOOK_OUT=$(printf '%s\n' "$ref" | INFRA_CHECK_CLAUDE="$mc" bash "$SCRIPT" origin git@x 2>&1)
  else
    HOOK_OUT=$(printf '%s\n' "$ref" | bash "$SCRIPT" origin git@x 2>&1)
  fi
  HOOK_RC=$?
}

# --- clean repo, PROCEED ---
repo=$(make_temp_repo)
echo "X=1" > .env.example; git add -A; git commit -qm "base"
base=$(git rev-parse HEAD)
echo "X=1" >> .env.example; git add -A; git commit -qm "more"
tip=$(git rev-parse HEAD)
mc=$(make_mock_claude '{"stale": [], "summary": "clean"}')
run_hook "$mc" "refs/heads/main $tip refs/heads/main $base"
assert_eq "$HOOK_RC" "0" "PROCEED -> exit 0"
cd /; rm -rf "$repo"

# --- BLOCK in non-interactive context -> exit 0 + findings on stderr ---
repo=$(make_temp_repo)
echo "X=1" > .env.example; git add -A; git commit -qm "base"
base=$(git rev-parse HEAD)
echo "console.log(process.env.NEW)" > app.js; git add -A; git commit -qm "code"
tip=$(git rev-parse HEAD)
mc=$(make_mock_claude '{"stale":[{"file":".env.example","category":"env-drift","severity":"high","finding":"NEW missing","suggestion":"add NEW"}],"summary":"1 high"}')
run_hook "$mc" "refs/heads/main $tip refs/heads/main $base"
assert_eq "$HOOK_RC" "0" "BLOCK non-tty -> exit 0 (no wedge)"
assert_contains "$HOOK_OUT" "NEW missing" "BLOCK non-tty prints findings"
cd /; rm -rf "$repo"

# --- claude unavailable -> fail open exit 0 ---
repo=$(make_temp_repo)
echo "X=1" > .env.example; git add -A; git commit -qm "base"
base=$(git rev-parse HEAD)
echo "y" >> .env.example; git add -A; git commit -qm "more"
tip=$(git rev-parse HEAD)
run_hook "$(mktemp -u)/nope" "refs/heads/main $tip refs/heads/main $base"
assert_eq "$HOOK_RC" "0" "claude missing -> exit 0 (fail open)"
cd /; rm -rf "$repo"

# --- no infra files -> exit 0 ---
repo=$(make_temp_repo)
echo x > app.js; git add -A; git commit -qm "base"
base=$(git rev-parse HEAD)
echo y >> app.js; git add -A; git commit -qm "more"
tip=$(git rev-parse HEAD)
mc=$(make_mock_claude '{"stale": [], "summary": "x"}')
run_hook "$mc" "refs/heads/main $tip refs/heads/main $base"
assert_eq "$HOOK_RC" "0" "no infra files -> exit 0"
cd /; rm -rf "$repo"

# --- deletion ref (local sha zeros) -> exit 0 ---
repo=$(make_temp_repo)
echo x > Dockerfile; git add -A; git commit -qm "base"
mc=$(make_mock_claude '{"stale": [], "summary": "x"}')
run_hook "$mc" "(delete) 0000000000000000000000000000000000000000 refs/heads/old 0000000000000000000000000000000000000000"
assert_eq "$HOOK_RC" "0" "deletion -> exit 0"
cd /; rm -rf "$repo"

echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_main_flow.sh`
Expected: FAIL (stub `main` always exits 0, so the BLOCK-findings `assert_contains` fails).

- [ ] **Step 3: Implement `main`**

Replace the stub `main()` in `pre-push.sh` with:

```bash
warn() { echo "infra-check: $*" >&2; }

main() {
  command -v git >/dev/null 2>&1 || exit 0
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found, skipping check"; exit 0
  fi

  # Find the first non-SKIP range among the pushed refs.
  local range="" l_ref l_sha r_ref r_sha
  while read -r l_ref l_sha r_ref r_sha; do
    [[ -z "${l_sha:-}" ]] && continue
    local cand; cand=$(compute_range "$l_sha" "$r_sha")
    if [[ "$cand" != "SKIP" ]]; then range="$cand"; break; fi
  done
  [[ -z "$range" ]] && exit 0

  local infra; infra=$(match_infra_files)
  [[ -z "$infra" ]] && exit 0

  local context json
  context=$(collect_context "$range")
  json=$(run_analysis "$context") || { warn "analysis unavailable (claude missing/errored), allowing push"; exit 0; }

  local decision kind body
  decision=$(printf '%s' "$json" | evaluate_report)
  kind=$(printf '%s\n' "$decision" | head -1)
  body=$(printf '%s\n' "$decision" | tail -n +2)

  case "$kind" in
    PROCEED) exit 0 ;;
    FYI)     warn "FYI — $body"; exit 0 ;;
    ERROR)   warn "could not parse report ($body), allowing push"; exit 0 ;;
    BLOCK)   : ;;
    *)       exit 0 ;;
  esac

  # BLOCK. Interactive only if a tty is attached.
  if [[ ! -e /dev/tty ]] || ! { : >/dev/tty; } 2>/dev/null; then
    warn "infra docs look stale (non-interactive, allowing push):"
    printf '%s\n' "$body" >&2
    exit 0
  fi

  local tmp; tmp=$(mktemp); printf '%s' "$json" > "$tmp"
  {
    echo ""
    echo "infra-check: this push touches infra and the docs look stale:"
    printf '%s\n' "$body"
    echo ""
    printf "Update infra docs now? [u]pdate / [a]bort push: "
  } > /dev/tty
  local answer; read -r answer < /dev/tty
  case "$answer" in
    u|U)
      echo "Opening Claude to update infra docs (report at $tmp)..." > /dev/tty
      claude "The infra-check pre-push hook found stale infra docs. The JSON report is at $tmp. Update the affected files per the infra-check skill, then I'll re-run 'git push'." < /dev/tty > /dev/tty 2>&1 || true
      echo "Session ended. Review + commit the changes, then re-run: git push" > /dev/tty
      exit 1
      ;;
    *)
      echo "Push aborted. Fix infra docs and retry, or bypass with: git push --no-verify" > /dev/tty
      exit 1
      ;;
  esac
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_main_flow.sh`
Expected: `RESULT 6 0`.

- [ ] **Step 5: Run the full suite**

Run: `bash ~/.claude/skills/infra-check/tests/run.sh`
Expected: ends `TOTAL: 46 run, 0 failed` (7+3+14+9+5+6+2 across all files), exit 0. (Exact count may differ if you adjusted assertions — what matters is `0 failed`.)

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "feat: main wires the hook flow with fail-open + interactive block"
```

---

### Task 8: Author `SKILL.md`

**Files:**
- Create: `~/.claude/skills/infra-check/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`**

Create `~/.claude/skills/infra-check/SKILL.md`:

```markdown
---
name: infra-check
description: Use before pushing, or when asked to check whether infra docs/config (Dockerfiles, compose, Caddyfile, .env.example, infra/**, ARCHITECTURE.md, workflows, terraform, k8s) have drifted from the code. Detects env-var, version, dead-reference, structural, and architecture drift and proposes doc fixes.
---

# infra-check

Detects when infrastructure docs and config files have fallen out of sync with the code, and proposes fixes. Runs automatically as a git pre-push hook (see Install), or invoke it manually any time.

## When this runs automatically

The `pre-push.sh` hook (installed per-repo via `install.sh`) gathers the push diff,
the repo's infra files, and their contents, then calls `claude -p` with the analysis
prompt. It blocks the push on high/medium findings and offers an interactive fix.
It fails **open** — any missing tool or parse error allows the push.

## What counts as "infra files" (built-in heuristics)

Directory prefixes: `infra/**`, `.github/workflows/**`, `k8s/**`, `helm/**`.
Filenames: `Dockerfile*`, `docker-compose*.yml|yaml`, `*.tf`, `*.tfvars`, `Caddyfile`,
`*.nginx`, `nginx.conf`, `.env.example`, `*.env.example`, `ARCHITECTURE.md`, `DEPLOY.md`,
and root-level `README.md`.

## The five checks

- **env-drift** — code reads `process.env.X` with no matching `.env.example` entry (or vice-versa); docs naming env vars that don't match reality.
- **version-drift** — version pins in infra docs that no longer match `package.json`; new deps not mentioned where the stack is documented.
- **dead-reference** — docs referencing files, scripts, commands, paths, or old product names/domains removed or renamed in this push.
- **structural-drift** — new API routes, DB models, or compose services not reflected in ARCHITECTURE/infra docs.
- **architecture-change** — a new feature in this push that materially shapes the system's architecture and should be documented.

## Severity

- **high** — doc is actively wrong/misleading; following it breaks something. (blocks push)
- **medium** — doc is incomplete; missing a real thing that exists. (blocks push)
- **low** — cosmetic / stale-but-harmless. (FYI only, push proceeds)

## Analysis contract (machine-readable)

When invoked by the hook, output ONLY this JSON object, no prose, no fences:

​```json
{"stale":[{"file":"<path>","category":"env-drift|version-drift|dead-reference|structural-drift|architecture-change","severity":"high|medium|low","finding":"<what's wrong>","suggestion":"<how to fix>"}],"summary":"<one line>"}
​```

If nothing is stale: `{"stale":[],"summary":"clean"}`.

> This contract is mirrored in `pre-push.sh`'s `analysis_prompt()`. If you change one, change the other.

## Manual use

Run `claude` in a repo and ask: "use the infra-check skill on my staged changes."
Or inspect what the hook would do: `bash ~/.claude/skills/infra-check/pre-push.sh` is
driven by git stdin, so prefer the manual phrasing above for ad-hoc checks.

## Install / uninstall

- Install into the current repo: `bash ~/.claude/skills/infra-check/install.sh`
- Bypass once: `git push --no-verify`
- Uninstall: `rm .git/hooks/pre-push`
```

Note: the three `​` characters before the JSON fences above are zero-width — when you actually write the file, use plain triple-backtick fences. (They're escaped here only so this plan's own code block doesn't terminate early.)

- [ ] **Step 2: Validate the embedded JSON example parses**

Run:
```bash
python3 -c "import json,re,sys; t=open('$HOME/.claude/skills/infra-check/SKILL.md').read(); m=re.search(r'\{\"stale\":\[\{.*?\}\],\"summary\":\"<one line>\"\}', t); print('FOUND' if m else 'MISSING')"
```
Expected: `FOUND`. (Confirms the schema line survived editing intact.)

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/infra-check
git add -A
git commit -m "docs: SKILL.md — checks, severity, JSON contract, install/usage"
```

---

### Task 9: `install.sh`

**Files:**
- Create: `~/.claude/skills/infra-check/install.sh`
- Create: `~/.claude/skills/infra-check/tests/test_install.sh`

- [ ] **Step 1: Write the failing test**

Create `~/.claude/skills/infra-check/tests/test_install.sh`:

```bash
#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

INSTALL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh"

# Outside a git repo -> non-zero, message.
d=$(mktemp -d); cd "$d"
out=$(bash "$INSTALL" 2>&1); rc=$?
assert_eq "$rc" "1" "outside git repo -> exit 1"
assert_contains "$out" "not a git repo" "explains not a repo"
cd /; rm -rf "$d"

# Inside a fresh repo -> installs symlink, exit 0.
repo=$(make_temp_repo)
out=$(bash "$INSTALL" 2>&1); rc=$?
assert_eq "$rc" "0" "install in repo -> exit 0"
assert_eq "$([ -L .git/hooks/pre-push ] && echo yes)" "yes" "creates a symlink"
# Idempotent re-install (our own symlink) -> still 0.
out=$(bash "$INSTALL" 2>&1); rc=$?
assert_eq "$rc" "0" "re-install our own hook -> exit 0"
cd /; rm -rf "$repo"

# Refuses to clobber a foreign pre-push hook.
repo=$(make_temp_repo)
mkdir -p .git/hooks
echo '#!/bin/sh' > .git/hooks/pre-push
echo 'echo someone elses hook' >> .git/hooks/pre-push
chmod +x .git/hooks/pre-push
out=$(bash "$INSTALL" 2>&1); rc=$?
assert_eq "$rc" "1" "foreign hook present -> exit 1"
assert_contains "$out" "already exists" "warns about existing hook"
# original hook untouched
assert_contains "$(cat .git/hooks/pre-push)" "someone elses hook" "foreign hook preserved"
cd /; rm -rf "$repo"

echo "RESULT $TESTS_RUN $TESTS_FAILED"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash ~/.claude/skills/infra-check/tests/test_install.sh`
Expected: FAIL (install.sh doesn't exist → bash errors / assertions fail).

- [ ] **Step 3: Implement `install.sh`**

Create `~/.claude/skills/infra-check/install.sh`:

```bash
#!/usr/bin/env bash
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SRC="$SELF_DIR/pre-push.sh"

# Must be inside a git work tree.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "infra-check: not a git repo — run this from inside the repo you want to cover." >&2
  exit 1
fi

GIT_DIR="$(git rev-parse --git-dir)"
HOOKS_DIR="$GIT_DIR/hooks"
DEST="$HOOKS_DIR/pre-push"
mkdir -p "$HOOKS_DIR"

if [[ -e "$DEST" || -L "$DEST" ]]; then
  # If it's already our symlink, treat as success (idempotent).
  target="$(readlink "$DEST" 2>/dev/null || true)"
  if [[ "$target" == "$HOOK_SRC" ]]; then
    echo "infra-check: already installed in this repo."
    exit 0
  fi
  echo "infra-check: a pre-push hook already exists at $DEST and isn't ours." >&2
  echo "Back it up or remove it first, then re-run:  rm '$DEST' && bash '$0'" >&2
  exit 1
fi

# Prefer a symlink (skill updates propagate); fall back to a copy.
if ln -s "$HOOK_SRC" "$DEST" 2>/dev/null; then
  :
else
  cp "$HOOK_SRC" "$DEST"
fi
chmod +x "$HOOK_SRC" "$DEST" 2>/dev/null || true

echo "infra-check: installed pre-push hook -> $DEST"
echo "  bypass once:  git push --no-verify"
echo "  uninstall:    rm '$DEST'"
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash ~/.claude/skills/infra-check/tests/test_install.sh`
Expected: `RESULT 8 0`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/infra-check
chmod +x pre-push.sh install.sh
git add -A
git commit -m "feat: install.sh symlinks the hook into a repo (refuses to clobber)"
```

---

### Task 10: End-to-end verification + install in the hooksmith repo

**Files:** none created — this is a verification task.

- [ ] **Step 1: Run the whole suite one final time**

Run: `bash ~/.claude/skills/infra-check/tests/run.sh`
Expected: `TOTAL: ... 0 failed`, exit 0.

- [ ] **Step 2: Manual end-to-end with a REAL claude call (clean case)**

```bash
# In a throwaway repo with an infra file and a harmless change.
d=$(mktemp -d); cd "$d"; git init -q
git config user.email t@t.t; git config user.name t
printf 'NODE_ENV=development\n' > .env.example
git add -A; git commit -qm "base"
bash ~/.claude/skills/infra-check/install.sh
printf 'NODE_ENV=development\n# a comment\n' >> .env.example
git add -A; git commit -qm "harmless"
# No remote: simulate the hook by feeding it a range on stdin.
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$(git rev-parse HEAD~1)" \
  | bash .git/hooks/pre-push origin file://"$d"
echo "exit: $?"
```
Expected: exits 0 (no meaningful drift). A real `claude` call happens — confirm it returns and doesn't hang.

- [ ] **Step 3: Manual end-to-end (drift case, interactive)**

```bash
cd "$d"
# Introduce real env-drift: code reads a var that .env.example lacks.
echo 'const k = process.env.STRIPE_WEBHOOK_SECRET;' > ingest.js
git add -A; git commit -qm "use new env var"
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$(git rev-parse HEAD~1)" \
  | bash .git/hooks/pre-push origin file://"$d"
```
Expected: prints a high/medium env-drift finding about `STRIPE_WEBHOOK_SECRET`, then prompts `[u]pdate / [a]bort`. Choose `a` → exit 1 (blocked). Re-run and choose `u` → a Claude session opens offering to add the var to `.env.example`. Clean up: `cd /; rm -rf "$d"`.

- [ ] **Step 4: Verify `--no-verify` bypass**

```bash
# In the same drift repo, with a (fake) remote, confirm bypass skips the hook.
# If no remote is configured, this step is conceptual: git push --no-verify
# never invokes .git/hooks/pre-push. No assertion needed beyond confirming the
# hook file is a real pre-push hook (git only runs hooks named exactly 'pre-push').
ls -l "$d/.git/hooks/pre-push" 2>/dev/null || echo "(repo already cleaned up)"
```
Expected: confirms the hook is installed as `pre-push` (so `--no-verify` is the documented bypass).

- [ ] **Step 5: Install into the hooksmith repo (the real target)**

```bash
cd /Users/nikosgkikas/Desktop/PracticeProjects/hooksmith
bash ~/.claude/skills/infra-check/install.sh
ls -l .git/hooks/pre-push
```
Expected: prints "installed pre-push hook" and the symlink resolves to `~/.claude/skills/infra-check/pre-push.sh`.

- [ ] **Step 6: Report to the user**

Summarize: skill location, that it's installed in hooksmith, how to install elsewhere (`bash ~/.claude/skills/infra-check/install.sh`), how to bypass (`--no-verify`), and that it fails open. Do **not** auto-commit anything in the hooksmith repo — the only repo artifacts are the already-written spec + this plan, which the user commits when ready.

---

## Self-review notes

- **Spec coverage:** trigger=pre-push hook (Tasks 7, 9); built-in heuristics (Task 4); block-then-interactive-update (Task 7); five checks incl. architecture-change (Tasks 6, 8); per-repo install command (Task 9); always-invoke-claude, no pre-filter (Task 7 `main` — no diff pre-filter, only the "no infra files" short-circuit which the spec's glob section permits); fail-open (Tasks 6, 7); block on high+medium, FYI on low (Tasks 2, 7); JSON contract + caps + edge cases (Tasks 2, 5, 7). All covered.
- **Correction vs spec:** spec text said `exec claude`; this plan uses **foreground claude + exit 1** instead, because `exec` would hand git claude's exit code and a clean exit would let the un-fixed push through. Same user-visible intent (push stays blocked, user re-pushes), correct implementation.
- **Type/name consistency:** function names and the JSON field set (`stale[].file/category/severity/finding/suggestion`, `summary`) are identical across `analysis_prompt`, `evaluate_report`, `SKILL.md`, and the tests.
- **Test counts** in "expected" lines are guidance; the gate is `0 failed`.
```
