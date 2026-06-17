# ADR 0004: Search And Indexing Infrastructure

## Status

Accepted for ITOTORI-030.

## Context

Itotori needs lookup and retrieval across source units, glossary terms, scenes,
context artifacts, feedback reports, findings, and agent tool records. These
lookups support reviewer queue context, deterministic QA, feedback dedupe,
affected-work planning, and future agent tool calls.

The current database is plain Postgres from `docker-compose.yml`. It does not
install `pgvector`, and public CI must keep working when optional extensions are
unavailable. Existing migrations already create B-tree indexes for the current
project, bundle, unit, event, finding, artifact, and feedback tables. The
remaining decision is how to make those exact lookups explicit, how future
tables should be indexed, and how semantic retrieval can be added without
turning unavailable extensions into CI blockers.

## Decision

Exact search is the required baseline. Semantic search is optional and must
degrade to deterministic exact search.

Itotori will not require `pgvector` for the current CI, Docker Compose service,
or default developer database. The default Postgres service remains plain
`postgres:18`. All mandatory migrations must run without extension privileges
and without a `vector` type.

`pgvector` is the preferred future semantic index backend when the database can
install it, but it is a capability, not a product assumption. A semantic search
tool must report whether it used `pgvector`, an unindexed recorded fixture, a
local-only embedding store, or the exact-search fallback.

Opaque RAG stores are rejected. Searchable records must remain tied to concrete
Itotori identifiers, source revisions, hashes, locale branches, privacy state,
and corpus kinds. Agents receive search tools with retrieval contracts; they do
not receive an unbounded private vector database handle.

## Exact Indexes

The current schema already supplies these mandatory exact indexes:

| Area         | Index                                                | Purpose                                                    |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| Projects     | `itotori_projects_workspace_key_idx`                 | Exact project lookup by workspace and project key.         |
| Projects     | `itotori_projects_workspace_status_idx`              | Workspace status views.                                    |
| Revisions    | `itotori_source_revisions_project_idx`               | Project revision history.                                  |
| Revisions    | `itotori_source_revisions_kind_value_idx`            | Exact source revision lookup by kind and value.            |
| Bundles      | `itotori_source_bundles_bridge_idx`                  | Exact imported bridge lookup.                              |
| Bundles      | `itotori_source_bundles_project_imported_idx`        | Latest imports by project.                                 |
| Bundles      | `itotori_source_bundles_revision_idx`                | Revision-bound bundle lookup.                              |
| Bundles      | `itotori_source_bundles_hash_idx`                    | Exact bundle hash lookup.                                  |
| Assets       | `itotori_assets_project_kind_idx`                    | Asset lists by project and kind.                           |
| Assets       | `itotori_assets_bundle_key_idx`                      | Exact source asset lookup inside a bundle.                 |
| Assets       | `itotori_assets_revision_idx`                        | Revision-bound asset lookup.                               |
| Source units | `itotori_source_units_bundle_key_idx`                | Unique source unit key inside a source bundle.             |
| Source units | `itotori_source_units_project_locale_key_idx`        | Exact source unit lookup by project, locale, and unit key. |
| Source units | `itotori_source_units_asset_idx`                     | Units by source asset.                                     |
| Source units | `itotori_source_units_revision_idx`                  | Revision-bound unit lookup.                                |
| Branches     | `itotori_locale_branches_project_locale_idx`         | Locale branch lookup by project and target locale.         |
| Branch units | `itotori_locale_branch_units_bridge_unit_idx`        | Draft lookup by source unit.                               |
| Events       | `itotori_events_project_branch_time_idx`             | Project or branch event timeline.                          |
| Events       | `itotori_events_kind_time_idx`                       | Event audit by kind.                                       |
| Events       | `itotori_events_task_idx`                            | Agent or tool task audit.                                  |
| Events       | `itotori_events_finding_idx`                         | Finding event audit.                                       |
| Findings     | `itotori_findings_project_branch_status_idx`         | Decision and QA queues by status.                          |
| Findings     | `itotori_findings_project_severity_created_idx`      | Severity triage within a project.                          |
| Findings     | `itotori_findings_first_seen_event_idx`              | Finding provenance lookup.                                 |
| Artifacts    | `itotori_artifacts_project_branch_kind_idx`          | Context artifact lists by project, branch, and kind.       |
| Artifacts    | `itotori_artifacts_finding_idx`                      | Evidence by finding.                                       |
| Artifacts    | `itotori_artifacts_bridge_unit_idx`                  | Evidence by source unit.                                   |
| Artifacts    | `itotori_artifacts_source_bundle_idx`                | Evidence by source bundle.                                 |
| Feedback     | `itotori_feedback_sources_project_kind_idx`          | Feedback source lookup by project and source kind.         |
| Feedback     | `itotori_feedback_reports_dedupe_key_idx`            | Canonical duplicate grouping.                              |
| Feedback     | `itotori_feedback_reports_project_branch_status_idx` | Feedback queue by project, branch, and status.             |
| Feedback     | `itotori_feedback_reports_project_label_idx`         | Feedback queue by triage label.                            |
| Feedback     | `itotori_feedback_reports_bridge_unit_idx`           | Feedback by source unit.                                   |
| Feedback     | `itotori_feedback_evidence_report_idx`               | Evidence by canonical feedback report.                     |
| Feedback     | `itotori_feedback_evidence_source_idx`               | Evidence by feedback source.                               |

