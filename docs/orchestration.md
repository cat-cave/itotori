# Orchestrator Playbook

This is the **authoritative connective-tissue doc** for running itotori as the
central orchestrator agent. `qd method show` points here
(`docs/orchestration.md`).

Verified against **qdcli 0.4.1** and the current `gh` / shell-agent CLIs. Do not
invent flags — when unsure, re-run `qd help`, `qd <cmd> --help`, or
`gh <cmd> --help`.

**Related (do not duplicate):**

- [`docs/dev/orchestration-operating-model.md`](dev/orchestration-operating-model.md)
  — itotori-only rules (milestones, provider/cost policy, DAG anti-patterns).
- [`docs/dev/worktree-lifecycle.md`](dev/worktree-lifecycle.md) — worktree
  naming, `just worktree-setup`, env-path guard, per-worktree
  `CARGO_TARGET_DIR`.
- [`docs/dev/spec-dag.md`](dev/spec-dag.md) — committed export + validator
  contract.
- [`docs/dev/audit-playbook.md`](dev/audit-playbook.md) — itotori audit quality
  bars.
- [`.qd/skills/qd-dag/SKILL.md`](../.qd/skills/qd-dag/SKILL.md) — qd skill
  bootstrap (claim → complete → audit → CI → merge loop).

---

## A. The landing flow (authoritative)

`main` is **branch-protected** with a **native GitHub merge queue**. Land work
only via:

```text
PR → tiered CI (Tier 0 / Tier 1) → merge queue → squash onto main
```

- **NOT** direct push to `main`.
- **NOT** cherry-pick onto `main`.
- Required checks come from `.github/workflows/pr-tiers.yml` (Tier 0 + Tier 1
  via `_tier0.yml` / `_tier1.yml`), including on `merge_group` events.

### Enqueue a PR

The repo has `allow_auto_merge`. After the PR is open and (when ready) checks
are green or still pending:

```sh
gh pr merge <N> --squash --auto
```

Under qd, prefer driving enqueue from the ledger once the node is mergeable:

```sh
qd merge <node> --enqueue          # explicit native-queue entry
# or, with mergeQueueMode=auto:
qd merge <node> --via-pr           # also enters the queue when main requires it
qd sync-prs                        # records the queue-produced squash-merge SHA
```

`qd merge --use-existing-commit <sha>` is **ledger-only** (reconciles an already
landed commit). Reserve it for that narrow case.

### Queue-state signal gotcha

Check **membership in the merge queue**, not the auto-merge flag:

| Signal                                                                      | Meaning                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GraphQL `pullRequest { isInMergeQueue mergeQueueEntry { position state } }` | **Authoritative** queue membership + position                                                                                        |
| `merge_group` check runs on the PR                                          | Queue is rebuilding/testing the merge group                                                                                          |
| `autoMergeRequest`                                                          | **Only** the auto-merge _flag_. Often **null even when queued**. A non-null value does **not** prove queue membership or failure     |
| `mergeStateStatus: BEHIND`                                                  | Main advanced under the PR. **Normal.** The queue rebuilds the `merge_group` off current `main` and merges. **Do not panic-rebase.** |

Example membership probe:

```sh
gh api graphql -f query='
  query($owner:String!,$name:String!,$number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        isInMergeQueue
        mergeStateStatus
        mergeQueueEntry { position state }
        autoMergeRequest { enabledAt }
      }
    }
  }' -f owner=cat-cave -f name=itotori -F number=<N>
```

---

## B. The qd node lifecycle (qdcli 0.4.1)

**qd is a STATE LEDGER.** The real git merge happens through GitHub's merge
queue, separately. qd records claims, completion evidence, audits, CI, and
mergeability; `qd merge --enqueue` / `--via-pr` _drive_ the queue and
`qd sync-prs` records the result.

### Session start

```sh
qd method acknowledge --agent <name>   # required each session before mutating commands
qd doctor --json
qd status --json
qd ready --json
```

Mutating commands (`add-bulk`, `complete`, `unblock`, …) refuse until the
active method hash is acknowledged for this session.

### Per-node sequence (orchestrator only)

