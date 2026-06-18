# Utsushi Runtime Artifact Storage

Utsushi runtime payloads live under a dedicated managed artifact root and are
referenced from reports and Postgres by portable relative URIs. Runtime reports
must not embed screenshot, trace, recording, or conformance payload bytes in DB
JSON metadata.

## Managed Root

The local filesystem root is caller-selected, but it must be prepared by
`RuntimeArtifactRoot::prepare`. Preparation creates the root and writes the
`.utsushi-runtime-artifacts` marker file.

Cleanup is marker-gated. `RuntimeArtifactRoot::cleanup_contents` refuses to run
without that marker and removes only entries inside the managed root, preserving
the marker itself. Source game directories, local corpus roots, benchmark
outputs, and patch outputs must never be passed as runtime artifact roots.

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

## Postgres References

Runtime artifact payloads are stored on disk or in external artifact storage.
Postgres rows store only references:

- `itotori_artifacts.uri`
- `itotori_runtime_evidence_items.portable_artifact_uri`
- sanitized `artifactRef` metadata containing only id, kind, URI, hash, media
  type, and byte size

Large payload fields such as raw screenshot bytes, trace blobs, recording data,
or conformance report bodies are not persisted in runtime metadata.
