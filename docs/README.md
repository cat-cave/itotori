# Itotori Docs

These docs describe the monorepo as a three-project suite:

- Itotori: localization state and agentic workflows.
- Kaifuu: extraction, patching, verification, and delta packages.
- Utsushi: runtime validation evidence.

Start with [hello-world.md](hello-world.md), then read [architecture.md](architecture.md).
The alpha localization project readiness definition and check matrix live in
[alpha-localization-project-readiness.md](alpha-localization-project-readiness.md).
The current spec dashboard is documented in
[`packages/spec-dag-dashboard/README.md`](../packages/spec-dag-dashboard/README.md),
and the current runtime evidence dashboard is documented in
[`apps/runtime-web-review/README.md`](../apps/runtime-web-review/README.md).
Toolchain upgrade policy lives in [toolchain-policy.md](toolchain-policy.md).
Testing conventions live in [testing-standard.md](testing-standard.md).
Itotori permission gates and the alpha/local bootstrap actor model are documented in
[permissions.md](permissions.md).
Localization quality claims, benchmark taxonomy, seeded-defect protocol, and
human adjudication requirements are documented in
[quality-claims.md](quality-claims.md),
[localization-quality-taxonomy.json](localization-quality-taxonomy.json), and
[ADR 0003](adrs/0003-localization-quality-taxonomy.md).
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
Affected detection and CI cache rules live in
[ci-cache-and-affected.md](ci-cache-and-affected.md).
The implementation roadmap lives in [spec-dag.md](spec-dag.md) and
`roadmap/spec-dag.json`. Agent-led implementation should also follow
[orchestration-operating-model.md](orchestration-operating-model.md) and the
[agent worktree lifecycle](worktree-lifecycle.md).
`SHARED-025` has landed the alpha proof manifest contract. `ALPHA-007` and
`ALPHA-009` remain future work for the public vertical command and CI handoff
from the hello-world compatibility path to the alpha proof workflow.
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