1. **Claim** — `qd claim <id> --agent <name> [--branch <branch>] [--pr <n>]`
2. **Worktree** — create an isolated worktree under `/scratch/worktrees/` (see
   §D). Prefer project naming from
   [`worktree-lifecycle.md`](dev/worktree-lifecycle.md); `qd worktree create`
   exists but defaults under `.qd/worktrees/` — do **not** use in-repo paths.
3. **Implement** — delegate to a subagent / shell-agent (§C, §H). Subagents
   **never** run `qd`.
4. **Complete** — evidence-first only:

   ```sh
   qd template completion-report > /tmp/<id>-completion.json
   # fill report, then:
   qd complete <id> --from-report /tmp/<id>-completion.json
   ```

   Use **`--from-report`**, not `--summary` (`--summary` was removed in 0.4.1).
   Completion means _ready for audit_, not _done_.

5. **Audit** — independent review (different model than implementer when
   shell-agents are used):

   ```sh
   qd audit start <id>
   qd template audit-report > /tmp/<id>-audit.json
   # each finding MUST include an evidence field
   qd audit pass <id> --from-report /tmp/<id>-audit.json
   ```

6. **Verification sign-off**

   ```sh
   qd verification sign-off <id> --index <n> --note <text> [--evidence <path>]
   # or batch:
   qd verification sign-off <id> --all --from-report <verification-signoff.json>
   ```

7. **CI record** — after trusted green (GitHub tier checks and/or
   `qd ci run` / external evidence):

   ```sh
   qd ci record-pass <id> --summary <text> (--log-path <path>|--url <url>|--external-id <id>)
   ```

8. **Merge via queue**

   ```sh
   qd merge <id> --enqueue    # or --via-pr under mergeQueueMode=auto
   qd sync-prs
   ```

9. **Export + validate + commit** (from the main checkout; do not hand-edit
   lifecycle in the JSON):

   ```sh
   qd export --out roadmap/spec-dag.json --deterministic
   node scripts/spec-dag.mjs validate   # must exit 0
   # equivalently: just roadmap-validate (also checks audit-report schema/examples)
   ```

### Gate ordering (enforced)

qd policy (see `qd config show` → `policy`):

- `requireAuditBeforeCi` — **audit before CI**
- `requireVerificationBeforeCi` — **verification before CI**
- `requireGateBeforeCi` / open P0–P1 findings block the gate
- `requireCiBeforeMerge` — merge requires a passing CI record

Do not reorder or skip these.

### Queue surface

```sh
qd queue enqueue <node>|--all-ready [--wave <id>] [--limit <n>] [--concurrency <n>]
qd queue status [node] [--json]
qd queue sync [node] [--json]
qd queue watch <node>|drain [--interval 10] [--timeout 3600]
qd queue bisect <node>|--merge-group <sha> [--json]
```

### Export schema

- qd 0.4.x export is **`schema_version` 3**.
- Repo validator `scripts/spec-dag.mjs` accepts **`{1, 2, 3}`**.

### Who runs qd

**Only the ORCHESTRATOR uses qd, and only from the MAIN checkout.**

Subagents never touch qd. Worktrees must not become a second ledger (see
§I, QD_ROOT trap).

---

## C. Delegating work: subagents + shell-agents

### Two kinds of workers

| Kind                         | Examples                                    | Properties                                                              |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| **Harness Claude subagents** | Claude Code Task / isolated agent worktrees | Reaper-immune; run in isolated worktrees                                |
| **Shell-agents**             | `codex`, `grok`, `opencode` / GLM-5.2       | Fine for authorship; **reaped after ~15–22 min** → need a soft watchdog |

### Model routing

| Work                                             | Prefer                                                 | Avoid / constraint                                                     |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Mechanical implementation, tooling, docs         | GLM (`opencode` / `zai-coding-plan/glm-5.2`) or `grok` | —                                                                      |
| Audits                                           | `codex` **or a different model than the implementer**  | Same model that wrote the code                                         |
| Byte-touching / correctness-critical / gate work | **Claude-native** (harness subagent)                   | GLM under-wires correctness                                            |
| Oracle-grade runtime-semantics proofs            | Claude-native + human/orchestrator spot-check          | **grok fabricates** these proofs — always audit with a different model |

### Canonical shell-out pattern

