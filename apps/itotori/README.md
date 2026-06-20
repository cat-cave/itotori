# Itotori App

The Itotori app owns localization state and reviewer-facing surfaces for the
suite.

Current scope includes catalog identity, DB-backed project/import/locale-branch
workflows, fake/provider-backed draft generation, deterministic QA and
protected-span checks, patch-ready export, runtime evidence ingestion, the
project dashboard, runtime dashboard status for `/api/runtime/v0.2/status`,
glossary/context lookup plus recorded semantic glossary search, benchmark and
cost-report surfaces, and typed API schema validation.

`just hello` remains the deterministic fixture path. It uses a fake provider so
the end-to-end fixture can run without external model credentials while still
exercising bridge import, draft, patch export, Kaifuu patching, Utsushi runtime
evidence, and Itotori dashboard ingestion.
