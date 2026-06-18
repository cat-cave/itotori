# Utsushi Runtime Artifact Storage

Utsushi runtime payloads live under a dedicated managed artifact root and are
referenced from reports and Postgres by portable relative URIs. Runtime reports
must not embed screenshot, trace, recording, or conformance payload bytes in DB
JSON metadata.

## Managed Root

The local filesystem root is caller-selected, but it must be prepared by
`RuntimeArtifactRoot::prepare`. Preparation creates the root and writes the
`.utsushi-runtime-artifacts` marker file. Preparation only adopts roots that are
new, empty, or already marked. Non-empty unmarked directories and obvious
source or project roots are refused instead of being silently converted into
runtime-managed cleanup roots.

Cleanup is marker-gated. `RuntimeArtifactRoot::cleanup_contents` refuses to run
without that marker and removes only entries inside the managed root, preserving
the marker itself. Source game directories, local corpus roots, benchmark
outputs, and patch outputs must never be passed as runtime artifact roots.
Cleanup and writes reject symlinks in the managed root path, artifact parent
components, and artifact destinations.

## Portable URI Naming

All v0.2 runtime artifact references use:

```text
artifacts/utsushi/runtime/<runtime-report-id>/<kind-directory>/<artifact-id>.<extension>
```

The current kind directories are:

- `traces` for `trace_log` JSON.
- `screenshots` for screenshot PNGs.
- `frame-captures` for frame-capture PNGs when a frame capture is not modeled
  as a screenshot.
- `recordings` for recording payloads.
- `conformance-reports` for `reference_comparison` JSON.

Path segments are deterministic identifiers, not user-provided filenames.
Absolute paths, URI schemes, backslashes, `.` segments, and `..` segments are
invalid.

## Observation Hook Events

Runtime reports may include `observationHookEvents`, an alpha envelope emitted
by browser, NW-style, native, or engine hooks before proof-specific adapters add
deeper evidence. The Rust source of truth is
`ObservationHookEvent` in `utsushi-core`; events use
`schemaVersion: "0.1.0-alpha"`.

Each event carries common metadata:

- `eventId`, `observedAt`, and `eventKind`.
- `runtimeTargetId`, `adapterId`, `evidenceTier`, and `environment`.
- Optional `sourceRevision` and `bridgeRefs`.
- `redaction` metadata declaring whether local/private fields were redacted.
- A typed `payload` with `payloadKind`.

The alpha payload kinds are `text`, `choice`, `branch`, `scene`, `frame`, and
`error`. Validation rejects missing evidence tiers, missing runtime target ids,
event kind/payload kind mismatches, untyped error payloads, invalid managed
artifact URIs, and unredacted local filesystem paths. Local paths must be
replaced with redaction markers and accompanied by redaction rules and
`redactedFields`; portable artifact URIs under `artifacts/utsushi/runtime/...`
remain valid references.

## Postgres References

Runtime artifact payloads are stored on disk or in external artifact storage.
Postgres rows store only references:

- `itotori_artifacts.uri`
- `itotori_runtime_evidence_items.portable_artifact_uri`
- sanitized `artifactRef` metadata containing only id, kind, URI, hash, media
  type, and byte size

Large payload fields such as raw screenshot bytes, trace blobs, recording data,
or conformance report bodies are not persisted in runtime metadata.

## Re-Ingest Repair Semantics

`runtimeReportId` is the replacement identity for normalized runtime evidence in
Itotori. If a corrected report is ingested with the same id, the latest report
body replaces the prior normalized projection for that run.

Before writing the corrected projection, Itotori removes child evidence items,
bridge-unit reference rows, runtime validation rows, report-scoped artifact
rows, and runtime-validation findings from the earlier projection. It then
recreates only the trace, branch, capture, recording, approximation, reference
comparison, artifact, and validation-finding rows present in the corrected
report. Dashboard runtime counts and pending runtime validation decisions must
therefore match the latest report shape, not the union of all attempts.
