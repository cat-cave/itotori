import { createHash } from "node:crypto";

// UTSUSHI-049 — managed artifact references for CORPUS SIDECARS and BENCHMARK
// ARTIFACTS.
//
// Runtime evidence artifacts already have a managed reference scheme
// (`packages/itotori-db/src/repositories/project-repository.ts`): a
// `artifacts/utsushi/runtime` mount, URIs keyed on the `runtimeReportId`, a
// runtime-only artifact-kind set (screenshot/recording/trace_log/…), and a
// projection cleanup keyed on `metadata->>'runtimeReportId'`. Those are
// RUNTIME-ONLY assumptions: a runtime capture belongs to exactly one runtime
// report, is written under the runtime mount, and is cleaned up with the
// report it belongs to.
//
// Corpus sidecars and benchmark artifacts are NOT runtime captures, so they
// deliberately do NOT reuse any of those runtime-only assumptions:
//   * their own managed mounts (`artifacts/itotori/corpus-sidecars`,
//     `artifacts/itotori/benchmarks`), distinct from the runtime mount;
//   * their own artifact-kind sets, distinct from the runtime kinds;
//   * their own scope key — a corpus sidecar is keyed on the LOCAL CORPUS
//     ENTRY it derives from, a benchmark artifact on the BENCHMARK RUN it was
//     produced by — NEVER on a runtimeReportId.
//
// What IS shared is the generic managed-artifact discipline (a portable
// relative URI under a managed mount + a content hash over the ref identity),
// because that discipline is not runtime-specific.

// ---------------------------------------------------------------------------
// Managed artifact classes + mounts
// ---------------------------------------------------------------------------

/**
 * The managed artifact classes itotori stores. Each class owns a DISTINCT
 * managed mount; corpus sidecars and benchmark artifacts are intentionally
 * separate from `runtime` so neither reuses the runtime-only mount.
 */
export type ManagedArtifactClass = "runtime" | "corpus_sidecar" | "benchmark";

/**
 * The managed mount (portable relative root) for each artifact class. The
 * `runtime` value MUST equal the runtime repository's
 * `RUNTIME_MANAGED_ARTIFACT_URI_ROOT`; it is listed here only so the corpus /
 * benchmark roots can be asserted DISTINCT from it. Corpus sidecars and
 * benchmark artifacts live under `artifacts/itotori/...`, never the
 * `artifacts/utsushi/runtime` runtime mount.
 */
export const MANAGED_ARTIFACT_URI_ROOTS: Record<ManagedArtifactClass, string> = {
  runtime: "artifacts/utsushi/runtime",
  corpus_sidecar: "artifacts/itotori/corpus-sidecars",
  benchmark: "artifacts/itotori/benchmarks",
};

// ---------------------------------------------------------------------------
// Corpus sidecar artifact references
// ---------------------------------------------------------------------------

/**
 * Corpus sidecar artifact kinds — DERIVED/generated files stored alongside a
 * local-corpus entry (a manifest of the scan, a decoded structure index, a
 * scan/detection report). Disjoint from the runtime artifact kinds.
 */
export const CORPUS_SIDECAR_ARTIFACT_KINDS = [
  "corpus_manifest",
  "structure_index",
  "scan_report",
] as const;
export type CorpusSidecarArtifactKind = (typeof CORPUS_SIDECAR_ARTIFACT_KINDS)[number];

const CORPUS_SIDECAR_KIND_DIRECTORIES: Record<CorpusSidecarArtifactKind, string> = {
  corpus_manifest: "manifests",
  structure_index: "structure",
  scan_report: "scan-reports",
};

const CORPUS_SIDECAR_KIND_EXTENSIONS: Record<CorpusSidecarArtifactKind, string> = {
  corpus_manifest: ".json",
  structure_index: ".json",
  scan_report: ".json",
};

/**
 * A managed corpus-sidecar artifact reference. Shares the generic managed
 * shape (id/kind/uri/hash) but is keyed — through {@link corpusSidecarManagedArtifactUri}
 * — on the `localCorpusEntryId` it derives from, NOT a runtimeReportId.
 *
 * `publicContent` marks whether the sidecar is safe to surface in a public
 * summary/dashboard fixture. A private-local sidecar (derived from a local
 * corpus entry whose bytes are not publishable) must be redacted first — see
 * {@link redactPrivateLocalManagedArtifactRef}.
 */
