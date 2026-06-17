# Roadmap DAG Preparation

The roadmap DAG now lives in `roadmap/spec-dag.json` and is documented in
[spec-dag.md](spec-dag.md). This page records the original shaping criteria that
the DAG must keep satisfying.

The graph covers five tracks:

1. Shared schemas and compatibility fixtures.
2. Catalog identity, local corpus inventory, translation completeness, and
   readiness-aware opportunity ranking.
3. Itotori localization graph, agents, QA, feedback, and benchmarks.
4. Kaifuu real-engine detection, layered access, extraction, patching, and delta
   packages.
5. Utsushi runtime validation adapters.

Each roadmap node defines:

- dependencies;
- acceptance criteria;
- fixture coverage;
- project and parallel work group;
- CI gate;
- user-visible result.
