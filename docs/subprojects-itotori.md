# Itotori Subproject

Itotori owns localization state: catalog identity, local corpus inventory,
translation-completeness intelligence, locale branches, drafts, policy, QA
findings, feedback, runtime evidence ingestion, and patch-ready exports.

The scaffold uses deterministic fake translation. Live model routing is intentionally out of scope for the hello world.

The product entrypoint is no longer assumed to be a bridge bundle. Real
workflows start with catalog/work identity, local corpus scan evidence,
translation completeness, engine readiness, and only then extraction/import
when Kaifuu can prove the required capability level. Bridge import remains a
low-level foundation, not the only project intake path.

Search and indexing decisions live in
[ADR 0004](adrs/0004-search-and-indexing-infrastructure.md). Itotori features
must rely on exact Postgres indexes first, and agent-facing semantic retrieval
must expose the ADR's tool contract and exact fallback behavior instead of an
opaque retrieval store.
