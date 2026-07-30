# CI cache and affected policy

`just check affected` invokes `scripts/affected.mjs`. It inspects the worktree
and prints conservative recommended commands. It is advisory: a clean affected
report never replaces the PR’s required CI lane.

Use it to find a small local loop, then run every command it recommends or a
broader supported lane. The dispatcher owns the command vocabulary:

- `check` selectors include `all`, `meta`, `ts`, `rust`, `fixtures`, `schema`,
  and `affected`.
- `test` selectors include `all`, browser, database, contract, mutation,
  real-byte, ratio, and focused test selectors.
- `ci` selectors include `public`, Tier 0, partitioned Tier 1, and
  the private-real-byte preflight.

Do not create a new `just` recipe to express a one-off combination; add a
validated selector only when it is a durable capability. The `justfile` is a
thin six-recipe delegator by design.

## Cache policy

Vite+ and Cargo caches may reuse deterministic compilation and test work. They
never replace a required command: the command remains the correctness boundary
and must run when its inputs change. Lockfiles are committed; CI installs pnpm
with the frozen lockfile. Build output, task caches, `node_modules`, and Cargo
targets are not committed.

Side-effectful database, artifact-generation, and evidence commands must not
claim a cache hit as proof that their side effect occurred. Their output or
explicit verifier is the evidence.

## Limits

Affected detection is a recommendation based on repository paths and Git state,
not semantic impact analysis. It can over-select and can miss an unmodelled
dependency. Cache correctness is likewise bounded by declared inputs. When the
scope is uncertain, run `just check` and the broader relevant CI lane.
