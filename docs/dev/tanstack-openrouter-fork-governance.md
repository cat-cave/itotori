# TanStack AI / OpenRouter SDK temporary-pin governance

Status: canonical record of the coordinated, **temporary** pin of the
TanStack AI packages and the transitive `@openrouter/sdk`. This documents
exactly what is pinned, why the pin diverges from upstream's declared
dependency, the provenance + license of each pinned artefact, and the two
procedures that retire this doc: the **rebase-onto-upstream** procedure and
the **upstream-EXIT** procedure (drop the fork when upstream served-pair
support lands in a release whose declared `@openrouter/sdk` range covers a
current GA).

This is the JS-side counterpart to [`dependency-policy.md`](dependency-policy.md)
(Cargo `cargo-deny` strictness) and follows the same lockfile rules recorded
in [`toolchain-policy.md`](toolchain-policy.md) §Lockfile Rules (lockfiles
committed; CI installs with `pnpm install --frozen-lockfile`).

Machine-readable source of truth for the exact versions / integrity hashes /
publish commits: [`scripts/lint/tanstack-openrouter-pin.json`](../../scripts/lint/tanstack-openrouter-pin.json).
CI enforces it via `node scripts/assert-tanstack-openrouter-pin.mjs` (wired into
`just check` and `just ci-tier0-meta`). The coordinated-pin changeset lives at
[`.changeset/pin-tanstack-openrouter-fork.md`](../../.changeset/pin-tanstack-openrouter-fork.md).

## §1 — What is pinned

The itotori app (`apps/itotori`) holds three coordinated third-party packages
at **exact** version specifiers (no `^`/`~` ranges), and a root `pnpm.overrides`
entry forces a single `@openrouter/sdk` version across the whole tree:

| Surface                   | Pinned version | Where the pin lives                                                              |
| ------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `@tanstack/ai`            | `0.40.0`       | `apps/itotori/package.json` `dependencies` (exact)                               |
| `@tanstack/ai-openrouter` | `0.15.8`       | `apps/itotori/package.json` `dependencies` (exact)                               |
| `@openrouter/sdk`         | `0.13.55`      | `apps/itotori/package.json` `dependencies` (exact) **and** root `pnpm.overrides` |

The root override (`package.json`):

```json
"pnpm": {
  "overrides": {
    "@openrouter/sdk": "0.13.55"
  }
}
```

### §1.1 — The override IS the temporary fork

`@tanstack/ai-openrouter@0.15.8` declares its own dependency as
`@openrouter/sdk: "0.13.20"` — a hard-pinned, **stale** exact version. Left
uncontrolled, the tree would resolve that old `0.13.20` transitively under
`@tanstack/ai-openrouter`. The root `pnpm.overrides` entry force-resolves
**every** `@openrouter/sdk` in the graph to the current GA `0.13.55`, so the
whole workspace consumes a single, modern SDK.

That forced divergence — "we run `@tanstack/ai-openrouter@0.15.8` against a
newer `@openrouter/sdk` than it declares" — is the **temporary fork** this
document governs. It exists because `@tanstack/ai-openrouter` 0.15.x's served-
pair streaming support is not yet the integration model itotori needs; the
upstream work that makes the override unnecessary is tracked separately as the
served-pair support land. This pin + lockfile lets every clean worktree build
offline against the pinned set without waiting on that upstream merge.

## §2 — Provenance (exact version, integrity, commit, license)

