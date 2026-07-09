# Design-system component parity notes

Node: `ds-port-component-library`

Reference used in this worktree: `docs/design/itotori-design-system.md`, which
is the version-controlled distillation of the Claude Design project
`428be6c4-a1db-41d2-954f-b50ff2e38353`.

## Reality / research gap

The live Claude Design project was not reachable from the tools available in
this execution: no DesignSync MCP or `/design-sync` skill surface was exposed in
the session, and no `/design-login` credential flow is available here. This port
therefore does **not** claim byte-for-byte parity with the design project's
per-component `.jsx`, `.d.ts`, `.prompt.md`, or `.card.html` files. It claims
repo-level parity against the versioned design reference and records the exact
places that need a future live DesignSync audit.

## Ported component vocabulary

- `Badge`: closed status vocabulary maps to three-tone status tokens via
  `statusTone`.
- `Panel`: VN config-menu window chrome, title tick, lamps slot, and data/ARIA
  passthrough.
- `DataTable`: hairline-divider grid table with caption, empty state, keyboard
  row activation, and row-key contract.
- `ProgressBar` / `LocalizationProgress` / `StatReadout`: progress evidence
  readouts with sourced values and reduced-motion-safe styling.
- `ComparisonPane` / `BiText`: source-first source-to-draft comparison and
  bilingual reading surface with copy affordance.
- `CommandPalette` / `NavPills` / `Pagination`: navigation primitives used by
  the shell, wiki, and paginated surfaces.
- `AnnotationComposer`: note-to-review form with a dedicated severity token
  ramp.
- `RouteMap`: route/choice diagram surface using diagram tokens.
- `ScenePlayer`: reusable game-agnostic VN player shell for play/review modes;
  host owns frames, runtime state, and navigation behavior.
- `WikiEntry`: reusable profile shell for character/term/scene/source-unit
  wiki entries; host owns read-model content and addressable links.
- `Toast`, `ContestantSwatch`, and `RedactionFrame`: shipped support primitives
  required by current Studio surfaces.

## Surface consumption

- Review/detail surface consumes `Panel`, `Badge`, `BiText`, `ComparisonPane`,
  `DataTable`, `Pagination`, `StatReadout`, and `RuntimeEvidencePanel`'s DS
  primitives.
- Workspace comparison now consumes `BiText` and `ComparisonPane` instead of
  hand-rendered comparison cells, while retaining the runtime-evidence
  `DataTable`.
- Progress/overview consumes `LocalizationProgress`, `Panel`, and `StatReadout`
  through `ProgressInstrumentPanel`.
- Wiki consumes `WikiEntry` for profile chrome while preserving the existing
  `DataTable`, `BiText`, and cross-reference links.

## Known deltas pending live DesignSync audit

- Exact per-component prop names may differ from the live `.d.ts` files. The
  repo port keeps host-owned API calls and read-model fields outside DS
  components; a live sync should retarget names only when it does not introduce
  product coupling.
- Exact card/demo layout spacing may differ from the live `.card.html` demos.
  The current CSS follows the token values in `docs/design/itotori-design-system.md`.
- The repo token layer now includes the semantic groups that were previously
  tracked in `MISSING-TOKENS.md` (`cost`, `privacy posture`, `render overlay`,
  `redaction`, `contestant`, `severity`, `pass iteration`, and `locale branch`
  identity). A future live DesignSync audit may still retarget exact values, but
  hi-fi and port work no longer need placeholder colours for those semantics.
- Fonts remain host-provided. The package declares font stacks but does not ship
  Google Fonts, matching `README.md`.