Future migrations that add first-class glossary, scene, context artifact, and
agent-tool tables must add these exact indexes before those records are used by
review or agent search:

| Future area       | Required index shape                                                              | Purpose                                     |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| Glossary terms    | Unique `(project_id, locale_branch_id, target_locale, normalized_source_term)`    | Exact term lookup and duplicate prevention. |
| Glossary terms    | `(project_id, locale_branch_id, target_locale, normalized_target_term)`           | Reverse term lookup from draft text.        |
| Glossary terms    | `(project_id, locale_branch_id, term_status, updated_at)`                         | Active/conflict review queues.              |
| Glossary terms    | `(project_id, source_bundle_id, source_unit_key)` on the term evidence join table | Terms cited by a source unit.               |
| Scenes            | Unique `(project_id, source_bundle_id, scene_key)`                                | Exact scene lookup from bridge context.     |
| Scenes            | `(project_id, source_bundle_id, route_key, scene_order)`                          | Route-ordered scene traversal.              |
| Scene units       | `(scene_id, unit_order)` and `(bridge_unit_id)`                                   | Nearby-unit and reverse scene lookup.       |
| Context artifacts | `(project_id, locale_branch_id, artifact_kind, created_at)`                       | Reviewer evidence lists.                    |
| Context artifacts | `(project_id, source_bundle_id)` and `(bridge_unit_id)`                           | Bundle and source-unit evidence lookup.     |
| Context artifacts | `(hash)` where non-null                                                           | Exact artifact dedupe.                      |
| Feedback reports  | `(project_id, locale_branch_id, target_locale, feedback_type, report_status)`     | Typed feedback queues.                      |
| Feedback reports  | `(project_id, context_status, last_reported_at)`                                  | Missing-context triage.                     |
| Agent tools       | Unique `(tool_name, tool_version)` on the registry table                          | Exact tool capability lookup.               |
| Agent tools       | `(tool_status, capability_key)` on the registry table                             | Enabled tool discovery.                     |
| Agent tool calls  | `(project_id, task_id, created_at)` and `(project_id, tool_name, created_at)`     | Tool-run audit and replay.                  |

Normalized text columns must be materialized by application code or generated
columns before unique indexes rely on them. The normalization rule is lower-case
Unicode NFC plus whitespace collapse unless a locale-specific glossary decision
defines stricter behavior. If glossary terms support both branch-scoped and
project-wide rows, migrations must use separate partial unique indexes for
`locale_branch_id is not null` and `locale_branch_id is null`; a nullable branch
column must not be the only duplicate-prevention key.

## Semantic Retrieval Contract

Agents may call search only through versioned tools. The initial tool family is:

- `itotori.search.exact.v1`
- `itotori.search.semantic.v1`

Both tools accept:

- `projectId` and optional `localeBranchId`;
- `targetLocale` when the corpus is locale scoped;
- `corpus`, one of `source_units`, `glossary_terms`, `scenes`,
  `context_artifacts`, `feedback_reports`, `findings`, or `agent_tools`;
- `filters` for source bundle, revision, surface kind, artifact kind, feedback
  type, status, privacy classification, and evidence tier;
- `limit`, capped at 50 unless a reviewer-visible workflow raises it;
- `cursor` for pagination.

`itotori.search.exact.v1` also accepts structured exact predicates such as
`sourceUnitKey`, `bridgeUnitId`, `sceneKey`, `normalizedTerm`, `artifactHash`,
`feedbackReportId`, `dedupeKey`, `findingId`, `toolName`, and `taskId`.