export type CorpusSidecarArtifactRef = {
  artifactClass: "corpus_sidecar";
  localCorpusEntryId: string;
  artifactId: string;
  artifactKind: CorpusSidecarArtifactKind;
  uri: string;
  hash: string;
  publicContent: boolean;
  mediaType?: string;
  byteSize?: number;
};

export function corpusSidecarManagedArtifactUri(input: {
  localCorpusEntryId: string;
  artifactKind: CorpusSidecarArtifactKind;
  artifactId: string;
  extension?: string;
}): string {
  const directory = CORPUS_SIDECAR_KIND_DIRECTORIES[input.artifactKind];
  const extension = input.extension ?? CORPUS_SIDECAR_KIND_EXTENSIONS[input.artifactKind];
  const uri = [
    MANAGED_ARTIFACT_URI_ROOTS.corpus_sidecar,
    input.localCorpusEntryId,
    directory,
    `${input.artifactId}${extension}`,
  ].join("/");
  assertManagedArtifactUri(uri, "corpus_sidecar");
  return uri;
}

export function corpusSidecarArtifactRef(input: {
  localCorpusEntryId: string;
  artifactId: string;
  artifactKind: CorpusSidecarArtifactKind;
  publicContent: boolean;
  extension?: string;
  hash?: string;
  mediaType?: string;
  byteSize?: number;
}): CorpusSidecarArtifactRef {
  const uri = corpusSidecarManagedArtifactUri({
    localCorpusEntryId: input.localCorpusEntryId,
    artifactKind: input.artifactKind,
    artifactId: input.artifactId,
    ...(input.extension === undefined ? {} : { extension: input.extension }),
  });
  const hash =
    input.hash ??
    managedArtifactHash({
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      uri,
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
    });
  return {
    artifactClass: "corpus_sidecar",
    localCorpusEntryId: input.localCorpusEntryId,
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    uri,
    hash,
    publicContent: input.publicContent,
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
  };
}

// ---------------------------------------------------------------------------
// Benchmark artifact references
// ---------------------------------------------------------------------------

/**
 * Benchmark managed artifact kinds — the SEED/REPORT outputs of a benchmark
 * run (its seed corpus manifest, its comparison report, a per-system output).
 * Disjoint from the runtime artifact kinds.
 */
export const BENCHMARK_MANAGED_ARTIFACT_KINDS = [
  "benchmark_seed",
  "benchmark_report",
  "benchmark_system_output",
] as const;
export type BenchmarkManagedArtifactKind = (typeof BENCHMARK_MANAGED_ARTIFACT_KINDS)[number];

const BENCHMARK_KIND_DIRECTORIES: Record<BenchmarkManagedArtifactKind, string> = {
  benchmark_seed: "seeds",
  benchmark_report: "reports",
  benchmark_system_output: "system-outputs",
};

const BENCHMARK_KIND_EXTENSIONS: Record<BenchmarkManagedArtifactKind, string> = {
  benchmark_seed: ".json",
  benchmark_report: ".json",
  benchmark_system_output: ".json",
};

/**
 * A managed benchmark artifact reference — keyed, through
 * {@link benchmarkManagedArtifactUri}, on the `benchmarkRunId` that produced
 * it, NOT a runtimeReportId.
 */
export type BenchmarkManagedArtifactRef = {
  artifactClass: "benchmark";
  benchmarkRunId: string;
  artifactId: string;
  artifactKind: BenchmarkManagedArtifactKind;
  uri: string;
  hash: string;
  publicContent: boolean;
  mediaType?: string;
  byteSize?: number;
};

export function benchmarkManagedArtifactUri(input: {
  benchmarkRunId: string;
  artifactKind: BenchmarkManagedArtifactKind;
  artifactId: string;
  extension?: string;
}): string {
  const directory = BENCHMARK_KIND_DIRECTORIES[input.artifactKind];
  const extension = input.extension ?? BENCHMARK_KIND_EXTENSIONS[input.artifactKind];
  const uri = [
    MANAGED_ARTIFACT_URI_ROOTS.benchmark,
    input.benchmarkRunId,
    directory,
    `${input.artifactId}${extension}`,
  ].join("/");
  assertManagedArtifactUri(uri, "benchmark");
  return uri;
}

