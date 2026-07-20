---
"@itotori/app": patch
---

Pin and govern the temporary TanStack AI / OpenRouter SDK coordinated set:

- `@tanstack/ai@0.40.0` (publish commit `e3de949575eac8301c0449afa3a91ef450e9580b`, MIT)
- `@tanstack/ai-openrouter@0.15.8` (same monorepo commit, MIT)
- `@openrouter/sdk@0.13.55` (publish commit `36837019ea5bf171a8fd5eb0466807f6ace684bf`, Apache-2.0)

The temporary fork is the root `pnpm.overrides` force of `@openrouter/sdk` to
`0.13.55` while the adapter still declares exact `0.13.20`. Exact versions +
lockfile integrity hashes are the content-addressed pin; publish commits are
audit provenance. Guarded by `scripts/assert-tanstack-openrouter-pin.mjs` and
documented in `docs/dev/tanstack-openrouter-fork-governance.md` (rebase +
upstream-exit procedures).