Every pin is a published npm tarball. For a published package the
content-addressed pin is the **exact version + the lockfile integrity hash**;
the git commit is recorded below for human/audit traceability (it is the commit
the version's release tag dereferences to, resolved live from each source repo).
Integrity hashes are copied verbatim from `pnpm-lock.yaml` and mirrored in the
pin JSON.

| Package + pinned version         | `pnpm-lock.yaml` integrity (`sha512`)                                                             | Source repo                                | License    | Release tag → publish commit                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| `@tanstack/ai@0.40.0`            | `sha512-7942RQkjHccHRL9lTuqAjcgt5z+281HJEvWSSEIX9ZDgntSj5Xt9cOK8SL5tXtGrjj2ZpGnzaFdog5lE4QD07A==` | `github.com/TanStack/ai`                   | MIT        | `@tanstack/ai@0.40.0` → `e3de949575eac8301c0449afa3a91ef450e9580b`            |
| `@tanstack/ai-openrouter@0.15.8` | `sha512-kSAb6p/j+79z2xLxUwNoPUJia6/3QHnsCajz2BDr04a6EBWJwYPi1fPGg3df433HtXXMHaC+yxzuN8YVcedBxw==` | `github.com/TanStack/ai` (same monorepo)   | MIT        | `@tanstack/ai-openrouter@0.15.8` → `e3de949575eac8301c0449afa3a91ef450e9580b` |
| `@openrouter/sdk@0.13.55`        | `sha512-m7knLzfCJrrBfid01D64u+Xv5yrie8nWGpLLBEH7IQGKKX+MYGzfkMY0W5u7UUqtuZCKUB52F9hTlNXl3wJg9g==` | `github.com/OpenRouterTeam/typescript-sdk` | Apache-2.0 | `v0.13.55` → `36837019ea5bf171a8fd5eb0466807f6ace684bf`                       |

Notes:

- Both TanStack packages publish from the **same monorepo commit**
  (`e3de949575eac8301c0449afa3a91ef450e9580b`); `@tanstack/ai` and
  `@tanstack/ai-openrouter` are workspaces in one repo, so the two release
  tags dereference to one commit.
- The `@openrouter/sdk` publish commit equals the npm `gitHead` field for
  `0.13.55` and equals the commit the `v0.13.55` tag points at — they agree.
- These three commit hashes were resolved live from each repo's refs
  (`git ls-remote --tags <repo>`); they are read, not invented. npm does not
  embed `gitHead` for the TanStack packages, so the tag-deref commit is the
  authoritative provenance for those two.

### §2.1 — License compatibility

MIT (`@tanstack/ai`, `@tanstack/ai-openrouter`) and Apache-2.0
(`@openrouter/sdk`) are both permissive OSI licenses and are mutually
compatible; both permit the use/distribution/redistribution itotori requires.
No copyleft, no added-compatibility constraint. (Full license texts ship inside
each installed package under `node_modules/.../`; this doc records the SPDX
identifier only.)

## §3 — Determinism proof (offline resolution to ONLY the pinned set)

The bar is that a clean worktree installs **only** the pinned versions with no
network and no upstream merge. Verify on a fresh worktree:

```sh
direnv exec . just worktree-setup          # offline install from the shared store
corepack pnpm install --frozen-lockfile   # must exit 0; 0 downloads
node scripts/assert-tanstack-openrouter-pin.mjs
ls node_modules/.pnpm | grep -E '^@tanstack\+ai@|^@tanstack\+ai-openrouter@|^@openrouter\+sdk@'
# expected: exactly one line each — @tanstack+ai@0.40.0,
# @tanstack+ai-openrouter@0.15.8_@tanstack+ai@0.40.0, @openrouter+sdk@0.13.55
```

`--frozen-lockfile` must resolve from the pnpm store with **0 downloads**.
`.pnpm` must contain exactly one `@tanstack/ai@0.40.0`, one
`@tanstack/ai-openrouter@0.15.8(@tanstack/ai@0.40.0)`, and one
`@openrouter/sdk@0.13.55`. No second SDK version leaks in: the override wins, so
the `0.13.20` that `@tanstack/ai-openrouter` declares is **not** materialised.

If `--frozen-lockfile` ever reports a mismatch, the manifests and
`pnpm-lock.yaml` have drifted apart — do not relax to a non-frozen install;
reconcile the pin per §5/§6 instead.

## §4 — Why temporary (exit criteria)

This pin is a holding pattern, not a destination. It is retired when **any** of
the following becomes true, in priority order:

1. **Upstream served-pair support lands** — TanStack ships served-pair support in
   `@tanstack/ai-openrouter` that matches itotori's integration model, AND a
   new `@tanstack/ai-openrouter` release declares a `@openrouter/sdk` range
   that covers a current GA (so the override is no longer load-bearing). This
   is the primary exit; run §6 (upstream-EXIT).
2. **The override can be dropped without behaviour change** — a newer
   `@tanstack/ai-openrouter` declares `@openrouter/sdk` at/above `0.13.55`
   natively. Then §6 step 2 simply removes the override.

Until then, do **not** bump any of the three pins in isolation: the override
diverges from `@tanstack/ai-openrouter`'s declared `0.13.20` on purpose, and
the two TanStack packages must move together (the openrouter adapter
peer-depends `@tanstack/ai@^0.40.0`).

## §5 — Rebase-onto-upstream procedure (sync to a newer coordinated set)

When re-evaluating the pin (e.g. upstream lands a candidate, or a routine
security review wants a newer SDK), re-pin all three as a **coordinated set**,
never singly:

1. **Read the actual latest GA**, do not guess:
   ```sh
   npm view @tanstack/ai dist-tags --json
   npm view @tanstack/ai-openrouter dist-tags --json
   npm view @openrouter/sdk dist-tags --json
   ```
2. **Pick a coordinated triple** where `@tanstack/ai-openrouter@X` peer-depends
   `@tanstack/ai@^Y` and the chosen `@tanstack/ai@Y` satisfies it; pick a
   `@openrouter/sdk@Z` that is `>=` whatever the new adapter declares (so the
   override can be weakened or removed).
3. **Update the pin sites together**:
   - `apps/itotori/package.json` (`@tanstack/ai`, `@tanstack/ai-openrouter`,
     `@openrouter/sdk`)
   - root `pnpm.overrides` `@openrouter/sdk`
   - `scripts/lint/tanstack-openrouter-pin.json` (versions, integrity, commits)
   - `.changeset/` entry describing the re-pin
4. **Regenerate the lockfile** from a network-enabled shell, then prove the
   offline resolve:
   ```sh
   corepack pnpm install          # network: refresh lockfile to the new triple
   corepack pnpm install --frozen-lockfile   # offline proof: exit 0, 0 downloads
   node scripts/assert-tanstack-openrouter-pin.mjs
   ```
5. **Re-record provenance** in §2 and the pin JSON (integrity hashes from the
   new `pnpm-lock.yaml`; commit hashes via `git ls-remote --tags` on each repo).
6. **Verify the app**: `pnpm --filter @itotori/app typecheck` and the itotori
   LLM-layer test suite (the dispatch/physical-step paths that consume
   `@tanstack/ai` + `@tanstack/ai-openrouter`), since SDK/adapter behaviour is
   where a silent break hides.
7. Keep `pnpm install --frozen-lockfile` green on CI before merging.

## §6 — Upstream-EXIT procedure (drop the fork)

When a coordinated upstream release removes the need for the override:

1. Confirm exit criteria §4.1/§4.2 are honestly met (upstream adapter declares a
   `@openrouter/sdk` range covering a current GA; served-pair model matches
   itotori's).
2. **Remove the root override**:
   ```diff
   -  "pnpm": {
   -    "overrides": {
   -      "@openrouter/sdk": "0.13.55"
   -    }
   -  }
   ```
   (If `engines`/other `pnpm` fields exist, delete only the `overrides` block.)
3. **Re-pin to the upstream-coordinated triple** per §5 steps 1–4; the
   `@openrouter/sdk` in `apps/itotori/package.json` should now match what the
   adapter declares natively (the override's job is done).
4. **Delete this doc, its `docs/dev/README.md` index entry, the pin JSON, the
   assert script + test, the justfile wiring, and the `.changeset` pin entry** —
   once the temporary fork is gone, the governance record is stale-on-write and
   should not remain (provenance belongs in git history + the PR description).
5. Verify: `corepack pnpm install --frozen-lockfile` exit 0; the itotori
   typecheck + LLM-layer tests green; the CI meta-guards
   (`audit-no-node-ids`, `file-line-cap-guard`, `audit-deletion-ledger`) green.

## §7 — Scope and non-goals

- This doc governs the **JS dependency pins only**. The OpenRouter **API**
  wiring posture (ZDR, provider routing, cost contract) is documented
  separately in [`../openrouter-integration.md`](../openrouter-integration.md)
  and is unaffected by how the SDK npm package is pinned.
- A changeset **is** recorded under [`.changeset/`](../../.changeset/) for this
  pin (see README there). The monorepo does not run `@changesets/cli` today;
  product versioning still follows
  [`versioning-and-release-policy.md`](../versioning-and-release-policy.md).
- This doc does **not** convert the pins to `git+commit` dependencies. For a
  published npm package the idiomatic, offline-resolvable, content-addressed
  pin is the exact version specifier + the lockfile integrity hash (the
  mechanism `toolchain-policy.md` §Lockfile Rules already mandates); a git-ref
  dependency would break `--frozen-lockfile` offline resolution and cannot
  address a monorepo workspace subpackage tarball. The commit hashes in §2 are
  provenance for auditors, not install sources.