1. Write the **full markdown brief** to a temp **prompt file**.
2. Invoke the agent with a **tiny** "read the instructions at `<path>` and
   follow them completely" (or `--prompt-file`).
3. **Do not use stdin** for the prompt — redirect from `/dev/null` where the
   CLI would otherwise hang on stdin.
4. Point `--cwd` / `cd` at the **single** worktree for that agent.
5. Wrap every backgrounded shell-agent in a **soft watchdog** that wakes on
   done-or-stall. **Never** hard-kill a slow run. **Never** `& wait` on a hung
   child (it wedges silently).

See §H for copy-pasteable invocations.

### Isolation rules for delegates

- **One worktree per subagent** — never point two agents at one worktree.
- Scope every resume tightly (one node / one finding / one file set).
- On shell-agent exit (reaped or done): check the worktree for uncommitted
  work / an opened PR and finalize git if the agent died mid-task.

---

## D. Worktree + isolation discipline

### Location and naming

Worktrees live **outside** the repo:

```text
/scratch/worktrees/itotori-<slug>
```

Canonical naming is in
[`docs/dev/worktree-lifecycle.md`](dev/worktree-lifecycle.md)
(`spec/…`, `worker/…`, `repair/…`, `audit/…`).

### Per-worktree Cargo targets

Each worktree gets an isolated `CARGO_TARGET_DIR` automatically via `flake.nix`
/ `nix develop` (see root [`AGENTS.md`](../AGENTS.md)). **Sharing target dirs
corrupts concurrent builds.**

Fresh worktree once:

```sh
direnv exec . just worktree-setup   # offline pnpm install --frozen-lockfile
```

### Protected namespaces (never prune)

Do **not** delete or bulk-prune worktrees matching:

- `sweetie-hd-real-*`
- legacy `reallive` / `xor2` / `sweetie` namespaces

### Stay current with origin/main

The merge queue advances `origin/main` constantly. **ALWAYS fetch and confirm
local `main` == `origin/main` BEFORE branching or auditing.**

```sh
MAIN=<path-to-main-checkout>
git -C "$MAIN" fetch origin
git -C "$MAIN" checkout main
git -C "$MAIN" pull --ff-only origin main
test "$(git -C "$MAIN" rev-parse main)" = "$(git -C "$MAIN" rev-parse origin/main)"

# then base the worker branch / worktree off that tip
```

If operator helpers `scripts/sync-main.sh` / `scripts/sync-worktree.sh` exist
in your environment, use them; the contract above is what they must implement.

---

## E. Wave cadence (sustainable throughput)

- Run **~5 concurrent** subagents across **DISJOINT** parts of the tree (no
  shared worktree, no overlapping file ownership).
- Include **≥1 high-fidelity UI node every wave** — UI is the long pole.
- Prioritize **foundation / gating** nodes that unlock others.
- Operate parallel-friendly; do not serialize work that can fan out.
- Use waves on the queue surface when batching:
  `qd queue enqueue --all-ready --wave <id> [--limit n] [--concurrency n]`.

---

## F. When to step in — avoid "building in theory" (green-against-mocks)

### CI-green ≠ real-bytes-green

Per-gate CI (`just ci` / `just qd-full-ci` / PR Tier 0+1) is intentionally
fast and largely synthetic/fixture-backed. The **real-bytes proofs** are
`#[ignore]` / env-gated and run only in the periodic

```sh
just real-bytes-oracle
```

lane (see [`docs/real-bytes-periodic-oracle.md`](real-bytes-periodic-oracle.md)),
**not** in per-gate CI. **Never treat CI-green alone as proof the code works
on real game bytes.**

### Oracle validation

- Use **`rlvm` / `xclannad`** as a fidelity oracle for RealLive; spot-check
  against real game behavior.
- External reference tools may be **cloned and run for validation** — they are
  not part of the shipped pipeline.
- Policy surface: [`docs/utsushi-fidelity-policy.md`](utsushi-fidelity-policy.md),
  [`docs/synthetic-differential-validation.md`](synthetic-differential-validation.md).

### Manual step-in

For **oracle-grade runtime-semantics** claims and **visual/UI fidelity**, the
orchestrator personally spot-checks or tasks a **Claude** subagent to verify
locally. Do not rubber-stamp shell-agent proof prose.

