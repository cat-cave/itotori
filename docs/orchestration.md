# Orchestrator Playbook

This is the authoritative playbook for the central orchestrator. `qd method
show` points here. The command examples were checked against qdcli 0.4.1;
when an installed CLI disagrees, its help text is the authority.

Related references:

- [operating model](dev/orchestration-operating-model.md) for project policy;
- [worktree lifecycle](dev/worktree-lifecycle.md) for isolation and setup;
- [DAG contract](dev/spec-dag.md) for export and validation;
- [audit playbook](dev/audit-playbook.md) for review quality;
- [delegate reference](orchestration-delegation.md) for worker selection and
  shell-agent invocation.

## Landing rule

`main` is protected and uses GitHub's native merge queue. The only landing
path is:

```text
pull request → native merge queue → gh pr merge --auto
```

Do not push or cherry-pick directly to `main`.

After opening a ready pull request, enable auto-merge:

```sh
gh pr merge --auto
```

When the work item is mergeable, have qd record and reconcile the same queue:

```sh
qd merge <node> --enqueue
# With mergeQueueMode=auto, this also enters a required native queue:
qd merge <node> --via-pr
qd sync-prs
```

`qd merge --use-existing-commit <sha>` only reconciles a commit that has
already landed; it does not merge a pull request.

Check actual queue membership, not merely auto-merge. `autoMergeRequest` is
only a flag and can be null while a pull request is queued. `BEHIND` usually
means the queue is rebuilding against newer `main`, not that a rebase is
needed. Query `isInMergeQueue` and `mergeQueueEntry` when diagnosing state:

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
  }' -f owner=<owner> -f name=<repo> -F number=<number>
```

## qd lifecycle

qd is the state ledger; GitHub performs the merge. Only the orchestrator runs
qd, from the main checkout. A worker worktree must never become a second
ledger.

Start each session by acknowledging the active method before any mutation:

```sh
qd method acknowledge --agent <name>
qd doctor --json
qd status --json
qd ready --json
```

For each node, follow this order:

1. Claim it: `qd claim <node> --agent <name> [--branch <branch>] [--pr <number>]`.
2. Create a dedicated worktree outside the repository; see the lifecycle doc.
   Do not use qd's default in-repository worktree location.
3. Delegate or implement. Workers do not run qd.
4. Complete from evidence, never a hand-written summary:

   ```sh
   qd template completion-report > /tmp/<node>-completion.json
   qd complete <node> --from-report /tmp/<node>-completion.json
   ```

5. Run an independent audit and include evidence for every finding:

   ```sh
   qd audit start <node>
   qd template audit-report > /tmp/<node>-audit.json
   qd audit pass <node> --from-report /tmp/<node>-audit.json
   ```

6. Sign off each declared verification item:

   ```sh
   qd verification sign-off <node> --index <n> --note <text> [--evidence <path>]
   # or: qd verification sign-off <node> --all --from-report <json>
   ```

7. Record trusted CI only after audit and verification:

   ```sh
   qd ci record-pass <node> --summary <text> \
     (--log-path <path>|--url <url>|--external-id <id>)
   ```

8. Enqueue it, then reconcile the queue-produced SHA with `qd sync-prs`.
9. Export from the main checkout and validate the committed graph:

   ```sh
   qd export --out roadmap/spec-dag.json --deterministic
   node scripts/spec-dag.mjs validate
   ```

The policy gates audit and verification before CI, and CI before merge. Do not
reorder them. qd 0.4.x exports `schema_version` 3; this repository's validator
accepts versions 1, 2, and 3.

Useful queue commands are:

```sh
qd queue enqueue <node>|--all-ready [--wave <id>] [--limit <n>] [--concurrency <n>]
qd queue status [node] [--json]
qd queue sync [node] [--json]
qd queue watch <node>|drain [--interval 10] [--timeout 3600]
qd queue bisect <node>|--merge-group <sha> [--json]
```

## Worktree discipline

Fetch and fast-forward the main checkout before branching or reviewing:

```sh
MAIN=<main-checkout>
git -C "$MAIN" fetch origin
git -C "$MAIN" checkout main
git -C "$MAIN" pull --ff-only origin main
test "$(git -C "$MAIN" rev-parse main)" = "$(git -C "$MAIN" rev-parse origin/main)"
```

Create worker worktrees under `/scratch/worktrees/itotori-<slug>`. Each needs
its own `CARGO_TARGET_DIR`; the dev shell configures that automatically. In a
fresh worktree, run this once before formatter or fixture commands:

```sh
just worktree-setup
```

If a worker ran qd in its worktree without `QD_ROOT`, it may have created an
empty local ledger. Do not use it. Run qd from the main checkout, or explicitly
point it at the main checkout with `qd --root <main-checkout> …`.

## Evidence and audit discipline

Per-gate CI is mostly synthetic. A green `just ci public` or pull-request tier does
not prove behavior on private bytes. The periodic ground-truth lane is
`just test real-bytes-oracle`; see [the oracle guide](real-bytes-periodic-oracle.md).

Before accepting a runtime, byte, or visual claim, require the actual evidence
path and inspect it. Treat a successful command that ran zero tests as a
failure to investigate first, not as coverage. A local CI log containing
`pg_isready` errors despite exit status zero is untrustworthy; rerun it cleanly
or use the pull-request checks.

Audits use a different model than the implementer, start from refutation, and
place evidence on every finding. For fidelity or browser claims, inspect the
runtime artifact rather than accepting prose alone.

## External pull requests

External contributors coordinate with issues and pull requests, not qd. The
orchestrator remains the merge authority:

1. List and audit open pull requests: `gh pr list --state open`.
2. Verify their tests and relevant runtime evidence as untrusted input.
3. Link a matching node with `qd node set-pr <node> <number>` and record a
   partial resolution as `qd note add <node> --text <text>`.
4. Apply the normal complete → audit → verification → CI → queue flow.

For new work, use `qd nodes add-bulk --from-json <plan.json>`. It is atomic and
idempotent: an exact retry reports existing nodes, while a conflicting node
fails the batch without writing it.

## Quick loop

```text
acknowledge → ready / claim → isolated worktree → implement
  → completion report → independent audit → verification sign-off
  → trusted CI record → native merge queue → sync-prs
  → deterministic export → graph validation
```
