# Spec DAG

We use **qdcli** for the implementation roadmap. The DAG concepts (node shape,
edges, status/priority, the qd export JSON schema, claim/check/ci/merge
lifecycle, finding promotion) are documented in qdcli's own `docs/llms.md`,
`docs/agents.md`, and its schema/import docs (`docs/import.md`). The
orchestrator operating contract and itotori's DAG quality bars live in
[`orchestration-operating-model.md`](orchestration-operating-model.md). This
page keeps only the itotori-specific roadmap facts.

> **Alpha definition.** The redefined alpha gates live at the top of
> [`project-readiness.md`](project-readiness.md). The alpha gate is that 6-item
> list, not the totality of nodes labelled `ALPHA-*` in the DAG.

## Committed Export And Validation

- The canonical committed roadmap is `roadmap/spec-dag.json` in **qd export
  shape** (`schema_version`, `registries`, `nodes`, `edges`, `findings`, `runs`,
  `node_notes`). qd owns live orchestration state; this file is the generated,
  reviewable export. Do not hand-edit it for lifecycle state, claims, completion,
  or follow-up planning — make DAG changes through qd, then regenerate it:

  ```sh
  qd export --out roadmap/spec-dag.json
  just roadmap-validate
  ```

- `just roadmap-validate` (`node scripts/spec-dag.mjs validate`) is the
  repo-local validator for the committed export: schema version, registries,
  duplicate ids, status/priority shape, placeholder spec/acceptance/audit-focus
  text, edge references, self-edges, and cycles.

- `.qd/config.toml` delegates qd's `check_command` to `just check` and its
  `ci_command` to `just qd-full-ci` (which wraps `just ci` with a
  worktree-scoped disposable Postgres stack). So qd checks, `just check`, and CI
  all include the same roadmap gate.

## Import Mapping

When migrating or rebuilding the qd cache from the committed roadmap, qd reads
the field mapping at `roadmap/qd-import-map.json`:

```sh
qd import --from roadmap/spec-dag.json --schema-mapping roadmap/qd-import-map.json
```

`just qd-import` wraps this and reruns `just roadmap-validate` plus
`qd doctor --json`.

## itotori Registries

itotori-specific values the DAG uses for scheduling and ownership:

- **Projects** (`projects`): `universal`, `shared`, `itotori`, `kaifuu`,
  `utsushi`, `suite`.
- **Targets** (`target`): `baseline`, `alpha`, `continuous`. `target` is the
  delivery horizon; `priority` (P0–P3) is the blocking strength. All non-complete
  P1 alpha nodes must be ancestors of the final alpha-readiness node so the graph
  cannot hide a required blocker off to the side.
- **Parallel groups** (`parallelGroup`) — the itotori scheduler lanes:
  `baseline`, `roadmap-infra`, `tooling`, `contracts`, `quality-foundation`,
  `kaifuu-core`, `itotori-core`, `dashboard`, `policy`, `feedback`, `benchmarks`,
  `catalog`, `qa`, `agent-runtime`, `translation-loop`, `context-agents`,
  `engine-adapters`, `engine-research`, `utsushi-core`, `runtime-adapters`,
  `alpha-integration`, `milestone`. Ready nodes from different lanes are good
  parallel candidates; nodes in the same lane may parallelize only when their
  write sets are disjoint. Add a lane only when it is a meaningful scheduler
  lane, then update the schema and this list.

## GitHub Issue Sync

`node scripts/spec-dag.mjs sync-issues` renders a deterministic GitHub issue
plan from `roadmap/spec-dag.json`. It is non-mutating by default (no GitHub
reads/writes); `--apply` is reserved for a future live writer and currently
refuses safely after validation.

```sh
node scripts/spec-dag.mjs sync-issues --dry-run
node scripts/spec-dag.mjs sync-issues --dry-run --node UNIV-002 --include-body
node scripts/spec-dag.mjs sync-issues --dry-run --existing-issues .tmp/github-issues.json
```

Every rendered body starts with a hidden marker so repeat syncs update the same
issue instead of creating duplicates:

```md
<!-- spec-dag-node: UNIV-002 -->
<!-- spec-dag-sync-version: 1 -->
```

The matcher updates instead of creates when an existing issue has that marker or
a title starting with `[NODE-ID]`. A future live writer must manage only the
`spec-dag` label and labels with the `dag/priority:`, `dag/status:`,
`dag/target:`, `dag/project:`, and `dag/group:` prefixes; human labels outside
that taxonomy must be preserved.
