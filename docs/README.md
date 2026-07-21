# Itotori Docs

> **Alpha definition (2026-06-24).** The **live cold-start orientation** for
> the monorepo lives in [`docs/dev/spec-dag.md`](dev/spec-dag.md) (the
> committed `roadmap/spec-dag.json` is the source of truth — it is what the
> `qd` CLI and the readiness checklists query). The redefined alpha gates live at the
> top of [`project-readiness.md`](project-readiness.md);
> alpha-ready means the architecture-proven dogfood point, not the full
> `detect → extract → decrypt → decompile → patch → verify → delta-apply`
> chain. The alpha proof and its manifest contract describe the **post-alpha
> dogfood project**, not the alpha gate.

These docs describe the monorepo as a three-project suite:

- Itotori: localization state and agentic workflows.
- Kaifuu: extraction, patching, verification, and delta packages.
- Utsushi: runtime validation evidence.

## User-facing docs (start here)

New users start with the root [README.md](../README.md) user quickstart
(`itotori` install → `init` → the multi-command localize flow:
`extract` → `structure-export` → `wiki build` → `localize` → `patch` →
`validate` → review → output), then
[install.md](install.md) (fresh-clone setup + the public-fixture demo), then
[alpha-readiness.md](alpha-readiness.md) (checked alpha readiness) and
[security-and-limitations.md](security-and-limitations.md) for the security
posture, legal boundaries, and honest limitations. The alpha readiness checklist
command
([`scripts/alpha-readiness-checklist.mjs`](../scripts/alpha-readiness-checklist.mjs),
`just alpha-readiness-checklist`) re-derives those readiness claims from the
generated capability + benchmark artifacts so the docs cannot drift.

Then read [alpha-proof.md](alpha-proof.md) and
[project-readiness.md](project-readiness.md). The Studio SPA — the React
app shell at [`apps/itotori/src/ui/`](../apps/itotori/src/ui/), the Dusk
Observatory design system at
[`packages/itotori-ds/`](../packages/itotori-ds/), and the typed API
client (`fnd-api-client`) at
[`apps/itotori/src/api-client.ts`](../apps/itotori/src/api-client.ts) — is
documented in [frontend.md](frontend.md). The design-language pointer for
shipped studio UI lives in
[`docs/design/hifi-brief.md`](design/hifi-brief.md).
The product SEMVER, the publishable surface, and the relation between the
product version and the format-level `schemaVersion` markers are documented in
[versioning-and-release-policy.md](versioning-and-release-policy.md). The
per-format stability tiers, the backward-compatibility / version-negotiation
policy, and the cross-version compatibility pin are documented in
[format-stability-and-compatibility-policy.md](format-stability-and-compatibility-policy.md).
Itotori permission gates and the alpha/local bootstrap actor model are documented in
[permissions.md](permissions.md).
Localization quality claims, benchmark taxonomy, seeded-defect protocol, and
human adjudication requirements are documented in
[quality-claims.md](quality-claims.md),
[localization-quality-taxonomy.json](localization-quality-taxonomy.json), and
[ADR 0003](adrs/0003-localization-quality-taxonomy.md).
Binary game data ingest from `/archive/vault/` (managed by the vault-curation
sibling project) is contracted in
[itotori-vault-source-adapter.md](itotori-vault-source-adapter.md).
Active docs must use generic project runners, generic real-corpus descriptors,
and generic engine/runtime artifact surfaces. The title-reference allowlist and
grep review command live in
[fixtures-and-corpora.md](fixtures-and-corpora.md#title-reference-allowlist-for-active-docs).
Kaifuu engine fixture sourcing, reference citation, and unsupported variant
policy lives in [kaifuu-fixture-policy.md](kaifuu-fixture-policy.md).
Kaifuu archive, encryption, key, helper, and unknown-variant detector rows are
documented in [kaifuu-detection-matrix.md](kaifuu-detection-matrix.md).
Kaifuu encrypted-engine research and alpha key-discovery implications are
summarized in
[kaifuu-encrypted-engine-research.md](kaifuu-encrypted-engine-research.md).
The repeatable workflow for adding new Kaifuu engine adapters lives in
[kaifuu-engine-playbook.md](kaifuu-engine-playbook.md).
Kaifuu encoding, normalization, atomic output, traversal, rollback, and
partial-write safety rules live in
[kaifuu-patch-safety.md](kaifuu-patch-safety.md).
The alpha proof establishes the public-fixture manifest contract for the first
real-engine proof target, sourced from `/archive/vault/` through the
vault-source adapter. Its generic public-fixture workflow supersedes the former
fixture gate.
Affected detection and CI cache rules live in the dev doc
[`docs/dev/ci-cache-and-affected.md`](dev/ci-cache-and-affected.md).
The implementation roadmap lives in
[`docs/dev/spec-dag.md`](dev/spec-dag.md) and `roadmap/spec-dag.json`.
Agent-led implementation should also follow the dev doc
[`docs/dev/orchestration-operating-model.md`](dev/orchestration-operating-model.md)
and the [agent worktree lifecycle](dev/worktree-lifecycle.md).
Provider credentials, routing, logging, and recording policy is defined in
[ADR 0002](adrs/0002-provider-routing-and-recording.md).
Search and indexing infrastructure, including exact indexes, pgvector handling,
semantic retrieval tools, and fallback behavior, is defined in
[ADR 0004](adrs/0004-search-and-indexing-infrastructure.md).
Itotori's product workflow, human decision queue, style-guide conversation, and
feedback escalation policy are defined in
[itotori-product-workflow.md](itotori-product-workflow.md).
The synthetic large-project generator and scale harness are documented in
[itotori-scale-harness.md](itotori-scale-harness.md).
Research recommendations are historical evidence unless mapped to live DAG
nodes. The current research-to-DAG mapping lives in
[research/research-to-dag-crosswalk.md](research/research-to-dag-crosswalk.md);
the research index is [research/README.md](research/README.md).

## Developer / contributor docs

The **developer / contributor surface** lives under
[`docs/dev/`](dev/README.md): dev toolchain policy, internal architecture,
the qd DAG / orchestration workflow, worktree lifecycle, testing standard,
CI / dependency policy, and the audit playbook. If you are going to change
code, start with [`CONTRIBUTING.md`](../CONTRIBUTING.md) at the repo root
and follow its pointer into [`docs/dev/`](dev/README.md).
