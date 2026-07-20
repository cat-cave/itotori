# Changesets (dependency-governance records)

This directory records coordinated third-party dependency pins that affect the
shippable app surface. The monorepo does **not** run `@changesets/cli` or
auto-publish workspace packages (internal packages stay private at `0.0.0`;
product versioning is governed by
[`docs/versioning-and-release-policy.md`](../docs/versioning-and-release-policy.md)).

Entries use the standard changesets markdown frontmatter shape so a future
CLI adoption can consume them without rewrite:

```md
---
"@itotori/app": patch
---

Human-readable summary of the pin / dependency change.
```

Each pin that this directory records must also:

1. Update the exact version sites (`apps/itotori/package.json` + any root
   `pnpm.overrides`).
2. Refresh `pnpm-lock.yaml` and prove offline
   `corepack pnpm install --frozen-lockfile`.
3. Keep the matching CI guard green (for the TanStack/OpenRouter set:
   `node scripts/assert-tanstack-openrouter-pin.mjs`).
