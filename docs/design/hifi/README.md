# Itotori Studio hi-fi — design ↔ repo alignment

The **hi-fi mockup** of the Itotori Studio UI lives in the Claude Design project
**"Itotori repository"** (`claude.ai/design`, project id
`93c04f61-7707-4b94-95c0-079e5875f8c2`, owner Trevor). It designs the layout,
workflow, cross-surface interaction, and cohesion of the product — the destination
for the (now-ported React SPA) Studio screens.

It builds on the **Itotori Design System** project
(`428be6c4-a1db-41d2-954f-b50ff2e38353`, embedded here as `studio/_ds/…`) — see
`docs/design/itotori-design-system.md` for the distilled design language.

## What's mirrored here

`studio/` mirrors the design project's studio screens for design↔repo alignment:

- `studio/store.jsx` — the studio store: the human-in-the-loop workflow model
  (playtester **flags** → reviewer **decides** → corrections **queue** → director
  **launches** a pass → benchmark **re-scores** → **confidence** moves) + the
  identity/**capability** model (`canFlag`/`canDecide`/`canSteer`/`canReveal` gate
  actions + redaction). Note: it gates on **capabilities (permissions), not roles**.
- `studio/data.js` — the fixture data model: the game-agnostic
  **org → work → edition → project → locale-branch** hierarchy and every surface's
  entities (review queue, pass ledger, cost/ZDR, jobs, routes/scenes, runtime
  evidence, benchmark/contestants, wiki, members, project settings, catalog).
- Screens (`OverviewScreen`, `PlayScreen`, `ReviewScreen`, `WikiScreen`,
  `MembersScreen`, `NewProjectScreen`, `SettingsScreen`, `Shell`, `SceneStage`,
  `app.jsx`) — the layouts. These are synced verbatim; **do not hand-edit** —
  edit in the design project and re-sync, or edit here and push, via the DesignSync
  MCP.

## Keeping them aligned

The mockup (remote) and this mirror (local) are kept aligned via the **DesignSync
MCP** (`https://api.anthropic.com/v1/design/mcp`, auth via `/design-login`) and the
**`/design-sync` skill**:

- **Pull** (remote → local): `get_file` / `list_files` on project `93c04f61…`
  → write under `studio/`. (The `/design-sync` skill automates a full sync; it is
  model-invocation-disabled, so a human runs it — `/design-sync`.)
- **Push** (local → remote): `write_files` back to the project after a repo-side
  change we want reflected in the mockup.

Whenever we change the mockup or the repo implementation, re-sync so both agree.
The design system (`428be6c4…`) is synced separately (its distilled reference is
`docs/design/itotori-design-system.md`).

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
  **`fnd-spa-shell`** React app shell (`apps/itotori/src/ui/`) replaced the
  deleted HTML-string `dashboard.ts` / `reviewer/detail-view.ts` /
  `workspace/view.ts` renderers with React screens composing
  `useApiQuery` + `@itotori/ds`. Addressable-id routing and the capability
  context also shipped. The deleted string renderers are NOT in the tree
  (`dashboard.ts` was deleted by `fnd-spa-shell`; downstream screens parity-port
  from the deleted originals). Remaining work is the ~50 screen nodes that
  inherit this foundation.
- **Highest-leverage first surface: Review** — its backend is complete end-to-end,
  and building it forces the whole foundation into existence for every other surface.
- **Org / multi-user / Members** is owned by the **auth epic** (`auth-*` nodes);
  the hi-fi Members/Shell-org-switch surfaces consume it (permission-based, no roles
  — see `docs/permissions.md`).
- Read-models to compose (backend exists, no route): overview aggregate, jobs
  run-table, wiki, benchmark cockpit (from a **persisted** run table), settings.
- Play's live render rides an interim captured-frame filmstrip in alpha; the full
  Utsushi embedded render is the beta long pole.

Everything is **game-agnostic** — a specific title is config, never baked in.
