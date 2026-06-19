# @itotori/spec-dag-dashboard

Generates a self-contained, browsable dashboard for `roadmap/spec-dag.json`.

The dashboard renders the spec DAG as an interactive graph with a filterable
node list, lineage tracing, a per-node detail slideout, a "copy for agent"
block, and a validation-issues modal. It reuses the repo's canonical
`loadDag()` / `validateDag()` (from `scripts/spec-dag.mjs`) so "what's off"
matches the validator exactly — there is no second, drifting rule set.

## Usage

```sh
just roadmap-dashboard          # build + regenerate + open in browser
just roadmap-dashboard-watch    # build + watch roadmap/spec-dag.json, regenerate on change

# or directly:
pnpm --filter @itotori/spec-dag-dashboard build
node packages/spec-dag-dashboard/dist/cli.js            # regenerate + open
node packages/spec-dag-dashboard/dist/cli.js --no-open  # regenerate only
node packages/spec-dag-dashboard/dist/cli.js --watch    # watch + regenerate
```

The page is written to the gitignored `.tmp/dag-dashboard.html`.

## Provenance banner

The topbar shows a provenance banner derived from local git state (no network):

- `✓ <sha> · generated <relative time>` when current.
- A prominent red warning when the tree is behind `origin/main` and/or dirty,
  always telling you to re-run the generator (`just roadmap-dashboard`).
- A neutral `origin/main unknown locally — run git fetch` when `origin/main`
  is not known locally.

## Architecture

- `dag-loader.ts` — the only module that touches the untyped `spec-dag.mjs`.
- `enrich.ts` — pure: error attribution, dependents, readiness, blockers,
  counts, sort order.
- `provenance.ts` — pure parsers + a single impure local-git collector.
- `render.ts` — pure HTML renderer (style/markup copied from the reference).
- `client/main.ts` — the browser app, bundled with esbuild.
- `generate.ts` / `cli.ts` — orchestration and the WSL2-aware open helper.
