# ADR 0001: Contract Source Of Truth

## Status

Accepted for SHARED-000.

## Context

Itotori, Kaifuu, and Utsushi exchange bridge bundles, patch exports, patch
results, delta packages, runtime evidence, findings, and future asset policy
records. The current hello-world contract is intentionally small, but the next
schema work will add many non-dialogue localization surfaces and cross-language
validation requirements.

Without one contract authority, TypeScript types, JSON Schema, Rust serde
structs, fixtures, and database models can drift. Drift would make Kaifuu emit
data that Itotori accepts differently, or make Utsushi validate runtime evidence
against a shape the bridge never promised.

## Decision

The canonical source of truth for shared wire contracts is the TypeScript schema
source in `packages/localization-bridge-schema`.

This authority covers bridge bundles, patch exports, patch results, and Utsushi
runtime evidence schemas. If runtime evidence is later split into a dedicated
package, that package must be named by a new ADR or ADR amendment before it can
become authoritative.

This package owns:

- Human-edited semantic schema definitions.
- Exported TypeScript types for TypeScript consumers.
- Runtime assertion or parser functions for TypeScript command and app code.
- Generated JSON Schema artifacts for language-neutral validation.
- Versioned contract fixtures used by TypeScript and Rust tests.

JSON Schema is a generated interchange artifact, not the hand-edited source.
Generated JSON Schema must be committed or published with the schema package for
consumers that need language-neutral validation, but manual edits belong in the
TypeScript schema source.

Rust serde structs are downstream bindings. They may be generated from the
published schema artifacts once a generator is selected, or hand-authored while
the contract is small. In both cases they must validate against the same
versioned fixtures and round-trip JSON behavior as the TypeScript package.
Serde derives are not the contract source of truth.

Generated bindings and generated schema artifacts must be treated as build
outputs: they should carry generated-file headers, be reproducible from the
schema package, and not be patched directly.

Docs such as `docs/localization-surfaces.md` are requirements inputs for schema
design. They are authoritative for product coverage expectations, but executable
wire compatibility is defined by the schema package and its fixtures.

## Responsibility Matrix

| Artifact                          | Authority                                                      | Maintainer Responsibility                                                                                  | Required Validation                                        |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| TypeScript schema source          | `packages/localization-bridge-schema`                          | Edit semantic contract definitions and version behavior.                                                   | Package tests and fixture validation.                      |
| TypeScript exported types         | Generated or derived from schema source                        | Keep consumers typed without duplicating shapes.                                                           | TypeScript compile and schema package tests.               |
| TypeScript runtime guards/parsers | Generated or derived from schema source                        | Reject invalid payloads at import/export boundaries.                                                       | Positive and negative fixture tests.                       |
| JSON Schema                       | Generated from TypeScript schema source                        | Provide language-neutral validation and external tooling support.                                          | Generated artifact diff plus fixture validation.           |
| Rust serde structs                | Downstream binding in Rust crates or generated binding package | Serialize and deserialize the published wire contract without adding Rust-only fields.                     | Rust fixture deserialize, serialize, and round-trip tests. |
| Itotori DB schema                 | Consumer                                                       | Persist imported contract data and read models. It may denormalize, but cannot redefine contract meaning.  | Repository tests against schema fixtures.                  |
| Kaifuu adapter metadata           | Consumer/producer detail                                       | Keep engine-specific facts in adapter-private metadata or capability schemas.                              | Adapter tests and shared fixture validation.               |
| Utsushi runtime evidence schema   | `packages/localization-bridge-schema`                          | Define trace, capture, smoke report, approximation, and finding payloads as shared wire contracts.         | TypeScript and Rust evidence fixture validation.           |
| Utsushi Rust evidence structs     | Downstream binding in Rust crates or generated binding package | Serialize and deserialize the published runtime evidence contract without adding Utsushi-only wire fields. | Rust fixture deserialize, serialize, and round-trip tests. |

## Boundary Rules

- Kaifuu emits neutral bridge data and patch results. Engine-specific extraction
  details cannot become shared fields unless at least two engine families need
  the same concept and the name is engine-neutral.
- Itotori stores policy, drafts, QA, feedback, and exports against shared IDs.
  Itotori must not branch behavior on Kaifuu engine file paths or engine command
  names except through neutral capabilities.
- Utsushi links traces, captures, layout findings, and smoke results back to
  shared surface IDs, patch exports, and source revisions. Runtime evidence does
  not change bridge identity.
- Database, dashboard, CLI, and generated binding code are consumers. They can
  fail validation, but they cannot silently expand the contract.

## Versioning Rules

- Every wire payload carries `schemaVersion`.
- Additive fields require fixtures showing old and new readers where backward
  compatibility is promised.
- Renamed fields, changed enum meaning, deleted fields, and changed identity
  semantics require a new schema version and migration notes.
- Patch exports must cite the source schema version, source bridge ID, source
  bundle hash, and source revision information needed to reject stale exports.

## Alternatives Considered

### JSON Schema As The Hand-Edited Source

JSON Schema is strong for validation but weak for TypeScript ergonomics,
comments, and project-specific semantic helpers. Making it the source would push
important behavior into separate handwritten TypeScript and Rust layers.

### Rust Serde As The Source

Rust serde would favor Kaifuu and Utsushi implementation details over Itotori's
TypeScript-heavy workflow and app surfaces. It would also make JSON Schema and
TypeScript generation the default path for every contract change.

### Database Schema As The Source

The database stores Itotori state and read models, not the wire format between
projects. It may split, denormalize, or index contract data in ways that are
inappropriate for Kaifuu and Utsushi.

## Consequences

- Bridge schema v0.2 should evolve `packages/localization-bridge-schema` first,
  then update JSON Schema output, Rust bindings or serde structs, and fixtures.
- Reviews for contract changes should inspect the schema source, generated
  artifacts, and fixtures together.
- Future tooling should add a single regeneration command for JSON Schema and
  generated bindings so generated outputs are reproducible.