export function benchmarkManagedArtifactRef(input: {
  benchmarkRunId: string;
  artifactId: string;
  artifactKind: BenchmarkManagedArtifactKind;
  publicContent: boolean;
  extension?: string;
  hash?: string;
  mediaType?: string;
  byteSize?: number;
}): BenchmarkManagedArtifactRef {
  const uri = benchmarkManagedArtifactUri({
    benchmarkRunId: input.benchmarkRunId,
    artifactKind: input.artifactKind,
    artifactId: input.artifactId,
    ...(input.extension === undefined ? {} : { extension: input.extension }),
  });
  const hash =
    input.hash ??
    managedArtifactHash({
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      uri,
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
    });
  return {
    artifactClass: "benchmark",
    benchmarkRunId: input.benchmarkRunId,
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    uri,
    hash,
    publicContent: input.publicContent,
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
  };
}

// ---------------------------------------------------------------------------
// Private-local redaction
// ---------------------------------------------------------------------------

const REDACTED_PRIVATE_LOCAL_URI = "[redacted-private-local-artifact]";

/**
 * Redact a private-local managed artifact ref before it is placed in any
 * public summary or dashboard fixture. A private-local artifact's URI encodes
 * the local corpus entry / benchmark id lineage and its hash is derived from
 * bytes that are not publishable, so both are stripped and recorded in
 * `redactedFields`. Public-content refs pass through unchanged.
 */
export function redactPrivateLocalManagedArtifactRef<
  T extends { uri: string; hash: string; publicContent: boolean },
>(ref: T): Omit<T, "hash"> & { hash?: string; redactedFields: string[] } {
  if (ref.publicContent) {
    return { ...ref, redactedFields: [] };
  }
  const { hash: _hash, ...rest } = ref;
  return {
    ...rest,
    uri: REDACTED_PRIVATE_LOCAL_URI,
    redactedFields: ["uri", "hash"],
  };
}

// ---------------------------------------------------------------------------
// Source-safe cleanup policy
// ---------------------------------------------------------------------------

/**
 * A cleanup pass is scoped to ONE managed sub-tree: a single local corpus
 * entry's sidecars, or a single benchmark run's artifacts. This mirrors the
 * runtime projection cleanup (which is scoped to one runtimeReportId) but for
 * the corpus/benchmark classes — never the runtime class, and never a mount
 * that spans classes.
 */
export type ManagedArtifactCleanupScope =
  | { class: "corpus_sidecar"; localCorpusEntryId: string }
  | { class: "benchmark"; benchmarkRunId: string };

export type ManagedArtifactCleanupCandidate = {
  artifactId: string;
  uri: string | null;
};

export type ManagedArtifactCleanupDecision =
  | "deletable"
  | "retained"
  | "out_of_scope"
  | "protected_source";

export type ManagedArtifactCleanupClassification = ManagedArtifactCleanupCandidate & {
  decision: ManagedArtifactCleanupDecision;
  reason: string;
};

export type ManagedArtifactCleanupPlan = {
  scope: ManagedArtifactCleanupScope;
  scopePrefix: string;
  classifications: ManagedArtifactCleanupClassification[];
  deletable: ManagedArtifactCleanupClassification[];
  retained: ManagedArtifactCleanupClassification[];
  outOfScope: ManagedArtifactCleanupClassification[];
  protectedSource: ManagedArtifactCleanupClassification[];
};

/**
 * The managed sub-tree prefix a cleanup scope is allowed to delete within.
 * ONLY artifacts whose portable-relative URI is under this prefix are cleanup
 * targets — everything else (the runtime mount, other benchmark runs, other
 * corpus entries, patch outputs with no managed URI, and every read-only
 * source path) is out of the pass's reach.
 */
export function managedArtifactCleanupScopePrefix(scope: ManagedArtifactCleanupScope): string {
  switch (scope.class) {
    case "corpus_sidecar":
      return `${MANAGED_ARTIFACT_URI_ROOTS.corpus_sidecar}/${scope.localCorpusEntryId}/`;
    case "benchmark":
      return `${MANAGED_ARTIFACT_URI_ROOTS.benchmark}/${scope.benchmarkRunId}/`;
  }
}

