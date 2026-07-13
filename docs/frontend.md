# Itotori frontend — SPA, design system, and typed API client

The Itotori frontend is the React Studio surface for one complete localization
cycle:

```
run → complete patch → play → result revision or context correction → refinement run
```

The interface makes quality evidence useful without making it a release gate.
Every in-scope unit has a written result before a patch is emitted; QA findings
are visible annotations on that result. Play-test input changes a result revision
or canonical context, then feeds a deliberate iteration. There is no
per-line gate or parallel handoff path.

## Pieces

- **`@itotori/ds`** (`packages/itotori-ds/`) — the Dusk Observatory design
  system. React components (`Panel`, `Badge`, `DataTable`,
  `ProgressBar`, `ComparisonPane`, `LocalizationProgress`,
  `StatReadout`, `BiText`, `NavPills`, `CommandPalette`,
  `Pagination`, `RedactionFrame`, `ContestantSwatch`, `Toast`, …)
  plus the CSS token set under `tokens/`. The canonical CSS entry is
  `@itotori/ds/styles.css`, consumed once at the SPA shell. `Pagination`
  is bound to the typed client's server-side `OffsetPager`; redaction is on
  by default for committed or shared runtime evidence, and capability-gated
  reveal is local only. See
  [`packages/itotori-ds/README.md`](../packages/itotori-ds/README.md) for
  the component conventions.
- **Typed API client — `fnd-api-client`**
  (`apps/itotori/src/api-client.ts`). A framework-agnostic typed client
  generated from `api-schema.ts` (route, request, response, and error
  types) and `api-contract.ts` (the method/path registry). Every response is
  validated by the same `assertItotoriApiResponse` guard used by the server
  and contract harness. `query()` exposes a stateful `ApiResource`;
  `request()` settles into `ready | empty | error`; and the React-facing
  state union is `loading | ready | empty | error`.
- **React app shell — `fnd-spa-shell`** (`apps/itotori/src/ui/`). The
  single SPA served by `apps/itotori/src/server.ts`:
  - `App.tsx` routes one Studio surface at a time, while the persistent shell
    keeps project/branch, ZDR, source-to-branch, and live-cost context visible.
  - `client.ts` owns the shared `ItotoriApiClient`; screens use a relative
    base URL and therefore stay on the served origin.
  - `use-api-resource.ts` adapts `ApiResource` with
    `useSyncExternalStore`, so a screen rerenders on its data transition and
    reissues a query when its dependency key changes.
  - `screens/` contains the overview/run instruments, Play and patch
    iteration, direct result comparison and revision, context-correction and
    feedback composition, wiki, benchmark, runtime evidence, catalog, and
    settings surfaces. `ComparisonPane`/`BiText` make source, selected
    result, history, and QA annotations inspectable; the edit action records a
    result revision, while an explanation or missing-fact action records a
    context correction.
  - `addressable-routing.ts` provides stable deep links for `unit`,
    `scene`, `route`, `character`, `term`, `run`, and `finding`.
    A link can move from a play observation to the precise result, wiki entry,
    or runtime artifact without losing project and branch scope.

## The Studio workflow

The primary navigation is organized around the durable identity chain:

| Surface           | What it changes or shows                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Runs              | Frozen scope, progress, cost, written-outcome coverage, and operational pause/resume state |
| Patches / Play    | A concrete patch version, runtime evidence, QA callouts, and play-test observations        |
| Results           | Source/target comparison, candidate history, annotations, and direct result revision       |
| Wiki              | Versioned canonical facts, glossary, speaker, scene, and style context                     |
| Feedback / Refine | Context corrections, imported feedback, affected scope, and the next refinement run        |
| Settings          | Routing, scope, privacy, project, and account configuration                                |

An edit is never merely a UI acknowledgement. A target-text change creates a
result revision and a deterministic child patch revision. A factual correction,
glossary change, or wiki edit writes canonical context and determines affected
units for the next refinement run. Notes and runtime observations retain their
evidence and become those concrete changes when acted on.

## Screen contract

Every screen reads `/api/*` through `ItotoriApiClient`, never an ad-hoc
`fetch`. That keeps request/response validation, pagination, and the
`loading | ready | empty | error` contract consistent across the app.

A screen that mutates localization data must make its durable effect explicit:

- a target-text edit writes a result revision;
- a factual, terminology, or scene correction writes canonical context;
- a feedback batch starts a refinement run from a frozen base patch and context
  heads;
- a read-only evidence action does not claim to have changed localization data.

QA findings, confidence, and contested checks remain readable in Play and
Results. They inform the next revision or context change but do not suppress a
written in-scope result or make an incomplete patch look complete.

## Patterns every downstream screen inherits

1. **className-based styling, CSS ships separately.** Components render
   semantic DOM with `itotori-*` classes; visual truth lives in the DS token
   set and co-located component CSS. No CSS-in-JS or CSS modules.
2. **Type-safe API access through `useApiQuery`.** Never use an ad-hoc
   `fetch`; let the typed client and discriminated state union narrow data and
   errors.
3. **Status is a closed vocabulary → derived tone.** Pass product status to
   `<Badge status={…} />` or `statusTone(…)`; never choose a badge color by
   hand.
4. **Tokens, never literals.** Reference `--ito-*` variables; never inline a
   hex color.
5. **Behaviour-first tests.** Render a screen with Testing Library and assert
   observable DOM and interactions rather than component internals.
6. **Redaction is a toggle, default-on.** Sensitive runtime evidence is
   wrapped in `<RedactionFrame sensitive>`. `canReveal` is the
   capability-gated local authority; share/export mode always restores the
   blur.
7. **Pagination is bound to the typed client.** Server-paginated surfaces use
   the api-schema pagination shape through `OffsetPager`; the DS
   `Pagination` component keeps real, accessible previous/next buttons at
   bounds.
