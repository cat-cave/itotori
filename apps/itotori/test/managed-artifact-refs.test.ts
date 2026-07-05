import {
  BENCHMARK_MANAGED_ARTIFACT_KINDS,
  CORPUS_SIDECAR_ARTIFACT_KINDS,
  MANAGED_ARTIFACT_URI_ROOTS,
  benchmarkManagedArtifactRef,
  corpusSidecarArtifactRef,
  managedArtifactCleanupScopePrefix,
  planManagedArtifactCleanup,
  redactPrivateLocalManagedArtifactRef,
  type ManagedArtifactCleanupCandidate,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

// UTSUSHI-049 — corpus sidecars + benchmark artifacts use MANAGED artifact
// references without reusing the runtime-only assumptions, and cleanup of
// those managed artifacts can never target read-only source. Synthetic
// fixtures only.

const RUNTIME_MOUNT = "artifacts/utsushi/runtime";

describe("managed corpus-sidecar artifact references", () => {
  it("are managed refs keyed on the local corpus entry, distinct from the runtime mount", () => {
    const ref = corpusSidecarArtifactRef({
      localCorpusEntryId: "corpus-entry-0001",
      artifactId: "sidecar-0001",
      artifactKind: "structure_index",
      publicContent: true,
    });

    // Managed: portable-relative URI under a managed mount + a content hash.
    expect(ref.uri).toBe(
      "artifacts/itotori/corpus-sidecars/corpus-entry-0001/structure/sidecar-0001.json",
    );
    expect(ref.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Distinct from the runtime-only assumptions: NOT the runtime mount, and
    // keyed on the corpus entry — never a runtimeReportId.
    expect(ref.uri.startsWith(`${RUNTIME_MOUNT}/`)).toBe(false);
    expect(ref.uri.startsWith(`${MANAGED_ARTIFACT_URI_ROOTS.corpus_sidecar}/`)).toBe(true);
    expect(ref.uri).toContain("/corpus-entry-0001/");
    expect(MANAGED_ARTIFACT_URI_ROOTS.corpus_sidecar).not.toBe(MANAGED_ARTIFACT_URI_ROOTS.runtime);

    // Corpus sidecar kinds are disjoint from the runtime artifact kinds.
    const runtimeKinds = new Set([
      "trace_log",
      "screenshot",
      "recording",
      "capture_metadata",
      "reference_comparison",
      "runtime_report",
    ]);
    for (const kind of CORPUS_SIDECAR_ARTIFACT_KINDS) {
      expect(runtimeKinds.has(kind)).toBe(false);
    }
  });

  it("hashes stably and reflects distinct content", () => {
    const a = corpusSidecarArtifactRef({
      localCorpusEntryId: "corpus-entry-0001",
      artifactId: "sidecar-0001",
      artifactKind: "corpus_manifest",
      publicContent: true,
    });
    const b = corpusSidecarArtifactRef({
      localCorpusEntryId: "corpus-entry-0001",
      artifactId: "sidecar-0001",
      artifactKind: "corpus_manifest",
      publicContent: true,
    });
    const c = corpusSidecarArtifactRef({
      localCorpusEntryId: "corpus-entry-0002",
      artifactId: "sidecar-0001",
      artifactKind: "corpus_manifest",
      publicContent: true,
    });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

describe("managed benchmark artifact references", () => {
  it("are managed refs keyed on the benchmark run, distinct from the runtime mount", () => {
    const ref = benchmarkManagedArtifactRef({
      benchmarkRunId: "bench-run-0001",
      artifactId: "report-0001",
      artifactKind: "benchmark_report",
      publicContent: true,
    });

    expect(ref.uri).toBe("artifacts/itotori/benchmarks/bench-run-0001/reports/report-0001.json");
    expect(ref.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(ref.uri.startsWith(`${RUNTIME_MOUNT}/`)).toBe(false);
    expect(ref.uri.startsWith(`${MANAGED_ARTIFACT_URI_ROOTS.benchmark}/`)).toBe(true);
    expect(MANAGED_ARTIFACT_URI_ROOTS.benchmark).not.toBe(MANAGED_ARTIFACT_URI_ROOTS.runtime);
    expect(MANAGED_ARTIFACT_URI_ROOTS.benchmark).not.toBe(
      MANAGED_ARTIFACT_URI_ROOTS.corpus_sidecar,
    );

    const runtimeKinds = new Set([
      "trace_log",
      "screenshot",
      "recording",
      "capture_metadata",
      "reference_comparison",
      "runtime_report",
    ]);
    for (const kind of BENCHMARK_MANAGED_ARTIFACT_KINDS) {
      expect(runtimeKinds.has(kind)).toBe(false);
    }
  });
});

describe("private-local redaction before public summaries", () => {
  it("strips uri + hash for private-local artifacts, passes public content through", () => {
    const priv = benchmarkManagedArtifactRef({
      benchmarkRunId: "bench-run-0001",
      artifactId: "seed-0001",
      artifactKind: "benchmark_seed",
      publicContent: false,
    });
    const redacted = redactPrivateLocalManagedArtifactRef(priv);
    expect(redacted.uri).toBe("[redacted-private-local-artifact]");
    expect(redacted.redactedFields).toEqual(["uri", "hash"]);
    expect("hash" in redacted && redacted.hash !== undefined).toBe(false);

    const pub = corpusSidecarArtifactRef({
      localCorpusEntryId: "corpus-entry-0001",
      artifactId: "sidecar-0001",
      artifactKind: "scan_report",
      publicContent: true,
    });
    const passthrough = redactPrivateLocalManagedArtifactRef(pub);
    expect(passthrough.uri).toBe(pub.uri);
    expect(passthrough.hash).toBe(pub.hash);
    expect(passthrough.redactedFields).toEqual([]);
  });
});

describe("source-safe managed artifact cleanup", () => {
  // A read-only local corpus root + vault root — cleanup must NEVER target
  // these, only the derived managed artifacts.
  const sourceGameRoot = "/archive/vault/game-0001";
  const localCorpusRoot = "/home/trevor/corpus/game-0001";
  const protectedSourceRoots = [sourceGameRoot, localCorpusRoot];

  it("cleans a benchmark run's superseded managed artifacts without touching source", () => {
    const scope = { class: "benchmark", benchmarkRunId: "bench-run-0001" } as const;
    const keep = benchmarkManagedArtifactRef({
      benchmarkRunId: "bench-run-0001",
      artifactId: "report-keep",
      artifactKind: "benchmark_report",
      publicContent: true,
    });
    const stale = benchmarkManagedArtifactRef({
      benchmarkRunId: "bench-run-0001",
      artifactId: "seed-stale",
      artifactKind: "benchmark_seed",
      publicContent: true,
    });
    const otherRun = benchmarkManagedArtifactRef({
      benchmarkRunId: "bench-run-9999",
      artifactId: "seed-other",
      artifactKind: "benchmark_seed",
      publicContent: true,
    });

    const candidates: ManagedArtifactCleanupCandidate[] = [
      { artifactId: keep.artifactId, uri: keep.uri },
      { artifactId: stale.artifactId, uri: stale.uri },
      { artifactId: otherRun.artifactId, uri: otherRun.uri },
      // read-only SOURCE files, mislabelled into the candidate list:
      { artifactId: "source-seen", uri: `${sourceGameRoot}/Seen.txt` },
      { artifactId: "source-manifest", uri: `${localCorpusRoot}/.itotori-local-corpus.json` },
      // a runtime artifact from a different class/mount:
      { artifactId: "runtime-shot", uri: `${RUNTIME_MOUNT}/rr-0001/screenshots/x.png` },
      // a patch output with no managed URI:
      { artifactId: "patch-export", uri: null },
    ];

    const plan = planManagedArtifactCleanup({
      scope,
      candidates,
      retainedArtifactIds: [keep.artifactId],
      protectedSourceRoots,
    });

    // Only the stale in-scope managed artifact is deletable.
    expect(plan.deletable.map((c) => c.artifactId)).toEqual(["seed-stale"]);
    expect(plan.retained.map((c) => c.artifactId)).toEqual(["report-keep"]);

    // Source files are protected and NEVER deletable.
    expect(plan.protectedSource.map((c) => c.artifactId).sort()).toEqual([
      "source-manifest",
      "source-seen",
    ]);
    const deletableIds = new Set(plan.deletable.map((c) => c.artifactId));
    for (const src of ["source-seen", "source-manifest"]) {
      expect(deletableIds.has(src)).toBe(false);
    }

    // Out-of-scope: other run, runtime mount, and the URI-less patch output.
    expect(plan.outOfScope.map((c) => c.artifactId).sort()).toEqual([
      "patch-export",
      "runtime-shot",
      "seed-other",
    ]);
  });

  it("protects a source path even if it is shaped like a managed URI in scope", () => {
    // Adversarial: a source root that literally equals the scope prefix must
    // still win — source-safety is checked before scope membership.
    const scope = { class: "corpus_sidecar", localCorpusEntryId: "corpus-entry-0001" } as const;
    const scopePrefix = managedArtifactCleanupScopePrefix(scope);
    const plan = planManagedArtifactCleanup({
      scope,
      candidates: [{ artifactId: "spoof", uri: `${scopePrefix}manifests/spoof.json` }],
      protectedSourceRoots: [scopePrefix.slice(0, -1)],
    });
    expect(plan.deletable).toHaveLength(0);
    expect(plan.protectedSource.map((c) => c.artifactId)).toEqual(["spoof"]);
  });
});
