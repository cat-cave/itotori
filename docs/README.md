# Itotori Docs

> **Alpha definition (2026-06-24).** The **live cold-start orientation** for
> the monorepo lives in [`docs/dev/spec-dag.md`](dev/spec-dag.md) (the
> committed `roadmap/spec-dag.json` is the source of truth — it is what the
> `qd` CLI and the readiness checklists query). The historical point-in-time
> snapshot from the 2026-06-24 audit batch is preserved as
> [`current-state-2026-06-24.md`](current-state-2026-06-24.md); it is
> intentionally frozen (bannered as a snapshot in its preamble) and is no
> longer the cold-start entry point. The redefined alpha gates live at the
> top of [`project-readiness.md`](project-readiness.md);
> alpha-ready means the architecture-proven dogfood point, not the full
> `detect → extract → decrypt → decompile → patch → verify → delta-apply`
> chain. Where this index names `ALPHA-006` (the Sukara/RealLive vertical)
> or "alpha proof" as canonical, those references describe the **post-alpha
> dogfood project** and the SHARED-025 manifest contract that supports it,
> not the alpha gate. Audit index: [`audits/README.md`](audits/README.md).

These docs describe the monorepo as a three-project suite:

- Itotori: localization state and agentic workflows.
- Kaifuu: extraction, patching, verification, and delta packages.
- Utsushi: runtime validation evidence.

## User-facing docs (start here)

A user who wants to localize a game starts at the repo
[README](../README.md), whose quickstart goes **install → `itotori init` →
`itotori localize-game` → review → patched output** without cloning the
repository or using the Nix/pnpm developer flow. Then read:

- [install.md](install.md) — the full install path (the user package install +
  native runtime dependencies; the developer fresh-clone path is in the later
  sections).
- [security-and-limitations.md](security-and-limitations.md) — the security
  posture, the ZDR requirement, the legal / copyright boundaries, and the
  honest limitations. **You do not need to read anything in `docs/dev/` to
  localize a game.**
- [native-deps-provisioning.md](native-deps-provisioning.md) — provisioning the
  native runtime tooling the CLI drives (kaifuu/utsushi Rust bins, Postgres,
  Chromium) on a machine without the dev shell.
- [kaifuu-detection-matrix.md](kaifuu-detection-matrix.md) — which engines /
  variants are supported for extraction and patching.
- [frontend.md](frontend.md) — the Studio dashboard (the browsable review
  surface for drafts, QA findings, and runtime evidence).

The readiness milestones (what "alpha" and "beta" mean for a user) live in
[project-readiness.md](project-readiness.md) and
[alpha-readiness.md](alpha-readiness.md); the public-fixture end-to-end proof
is documented in [alpha-proof.md](alpha-proof.md). The stability tiers and
backward-compatibility policy for the public formats a localization depends on
(bridge schema, `.kaifuu` delta, API contract, DB schema) are documented in
[format-stability-and-compatibility-policy.md](format-stability-and-compatibility-policy.md)
and [versioning-and-release-policy.md](versioning-and-release-policy.md).

## Reference docs (engines, quality, contracts)

- [kaifuu-detection-matrix.md](kaifuu-detection-matrix.md),
  [kaifuu-fixture-policy.md](kaifuu-fixture-policy.md),
  [kaifuu-engine-playbook.md](kaifuu-engine-playbook.md),
  [kaifuu-patch-safety.md](kaifuu-patch-safety.md) — supported engines/variants,
  fixture sourcing, adding a new adapter, and patch atomicity/safety.
- [itotori-product-workflow.md](itotori-product-workflow.md) — the product
  workflow, human decision queue, style-guide conversation, and feedback
  escalation policy.
- [quality-claims.md](quality-claims.md) +
  [localization-quality-taxonomy.json](localization-quality-taxonomy.json) —
  localization quality claims, the benchmark taxonomy, and the seeded-defect
  protocol.
- [permissions.md](permissions.md) — permission gates and the bootstrap actor
  model.
- [fixtures-and-corpora.md](fixtures-and-corpora.md#title-reference-allowlist-for-active-docs)
  — the title-reference allowlist for active docs + the corpus/corpus-descriptor
  rules active docs must follow.
- ADRs ([adrs/](adrs/)) — provider routing/recording (0002), quality taxonomy
  (0003), search/indexing (0004). The vault source adapter contract is in
  [itotori-vault-source-adapter.md](itotori-vault-source-adapter.md).
- Research recommendations are historical evidence unless mapped to live DAG
  nodes; see [research/README.md](research/README.md) +
  [research/research-to-dag-crosswalk.md](research/research-to-dag-crosswalk.md).

## Developer / contributor docs

The **developer / contributor surface** lives under
[`docs/dev/`](dev/README.md): dev toolchain policy, internal architecture,
the qd DAG / orchestration workflow, worktree lifecycle, testing standard,
CI / dependency policy, and the audit playbook. If you are going to change
code, start with [`CONTRIBUTING.md`](../CONTRIBUTING.md) at the repo root
and follow its pointer into [`docs/dev/`](dev/README.md).
