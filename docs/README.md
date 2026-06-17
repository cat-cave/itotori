# Itotori Docs

These docs describe the monorepo as a three-project suite:

- Itotori: localization state and agentic workflows.
- Kaifuu: extraction, patching, verification, and delta packages.
- Utsushi: runtime validation evidence.

Start with [hello-world.md](hello-world.md), then read [architecture.md](architecture.md).
Toolchain upgrade policy lives in [toolchain-policy.md](toolchain-policy.md).
Testing conventions live in [testing-standard.md](testing-standard.md).
Affected detection and CI cache rules live in
[ci-cache-and-affected.md](ci-cache-and-affected.md).
The implementation roadmap lives in [spec-dag.md](spec-dag.md) and
`roadmap/spec-dag.json`. Agent-led implementation should also follow
[orchestration-operating-model.md](orchestration-operating-model.md).
Provider credentials, routing, logging, and recording policy is defined in
[ADR 0002](adrs/0002-provider-routing-and-recording.md).