/**
 * Plan a source-safe cleanup of managed corpus/benchmark artifacts.
 *
 * Safety guarantees (in classification order, safety first):
 *  1. Any candidate whose URI resolves under a read-only SOURCE root (a source
 *     game directory, a local corpus root, the vault) is `protected_source`
 *     and NEVER deletable — even if it is otherwise shaped like a managed URI.
 *  2. A candidate with no URI (metadata-only artifacts such as patch exports /
 *     patch results / runtime reports) is `out_of_scope`.
 *  3. A candidate whose URI is not a portable-relative path under this scope's
 *     managed prefix is `out_of_scope` — this excludes the runtime mount,
 *     other benchmark runs, other corpus entries, and patch outputs.
 *  4. A retained id (the artifacts being re-written this pass) is `retained`.
 *  5. Everything left under the scope prefix is `deletable`.
 *
 * The read-only source is therefore structurally un-targetable: cleanup can
 * only ever delete portable-relative managed paths inside its own scope, and
 * source roots are checked first regardless of how a candidate is labelled.
 */
export function planManagedArtifactCleanup(input: {
  scope: ManagedArtifactCleanupScope;
  candidates: readonly ManagedArtifactCleanupCandidate[];
  retainedArtifactIds?: readonly string[];
  protectedSourceRoots: readonly string[];
}): ManagedArtifactCleanupPlan {
  const scopePrefix = managedArtifactCleanupScopePrefix(input.scope);
  const retained = new Set(input.retainedArtifactIds ?? []);
  const sourceRoots = input.protectedSourceRoots.map(normalizeRoot);

  const classifications = input.candidates.map(
    (candidate): ManagedArtifactCleanupClassification => {
      const uri = candidate.uri;

      const protectingRoot =
        uri === null ? undefined : sourceRoots.find((root) => pathIsUnderRoot(uri, root));
      if (protectingRoot !== undefined) {
        return {
          ...candidate,
          decision: "protected_source",
          reason: `under read-only source root ${protectingRoot}`,
        };
      }

      if (uri === null) {
        return {
          ...candidate,
          decision: "out_of_scope",
          reason: "no managed artifact URI (metadata-only artifact)",
        };
      }

      if (!isPortableManagedUri(uri) || !pathIsUnderRoot(uri, scopePrefix)) {
        return {
          ...candidate,
          decision: "out_of_scope",
          reason: `not under cleanup scope prefix ${scopePrefix}`,
        };
      }

      if (retained.has(candidate.artifactId)) {
        return { ...candidate, decision: "retained", reason: "retained by current pass" };
      }

      return { ...candidate, decision: "deletable", reason: `superseded under ${scopePrefix}` };
    },
  );

  return {
    scope: input.scope,
    scopePrefix,
    classifications,
    deletable: classifications.filter((c) => c.decision === "deletable"),
    retained: classifications.filter((c) => c.decision === "retained"),
    outOfScope: classifications.filter((c) => c.decision === "out_of_scope"),
    protectedSource: classifications.filter((c) => c.decision === "protected_source"),
  };
}

// ---------------------------------------------------------------------------
// Shared managed-artifact helpers
// ---------------------------------------------------------------------------

/**
 * Assert `uri` is a portable-relative managed path under the given class's
 * mount. Rejects absolute paths, URI schemes, backslashes, and `.`/`..`
 * traversal segments — the same portability discipline the runtime refs use,
 * but bound to the corpus/benchmark mounts.
 */
export function assertManagedArtifactUri(uri: string, artifactClass: ManagedArtifactClass): void {
  if (!isPortableManagedUri(uri)) {
    throw new Error(`managed artifact uri must be a portable relative path: ${uri}`);
  }
  const root = MANAGED_ARTIFACT_URI_ROOTS[artifactClass];
  if (!pathIsUnderRoot(uri, `${root}/`)) {
    throw new Error(`managed artifact uri must be under ${root}/: ${uri}`);
  }
}

function managedArtifactHash(ref: {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
  byteSize?: number;
}): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(ref)).digest("hex")}`;
}

function isPortableManagedUri(uri: string): boolean {
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri);
  const hasTraversalSegment = uri.split("/").some((segment) => segment === "." || segment === "..");
  return (
    uri.length > 0 &&
    !uri.startsWith("/") &&
    !uri.includes("\\") &&
    !hasScheme &&
    !hasTraversalSegment
  );
}

function normalizeRoot(root: string): string {
  const forward = root.replace(/\\/g, "/");
  return forward.endsWith("/") ? forward.slice(0, -1) : forward;
}

function pathIsUnderRoot(path: string, root: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedRoot = normalizeRoot(root);
  if (normalizedRoot.length === 0) {
    return false;
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}
