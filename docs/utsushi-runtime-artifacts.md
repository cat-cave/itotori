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

Launch adapters that stage process-produced files must prepare a fresh staging
path before every launch. `RuntimeArtifactRoot::prepare_staging_file` removes a
pre-existing regular file at the requested staging destination after validating
that the path is not a symlink or directory. This prevents stale browser
screenshots from a prior failed cleanup from being promoted as fresh runtime
artifacts.

## Portable URI Naming

Shared `RuntimeEvidenceReportV02` artifact references use portable relative
URIs. The shared schema rejects embedded bytes and local filesystem paths, but
it does not require every producer fixture to use the managed storage prefix.

Utsushi-managed runtime storage and Itotori DB storage use:

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

Shared bridge-schema examples may use logical portable refs such as
`artifacts/utsushi/hello/frame-0001.png` to test contract compatibility outside
a storage backend. Itotori ingestion normalizes those schema-portable refs to
the managed storage prefix before writing runtime evidence rows and artifact
rows, while retaining the original adapter-local ref in sanitized metadata.
Public Utsushi runtime capture fixtures already use the managed prefix because
they exercise the runtime artifact store itself.

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
For v0.2 runtime evidence, `portable_artifact_uri` and `itotori_artifacts.uri`
are managed storage refs under `artifacts/utsushi/runtime/...`; the original
schema ref, when different, is retained as `adapterLocalArtifactRef` metadata.

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