### Adversarial audits

Independent audits catch hollow proofs:

- Audit with a **different model** than the implementer.
- Default stance: **refute** — demand evidence paths, commands, and artifacts.
- Every finding needs an **`evidence` field**.
- Layer itotori anti-patterns from
  [`orchestration-operating-model.md`](dev/orchestration-operating-model.md).

---

## G. Ingesting EXTERNAL contributor PRs (the localizer stream)

A parallel **"localizer"** agent may operate as an external technical user
(GitHub issues + PRs, **not** qd). The orchestrator remains the **sole merge
authority** for those PRs.

### Workflow

1. **Poll**

   ```sh
   gh pr list --state open
   ```

2. **Review / verify** — treat as untrusted-until-audited; run the same audit
   net as internal work (tests, anti-patterns, real-bytes when relevant).

3. **Map to DAG** when the PR resolves (or partially resolves) a node:

   ```sh
   qd node set-pr <node> <pr-number>
   qd note add <node> --text "PR #X resolves <portion>; remaining: <Y>"
   ```

   qd has **no** first-class partial-resolution field. Partial progress is a
   **note** while the node stays open. Full `done` still requires the normal
   gate (complete → audit → verification → CI → merge → export).

4. **Merge via the queue** (`gh pr merge <N> --squash --auto` and/or
   `qd merge … --enqueue` once the node is mergeable and linked).

5. **Close the loop**
   - Fully resolved → drive the node's gate to done and re-export.
   - Partial → leave open with the note for a later PR.

### No matching node

- Mint nodes with `qd nodes add-bulk --from-json <plan.json>` (idempotent;
  see §I), **or**
- Handle as a standalone fix outside the DAG if it is truly not roadmap work.

---

## H. Shell-out cookbook (exact, verified commands)

A fresh agent must not re-derive these. Verified as of **qdcli 0.4.1** and the
current CLIs on this host.

### Canonical pattern (all shell-agents)

```sh
BRIEF=/tmp/brief-<node>.md
# write the full markdown brief to $BRIEF …

# soft watchdog: wake on done OR stall; never hard-kill; never bare `& wait`
```

### grok (headless, agentic)

```sh
grok --prompt-file "$BRIEF" \
  --always-approve \
  --output-format plain \
  --cwd /scratch/worktrees/itotori-<slug> \
  [--max-turns <N>] \
  [-m <model>]
```

Notes:

| Flag                                          | Role                                      |
| --------------------------------------------- | ----------------------------------------- |
| `--prompt-file <PATH>`                        | Read prompt from file (stdin unused)      |
| `-p, --single <PROMPT>`                       | Inline single-turn prompt instead         |
| `--prompt-json <JSON>`                        | Content blocks                            |
| `--always-approve`                            | Auto-approve tool executions (headless)   |
| `--output-format plain\|json\|streaming-json` | Headless output                           |
| `--cwd <DIR>`                                 | Working directory → point at the worktree |
| `--worktree[=name]` / `--worktree-ref <ref>`  | Start in a fresh git worktree instead     |
| `--json-schema <SCHEMA>`                      | Constrain output to JSON                  |
| `--max-turns <N>`                             | Bound the agent loop                      |

Default model is **grok-4.5**. Strong on full-stack self-correction; **weak on
oracle-grade runtime-semantics proof (fabricates)** → always audit grok with a
**different** model.

### opencode / GLM-5.2 (headless)

```sh
cd /scratch/worktrees/itotori-<slug>
opencode run --auto -m zai-coding-plan/glm-5.2 \
  "Read the instructions at $BRIEF and follow them completely."
```

- Runs in the **current directory** — `cd` into the worktree first (or use
  `--dir` if you prefer not to `cd`).
- `--auto` auto-approves non-denied permissions.
- Model format is `provider/model`.
- GLM **under-wires** correctness-critical work → keep byte-touching / gate
  work Claude-native; use GLM for mechanical tooling/docs + audit support.

### codex (audits)

```sh
codex exec "Read the instructions at $BRIEF and follow them completely." < /dev/null
```

- **`< /dev/null` is MANDATORY.** Without it, codex hangs on _"Reading
  additional input from stdin"_.
