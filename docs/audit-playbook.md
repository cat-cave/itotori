# Audit Playbook

We use **qdcli** for audit orchestration. How audits run, how findings and
severities (P0–P3) work, and how findings gate CI/merge and get promoted into
follow-up nodes are documented in qdcli's own `docs/llms.md` (findings/severity/
gate/promote sections) and `docs/agents.md`. Do not duplicate that generic
machinery here.

Two itotori-specific things audits must layer on top of qd:

## 1. The DAG Anti-Pattern Checklist Is Mandatory

Every itotori audit must explicitly check the merged code against the **DAG
anti-pattern checklist** in
[`orchestration-operating-model.md`](orchestration-operating-model.md)
("DAG Anti-Patterns The Orchestrator And Audit Workers Must Reject"). Each
applicable violation is a P0 or P1 finding. This is itotori's quality bar
grounded in real audit findings (single-node engine ports, acceptance criteria
that name no artifact, author-fixture-only smoke tests, tests that mirror
contracts, substrate with no consumer, migration TypeScript-registration parity,
research-as-DAG-node, claimed-support chains, legacy-path preservation,
single-game validation). An audit that does not run this checklist is
incomplete.

## 2. The Repo Validator Gate

itotori carries a repo-local validator that the audit and the orchestrator both
rely on:

```sh
just roadmap-validate
```

`just roadmap-validate` validates the committed `roadmap/spec-dag.json`, compiles
`roadmap/audit-report.schema.json`, validates the committed audit-report
examples under `roadmap/examples/`, and checks report-level orchestration
invariants. Audit reports are machine-ingestible JSON that must validate against
`roadmap/audit-report.schema.json`; the JSON report is the canonical audit
artifact, not chat prose.
