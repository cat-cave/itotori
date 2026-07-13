# Itotori Studio hi-fi — design ↔ repo alignment

The **hi-fi mockup** of the Itotori Studio UI lives in the Claude Design project
**"Itotori repository"** (`claude.ai/design`, project id
`93c04f61-7707-4b94-95c0-079e5875f8c2`, owner Trevor). It designs the layout,
workflow, cross-surface interaction, and cohesion of the product — the destination
for the (now-ported React SPA) Studio screens.

It builds on the **Itotori Design System** project
(`428be6c4-a1db-41d2-954f-b50ff2e38353`) — see
`docs/design/itotori-design-system.md` for the distilled design language.

## Current design alignment

The former `studio/` DesignSync mirror has been removed. It modeled a retired
per-unit handoff workflow and therefore cannot serve as a current product
reference. Do not restore it as a compatibility mockup or use it to derive
screens, fixtures, or API contracts.

The current design contract is the durable iteration loop:

```text
complete patch → play-test evidence → result revision or canonical context correction
  → refinement run → next complete patch
```

Use [`../hifi-brief.md`](../hifi-brief.md),
[`../../itotori-product-workflow.md`](../../itotori-product-workflow.md), and
[`../../frontend.md`](../../frontend.md) as the product references. The remote
DesignSync project must be revised to this contract before its screens are
synced back into the repository.

## Future synchronization

When design work resumes, use the **DesignSync MCP**
(`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`) and the
**`/design-sync` skill** only after the remote project reflects the current
result-revision/context-correction/iteration contract:

- **Pull** (remote → local): `get_file` / `list_files` on project `93c04f61…`
  → write only a current design mirror. (The `/design-sync` skill automates a
  full sync; it is model-invocation-disabled, so a human runs it —
  `/design-sync`.)
- **Push** (local → remote): `write_files` after a repo-side product change we
  want reflected in the mockup.

Whenever we change the mockup or the repo implementation, re-sync so both
agree. The design system (`428be6c4…`) is synced separately (its distilled
reference is `docs/design/itotori-design-system.md`).

## Implementation

The mockup's features are decomposed into the **hi-fi Studio epic** in
`roadmap/spec-dag.json` (nodes: `fnd-*` foundation, then `shell-*`, `ovw-*`,
`play-*`, `rev-*`, `wiki-*`, `mem-*`, `np-*`, `set-*`, `xs-*`, `bmk-*`).

Key facts from the analysis (2026-07-06), updated to reflect the
foundation landing:

- The **backend is far more built than the mockup implies** (~90 Postgres tables,
  ~32 API routes). The foundation track landed end-to-end: the **Dusk Observatory
  design system** (`@itotori/ds` at `packages/itotori-ds/`) ported the design
  language into React + CSS tokens; the **`fnd-api-client`** typed API client
  (`apps/itotori/src/api-client.ts`) drives the SPA off the existing `/api/*`
  routes with discriminated `loading | ready | empty | error` states; and the
  **`fnd-spa-shell`** React app shell (`apps/itotori/src/ui/`) serves React
  screens composing `useApiQuery` + `@itotori/ds`. Addressable-id routing and
  the capability context also shipped. Remaining work is the screen set that
  inherits this foundation.
- **Highest-leverage surfaces: Play, Results, Wiki, and Feedback / Refine.** They
  make the complete-patch → evidence → durable change → refinement loop visible
  without a parallel handoff workflow.
- **Org / multi-user / Members** is owned by the **auth epic** (`auth-*` nodes);
  the hi-fi Members/Shell-org-switch surfaces consume it (permission-based, no roles
  — see `docs/permissions.md`).
- Read-models to compose (backend exists, no route): overview aggregate, jobs
  run-table, wiki, benchmark cockpit (from a **persisted** run table), settings.
- Play's live render rides an interim captured-frame filmstrip in alpha; the full
  Utsushi embedded render is the beta long pole.

Everything is **game-agnostic** — a specific title is config, never baked in.