- To stop a runaway codex:

  ```sh
  pgrep -f '^codex exec'    # note PIDs
  kill <pid>                # kill by PID
  ```

  **NEVER** `pkill -f '<pattern>'` — the pattern matches the launching shell's
  own cmdline and kills your shell (exit 144).

### After any shell-agent exits

Shell-agents (`grok` / `codex` / `opencode`) are reaped after ~**15–22 min**.
On exit (reaped or done):

1. Inspect the worktree for uncommitted work.
2. Check whether a PR was opened (`gh pr list --head <branch>`).
3. Finalize git / open the PR if the agent died mid-task.

Harness Claude subagents are reaper-immune.

---

## I. qd gotchas & non-obvious best practices

Learned the hard way — do not rediscover these under load.

### `qd config set ci-workflow`

```sh
qd config set ci-workflow <name>     # EXISTS; not in the top-level help synopsis
qd config get ci-workflow
qd config show                       # JSON of all current values
```

Used to repoint a stale `ciWorkflow` (e.g. after `ci.yml` retired in favor of
`pr-tiers.yml`). Some `qd config set` keys are only discoverable by trying;
`qd config show` reveals what is actually set.

### Export receipt vs full graph

```sh
qd export --deterministic
# → writes roadmap/spec-dag.json, prints a RECEIPT
#   (stdoutContainsGraph:false) + the stream command

qd export --deterministic --out -    # stream full graph to stdout
qd export --out roadmap/spec-dag.json --deterministic   # explicit path
```

### `qd nodes add-bulk --from-json`

```sh
qd nodes add-bulk --from-json <plan.json>
```

- **Idempotent + atomic.**
- Exact retries return `skipped-existing` per node.
- Conflicting existing id (same id, different fields) **fails the batch**,
  names the differing field, and writes **nothing**.
- Safe to retry.
- Node `kind` must be one of: `feature`, `fix`, `refactor`, `test`, `docs`,
  `infra`, `audit-fix`.
- Shape: `qd schema example node`.

### Method acknowledge is a hard gate

```sh
qd method acknowledge --agent <name>
```

Required **each session** before mutating commands (`add-bulk`, `complete`,
`unblock`, …), or they refuse.

### QD_ROOT trap

Running `qd` from inside a worktree **without** `QD_ROOT` set makes it resolve
to the worktree's own `.qd/` and **silently create a fresh EMPTY ledger** —
so `qd claim` there excludes nobody and diverges from the real DAG.

```sh
# if you must invoke qd outside the main checkout:
export QD_ROOT=<path-to-main-checkout>
# or: qd --root <path-to-main-checkout> <command>
```

This is **why** only the orchestrator, from the main checkout, runs qd.
Subagents never need `qd`. Prefer never setting a second ledger over "fixing"
a worktree-local one.

### Untrustworthy green: `pg_isready` noise

When a `just ci` / DB-backed run logs **`pg_isready` errors** but still
**exits 0**, treat the result as **UNTRUSTWORTHY** — a DB flake can mask real
failures. Re-run clean, or prefer per-node / GitHub tier CI evidence over the
suspect local log.

### Other quick reminders

- Parse qd with `--json` when automating; humans can use table output.
- P0/P1 findings are current-node blockers; P2/P3 become future DAG shape via
  promotion.
- If the graph is wrong, **fix the graph** — do not bypass the ready queue.
- Never commit `.env`, corpora, or copyrighted bytes (env-path guard in
  [`worktree-lifecycle.md`](dev/worktree-lifecycle.md)).

---

## Quick reference: orchestrator loop

```text
method acknowledge
  → ready / claim
  → worktree under /scratch/worktrees/itotori-<slug>
  → delegate implement (subagent | shell-agent + soft watchdog)
  → complete --from-report
  → audit pass --from-report (evidence on every finding)
  → verification sign-off
  → ci record-pass (after trusted green)
  → merge --enqueue | --via-pr
  → sync-prs
  → export --deterministic + node scripts/spec-dag.mjs validate
  → commit export on main-ledger branch / PR as appropriate
```

Landing is always **PR → Tier 0/1 → native merge queue**, never direct-to-main.
