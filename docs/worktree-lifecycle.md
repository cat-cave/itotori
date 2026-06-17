# Agent Worktree Lifecycle

This playbook is the operational checklist for orchestrator-managed spec
branches and worktrees. It complements
[orchestration-operating-model.md](orchestration-operating-model.md), which
defines the higher-level authority model, audit policy, provider policy, and
merge gate.

The source of truth for roadmap state is `roadmap/spec-dag.json`. Worktrees are
temporary execution environments. Chat history, local notes outside the repo,
and uncommitted files are not durable state.

## Safety Invariants

- Use one active spec branch per DAG node.
- Use one primary worktree per active spec branch.
- Use additional worker worktrees only when their branches and write scopes are
  disjoint.
- Never check out the same branch in two writable worktrees.
- Inspect dirty and untracked files before removing a worktree.
- Do not treat untracked files as disposable until the owning worker, branch,
  and node state have been checked.
- Never read, print, copy, or commit `.env` or `.env.*` files. Worktrees may
  consume secrets only as process environment variables already provided by the
  invoking shell or user.
- Keep raw provider logs, secret-bearing output, local caches, and large
  generated artifacts out of git.
- A blocked node must have both explicit DAG state and a durable reason record.

## Naming Rules

Use the uppercase DAG id in text and lower-case id in branch and worktree names.
The slug format is `[a-z0-9]+(-[a-z0-9]+)*`.

| Purpose                        | Branch                                      | Worktree                                                 |
| ------------------------------ | ------------------------------------------- | -------------------------------------------------------- |
| Primary spec work              | `spec/<node-id-lower>`                      | `/tmp/itotori-spec-<node-id-lower>`                      |
| Disjoint implementation worker | `worker/<node-id-lower>-<scope-slug>`       | `/tmp/itotori-worker-<node-id-lower>-<scope-slug>`       |
| Blocking repair worker         | `repair/<node-id-lower>-<finding-id-lower>` | `/tmp/itotori-repair-<node-id-lower>-<finding-id-lower>` |
| Read-only audit lane           | detached from `spec/<node-id-lower>`        | `/tmp/itotori-audit-<node-id-lower>-<lane-slug>`         |

Example for `UNIV-003`:

```sh
git worktree add -b spec/univ-003 /tmp/itotori-spec-univ-003 main
git worktree add -b worker/univ-003-docs-index /tmp/itotori-worker-univ-003-docs-index spec/univ-003
git worktree add --detach /tmp/itotori-audit-univ-003-docs spec/univ-003
```

Do not add random suffixes to resolve collisions. If the canonical branch or
worktree already exists, inspect it and either reuse the matching active state,
prune stale state, or choose a deliberately scoped worker or repair name.

## Collision Checks

Run collision checks before claiming a node or creating a branch or worktree:

```sh
git branch --list 'spec/univ-003'
git branch --list 'worker/univ-003-*'
git branch --list 'repair/univ-003-*'
git worktree list --porcelain
```

Before any command that displays paths from a worktree, load and use these
helpers. They detect tracked, staged, or untracked env filenames silently, stop
with a generic message, and filter env path patterns out of displayed status or
diff output. Do not replace them with raw `git status --untracked-files=all` or
raw untracked-file path listings.

```sh
env_path_guard() {
  repo="$1"

  if git -C "$repo" ls-files -z | rg -z -q '(^|/)\.env(\.|$)'; then
    echo "tracked env file detected; stop"
    exit 1
  fi

  if git -C "$repo" diff --cached --name-only -z | rg -z -q '(^|/)\.env(\.|$)'; then
    echo "staged env file detected; stop"
    exit 1
  fi

  if git -C "$repo" ls-files --others --exclude-standard -z | rg -z -q '(^|/)\.env(\.|$)'; then
    echo "untracked env file detected; stop"
    exit 1
  fi
}

safe_worktree_status() {
  repo="$1"
  env_path_guard "$repo"
  git -C "$repo" status --short --untracked-files=all -- . \
    ':(exclude).env' ':(exclude).env.*' \
    ':(exclude)**/.env' ':(exclude)**/.env.*'
}

safe_worktree_diff_names() {
  repo="$1"
  range="$2"
  env_path_guard "$repo"
  git -C "$repo" diff --name-status "$range" -- . \
    ':(exclude).env' ':(exclude).env.*' \
    ':(exclude)**/.env' ':(exclude)**/.env.*'
}
```

