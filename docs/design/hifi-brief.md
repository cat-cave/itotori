# Itotori design language — studio UI pointer

**Canonical design language:** [`itotori-design-system.md`](./itotori-design-system.md)
(Dusk Observatory tokens, voice, status vocabulary, component inventory). Product
surfaces and routes: [`../frontend.md`](../frontend.md),
[`../itotori-product-workflow.md`](../itotori-product-workflow.md).

## Status

The external hi-fi handoff brief and DesignSync studio mirror are **retired**.
Dashboard / Play / Wiki / Results / Settings screens ship in-tree under
`apps/itotori/src/ui/` on `@itotori/ds` (`packages/itotori-ds/`). Do not restore
the removed `studio/` DesignSync mirror or treat dead epic node families
(`fnd-*`, `shell-*`, `play-*`, …) as an active design backlog.

## Design principles (still load-bearing)

- **Game-agnostic.** A title is config/input, never baked into chrome or fixtures.
- **Evidence-first.** Exact numbers, mono machine-tokens, closed status vocabulary;
  sentence case; icon-light; no emoji; honor `prefers-reduced-motion`.
- **Iteration loop is the spine:** complete patch → play-test evidence → result
  revision or canonical context correction → refinement run → next patch.
- **Imagery = the game itself** (redacted vs full-fidelity is first-class).

## Where to work

| Concern             | Location                                            |
| ------------------- | --------------------------------------------------- |
| Tokens / components | `packages/itotori-ds/` + `itotori-design-system.md` |
| SPA shell + screens | `apps/itotori/src/ui/`                              |
| Typed API client    | `apps/itotori/src/api-client.ts`                    |
| Product workflow    | `docs/itotori-product-workflow.md`                  |
| Permissions         | `docs/permissions.md`                               |

Optional remote design projects (Claude Design) remain a human-owned mockup
surface only; they are **not** a repo mirror or implementation source of truth.