`itotori.search.semantic.v1` accepts `queryText`, optional `queryRefs`, and a
`semanticIntent` enum of `context_for_unit`, `term_disambiguation`,
`feedback_dedupe`, `style_or_glossary_evidence`, `runtime_evidence`, or
`tool_discovery`. It must return:

- `mode`: `semantic`, `recorded_semantic`, `local_semantic`, or
  `exact_fallback`;
- `backend`: `pgvector`, `recorded_fixture`, `local_embedding_store`, or
  `postgres_exact`;
- `indexVersion` and `sourceRevisionId` where applicable;
- `results[]` with stable Itotori ids, corpus kind, rank, match kind, excerpt or
  excerpt hash, privacy classification, source hash, and freshness timestamp;
- `score` only when a semantic backend produced a comparable score;
- `fallbackReason` when `mode` is `exact_fallback`.

The semantic tool must never issue a live embedding or model call unless the
selected provider route satisfies ADR 0002. Public CI must use fake or recorded
semantic fixtures, or `exact_fallback`. Private source text, feedback, and
runtime artifacts must keep privacy labels through indexing and retrieval.

## Pgvector Handling

`pgvector` support should be added as an optional capability in a later
migration, not as a prerequisite for the current schema.

The optional semantic migration should:

1. Create a mandatory `itotori_search_documents` table using only standard
   Postgres types. Each row stores `search_document_id`, `project_id`,
   `locale_branch_id`, `corpus`, source Itotori ids, source revision, source
   hash, privacy classification, normalized searchable text, metadata, and
   `index_version`.
   The table must have exact indexes on `(project_id, corpus, source_record_id,
index_version)`, `(project_id, locale_branch_id, corpus, index_version)`,
   `(project_id, corpus, source_revision_id)`, and `(project_id,
privacy_classification, corpus)`. If lexical text search is needed before
   semantic search, use built-in Postgres full-text search with a generated
   `tsvector` column and GIN index; do not make `pg_trgm` mandatory.
2. Probe for the `vector` extension without failing the migration when it is not
   installed or the database role lacks extension privileges.
3. When the probe succeeds, run `create extension vector`, create an optional
   `itotori_search_document_vectors` table keyed by `search_document_id`, and
   add a pgvector ANN index for the selected embedding dimension and distance
   metric.
4. When the probe fails, record semantic capability as unavailable and leave the
   exact `itotori_search_documents` table usable for `exact_fallback`.

Docker and CI behavior:

- The default `docker-compose.yml` Postgres service remains valid without
  pgvector.
- `just check`, `just ci`, repository tests, and migration tests must not fail
  because `pgvector` is unavailable.
- A separate local or deployment profile may use a pgvector-enabled Postgres
  image, but tests must exercise the unavailable-extension path.
- Semantic tests in public CI must assert that exact fallback returns stable ids
  and an explicit fallback reason.

## Index Migration Plan

1. Keep existing migrations and current Docker service unchanged for
   ITOTORI-030.
2. Add the future glossary, scene, context artifact, feedback, and agent-tool
   exact indexes in the same migrations that create those tables. Those
   migrations must contain repository tests similar to the current
   `pg_indexes` coverage for source units, bundles, events, findings, and
   artifacts.
3. Add `itotori_search_documents` only when a concrete search API or tool needs
   a materialized corpus. The first version must use ordinary Postgres types and
   deterministic exact fallback.
4. Add optional pgvector companion storage only after the exact search document
   table exists and a capability probe can skip vector setup without failing CI.
5. Add performance tests or explain-plan snapshots once project-scale fixture
   data exists. Until then, every new queue or retrieval path must name the
   exact index it relies on in its repository test.

## Consequences

- Current CI stays extension-free and deterministic.
- Agent search calls are auditable because every result cites concrete Itotori
  ids and source revisions.
- Semantic search can improve ranking later without changing the reviewer or
  agent retrieval contract.
- Future migrations have a checklist for exact indexes before adding broader
  search features.

## Alternatives Considered

### Require Pgvector Immediately

This would make semantic search easier to prototype, but it would make plain
Postgres CI and developer setup fragile. It also risks introducing vector
storage before the exact corpus and privacy boundaries are stable.

### Use Only External Vector Storage

External vector databases may be useful later, but making them the first
retrieval path would split source identity, privacy policy, and migration state
away from Itotori's database.

### Keep Search As Ad Hoc SQL

Ad hoc repository queries are acceptable for isolated features, but they do not
define corpus boundaries for agents, do not provide consistent fallback
behavior, and make search performance blind spots easy to miss.