If a branch exists without a worktree, inspect whether it is merged:

```sh
git branch --merged main --list 'spec/univ-003'
git log --oneline main..spec/univ-003
```

If a worktree exists, inspect it from outside before reusing or deleting it:

```sh
safe_worktree_status /tmp/itotori-spec-univ-003
git -C /tmp/itotori-spec-univ-003 branch --show-current
```

If any command shows uncommitted, untracked, or unknown state, stop and assign
cleanup to the owning worker or record the node as blocked. Do not delete the
worktree just because the branch name looks stale.

## Lifecycle

### 1. Claim

1. Read ready work:

   ```sh
   just roadmap-ready
   node scripts/spec-dag.mjs show UNIV-003
   ```

2. Confirm dependencies are complete and the node is still `planned`.
3. Choose the exact owner string and canonical branch/worktree names for the
   claim. The owner may be a human, orchestrator, or agent id, but it must be
   stable enough for another worker to know who owns the branch.
4. Run the collision checks for `spec/<node-id-lower>`.
5. Re-read `roadmap/spec-dag.json` immediately before creating the branch and
   worktree. If the node is no longer `planned`, or is already `in_progress`
   with a different `owner`, `branch`, or `worktree`, stop. The existing DAG
   claim owns the node; do not create a second worktree or resolve the collision
   with a random suffix.
6. Create the primary branch and worktree from an up-to-date `main` using the
   chosen names while the DAG node is still `planned`:

   ```sh
   git switch main
   git pull --ff-only
   git worktree add -b spec/univ-003 /tmp/itotori-spec-univ-003 main
   ```

   If branch or worktree creation fails, do not edit the DAG to `in_progress`
   and do not continue on an ad hoc branch. Reconcile the stale branch/worktree
   collision or leave the node `planned` until the collision is resolved.

7. In the new worktree, re-read `roadmap/spec-dag.json`. If the node is still
   `planned`, move it to `in_progress` with schema-valid claim metadata. If it
   changed after branch creation, stop and reconcile that state before editing:

   ```json
   {
     "status": "in_progress",
     "owner": "Worker UNIV-003",
     "branch": "spec/univ-003",
     "worktree": "/tmp/itotori-spec-univ-003"
   }
   ```

   The schema requires `owner` plus at least one of `branch` or `worktree`; use
   both when the worktree name is known. Do not set `status: "in_progress"`
   alone. Run `node scripts/spec-dag.mjs validate` after the edit.

8. Commit the claim metadata before planning, implementation, or delegation:

   ```sh
   git -C /tmp/itotori-spec-univ-003 diff --check
   git -C /tmp/itotori-spec-univ-003 add roadmap/spec-dag.json
   git -C /tmp/itotori-spec-univ-003 commit -m "chore(roadmap): claim UNIV-003"
   ```

   When coordination happens through a shared remote or protected integration
   branch, push the claim branch or merge the claim commit according to that
   workflow before treating the node as owned. If the claim cannot be committed
   or published, move the node back to `planned` before any further work. The
   branch/worktree is only the place where the claim is prepared; the durable
   claim is the committed DAG update. The lifecycle must never rely on an
   uncommitted `in_progress` DAG edit as the claim record.

### 2. Plan

Create a plan that names:

- the DAG node id, branch, and worktree;
- deliverables and acceptance criteria copied from the node;
- expected files or modules to edit;
- commands required by the node plus the final `just check`;
- audit focus and likely auditor lanes;
- risks around branch collisions, untracked files, generated artifacts, and
  secrets.

Plans may live in a PR description, issue comment, audit artifact, or tracked
branch note. They must not live only in chat.

When GitHub issues are used as durable planning records, derive them from the
DAG with `node scripts/spec-dag.mjs sync-issues --dry-run` first. The default
sync command is non-mutating and does not call GitHub. A live issue writer must
require an explicit `--apply` flag, preserve non-DAG human labels, and keep the
rendered `<!-- spec-dag-node: NODE-ID -->` marker in every issue body so repeat
syncs update the same issue instead of creating duplicates.

### 3. Implement

Implementation workers write only in their assigned worktree and scope.

- Use the primary `spec/<node-id-lower>` branch for single-worker specs.
- Use `worker/<node-id-lower>-<scope-slug>` branches for parallel work, and
  merge them back into the primary spec branch only after checking their write
  sets are disjoint.
- Keep generated output in ignored paths such as `.tmp/`.
- Do not read or print `.env` files. If a command needs a secret, require the
  user or runner to provide it as process environment.
- Before handing off, run the node verification commands that are relevant to
  the edited scope and summarize failures with exact command output.

### 4. Audit

Audit reads the spec branch after implementation and before merge. Use detached
audit worktrees when auditors need an isolated checkout:

```sh
git worktree add --detach /tmp/itotori-audit-univ-003-docs spec/univ-003
```

Auditors inspect:

- diff against `main`;
- claimed deliverables and acceptance criteria;
- command results and manual verification evidence;
- P0/P1 blockers;
- P2/P3 follow-up candidates;
- stale worktrees, branch collisions, untracked files, and abandoned agent
  state.

Machine-ingestible audit reports follow [audit-playbook.md](audit-playbook.md).
P0 and P1 findings block completion. P2 and P3 findings must either be fixed in
the active branch with durable disposition or converted into DAG work.

### 5. Repair

For each P0 or P1 finding:

1. Convert the finding into concrete repair acceptance criteria.
2. Assign repair to the primary spec branch or to
   `repair/<node-id-lower>-<finding-id-lower>` when isolation is useful.
3. Run the failing verification again.
4. Re-run the focused audit or an equivalent review.
5. Repeat until no P0/P1 findings remain.

Do not merge while any P0 or P1 finding is open. Do not convert P0/P1 findings
into follow-up nodes.

For P2/P3 findings:

- create a new planned DAG node when the work is independent;
- append acceptance criteria to an existing planned DAG node when it already
  owns the work;
- fix in the active branch only when the work is cheap, low-risk, explicitly
  assigned, and recorded in a durable disposition.

### 6. Merge

Before merge, the orchestrator verifies:

- `safe_worktree_status .` reports a clean tree or only intentionally retained
  non-secret untracked files; if the env guard reports an env file, stop without
  printing the path;
- no `.env` or `.env.*` path is tracked or staged;
- diff matches the node deliverables and does not include unrelated refactors;
- all required verification commands passed;
- `just check` passed;
- audit has no open P0/P1 findings;
- P2/P3 findings are fixed with a durable disposition or represented in the DAG;
- generated artifacts, raw provider logs, caches, and large local outputs are
  not committed;
- the branch can merge cleanly into current `main`.

Use the `env_path_guard` helper before commands that list paths, before commit,
and before merge. If the helper is unavailable, use this equivalent silent
guard:

```sh
if git ls-files -z | rg -z -q '(^|/)\.env(\.|$)'; then
  echo "tracked env file detected; stop"
  exit 1
fi

if git diff --cached --name-only -z | rg -z -q '(^|/)\.env(\.|$)'; then
  echo "staged env file detected; stop"
  exit 1
fi

if git ls-files --others --exclude-standard -z | rg -z -q '(^|/)\.env(\.|$)'; then
  echo "untracked env file detected; stop"
  exit 1
fi
```

Merge from an up-to-date `main`:

```sh
git switch main
git pull --ff-only
git merge --ff-only spec/univ-003
```

If the fast-forward merge fails, stop. Rebase or repair in the spec worktree,
rerun verification and audit as needed, then try again. Do not force-push or
merge with unresolved evidence.

### 7. Mark Complete

Mark the node `complete` only after the implementation is merged into `main` and
the merged result satisfies the merge gate. Completion is a DAG update, not a
worker handoff.

The completion update must include:

- `status: "complete"` for the node;
- no open P0/P1 audit findings;
- durable disposition for P2/P3 findings;
- verification evidence from the merged branch or a clearly equivalent local
  run.

If the merged result cannot be trusted, leave the node non-complete and record
the blocker instead.

## Blocked Specs

Use `blocked` only when the active node cannot make meaningful progress until a
specific external state changes or a blocking decision is made.

Blocked state requires two durable records:

1. `roadmap/spec-dag.json` sets a schema-valid blocked state:

   ```json
   {
     "status": "blocked",
     "statusReason": "Awaiting maintainer decision on shared worktree ownership.",
     "blockedBy": "human:maintainer",
     "owner": "Worker UNIV-003",
     "branch": "spec/univ-003",
     "worktree": "/tmp/itotori-spec-univ-003"
   }
   ```

   `statusReason` and `blockedBy` are required DAG fields for blocked nodes.
   Keep `owner`, `branch`, and `worktree` when active local state still exists so
   another worker can find the claim. A separate note without these DAG fields is
   not schema-valid.

2. A reason record exists in an audit report, PR/issue description, or tracked
   `roadmap/blocks/<node-id-lower>.md` file.

The reason record must include:

- node id, branch, and worktree;
- blocker summary;
- owner or next decision maker;
- first failed command or audit finding id, when applicable;
- last known green verification, when applicable;
- unblock condition;
- whether dirty or untracked files exist;
- whether the worktree should remain, be archived, or be pruned;
- date recorded.

When unblocked, move the node back to `in_progress` with valid `owner` plus
`branch` or `worktree`, or back to `planned` after clearing stale claim fields.
Remove or update stale `statusReason` and `blockedBy`, update or remove the
reason record, and rerun collision checks before resuming work.

## Cleanup

Clean up only after merge, cancellation, or a durable blocked/abandoned record.

For a merged spec branch:

```sh
git branch --merged main --list 'spec/univ-003'
safe_worktree_status /tmp/itotori-spec-univ-003
git worktree remove /tmp/itotori-spec-univ-003
git worktree prune
git branch --delete spec/univ-003
```

For detached audit worktrees:

```sh
safe_worktree_status /tmp/itotori-audit-univ-003-docs
git worktree remove /tmp/itotori-audit-univ-003-docs
git worktree prune
```

For abandoned worker state:

1. Inspect branch, worktree path, status, and commits ahead of its base.
2. If clean and merged, remove the worktree and delete the branch.
3. If dirty or unmerged, record the state in the blocked reason, audit report,
   or issue before assigning cleanup.
4. If the worktree path is gone, run `git worktree prune` and verify the branch
   separately.

Never use forced worktree removal unless a durable record confirms the branch is
merged or intentionally abandoned and no useful untracked files remain.

## Manual Dry-Run

Use this non-destructive dry-run before assigning or merging a spec:

```sh
just roadmap-ready
node scripts/spec-dag.mjs show UNIV-003
git branch --list 'spec/univ-003'
git worktree list --porcelain
git -C /tmp/itotori-spec-univ-003 branch --show-current
safe_worktree_status /tmp/itotori-spec-univ-003
safe_worktree_diff_names /tmp/itotori-spec-univ-003 main...spec/univ-003
```

The dry-run passes when the node state, branch name, worktree path, status, and
diff all match the intended lifecycle step, and no hidden or untracked state is
needed to explain the result.
