import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertConformanceManifestResultJoinV01,
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertSemanticCodeAllowedV01,
  CONFORMANCE_SCHEMA_VERSION_V01,
  ConformanceIngestionError,
  type ConformanceManifestV01,
  type ConformanceResultV01,
} from "../src/index.js";

function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/utsushi-conformance/${name}`, import.meta.url), "utf8"),
  ) as T;
}

function baselineTextTraceManifest(): ConformanceManifestV01 {
  return loadFixture("manifest-baseline-text-trace.json");
}

function pairedManifest(): ConformanceManifestV01 {
  return loadFixture("manifest-cross-check-paired.json");
}

function positiveTextTraceResult(): ConformanceResultV01 {
  return loadFixture("positive-text-trace-pass.json");
}

describe("ConformanceResultV01 schema mirror", () => {
  it("pins the schema version to the Rust crate's CONFORMANCE_SCHEMA_VERSION", () => {
    // Parity test: the Rust crate is the structural authority; this fence
    // catches drift on every TS test run.
    const rustModRs = readFileSync(
      new URL("../../../crates/utsushi-core/src/conformance/mod.rs", import.meta.url),
      "utf8",
    );
    expect(rustModRs).toContain(
      `pub const CONFORMANCE_SCHEMA_VERSION: &str = "${CONFORMANCE_SCHEMA_VERSION_V01}";`,
    );
  });

  it("assert_conformance_result_v01_accepts_text_trace_pass()", () => {
    expect(() => assertConformanceResultV01(positiveTextTraceResult())).not.toThrow();
  });

  it("assert_conformance_result_v01_accepts_snapshot_restore_pass_with_state_path_evidence()", () => {
    const value = loadFixture<ConformanceResultV01>("positive-snapshot-restore-pass.json");
    expect(() => assertConformanceResultV01(value)).not.toThrow();
    expect(value.evidence[0]?.artifactKind).toBe("statePath");
  });

  it("assert_conformance_result_v01_accepts_recording_capture_pass_at_e2()", () => {
    const value = loadFixture<ConformanceResultV01>("positive-recording-capture-pass.json");
    expect(() => assertConformanceResultV01(value)).not.toThrow();
    expect(value.outcome.kind).toBe("pass");
    if (value.outcome.kind === "pass") {
      expect(value.outcome.evidenceTier).toBe("E2");
    }
  });

  it("assert_conformance_manifest_v01_accepts_baseline_text_trace_manifest()", () => {
    expect(() => assertConformanceManifestV01(baselineTextTraceManifest())).not.toThrow();
  });

  it("assert_conformance_result_v01_round_trips_every_evidence_ref_variant()", () => {
    const baseline = positiveTextTraceResult();
    const variants: ConformanceResultV01["evidence"][number][] = [
      {
        artifactKind: "runtimeArtifact",
        kind: "trace_log",
        uri: "artifacts/utsushi/runtime/synthetic-run/trace_log/trace-001.jsonl",
        artifactId: "trace-001",
      },
      { artifactKind: "textLine", lineId: "trace-line-001" },
      { artifactKind: "frameArtifactRef", frameId: "frame-0001" },
      { artifactKind: "replayLogRef", runId: "run-001" },
      { artifactKind: "implMapFixture", fixtureId: "fixture-a" },
      { artifactKind: "bridgeUnit", bridgeUnitId: "bridge-unit-001" },
      { artifactKind: "statePath", path: "port.frame" },
    ];
    for (const evidence of variants) {
      const result: ConformanceResultV01 = { ...baseline, evidence: [evidence] };
      const serialized = JSON.parse(JSON.stringify(result));
      expect(() => assertConformanceResultV01(serialized)).not.toThrow();
      expect(serialized.evidence[0]).toEqual(evidence);
    }
  });

  it("assert_conformance_result_v01_rejects_pass_above_profile_ceiling()", () => {
    const value = loadFixture<ConformanceResultV01>("negative-evidence-tier-promotion.json");
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured).toBeInstanceOf(ConformanceIngestionError);
    expect(captured?.code).toBe("itotori.conformance.evidence_tier_above_profile_ceiling");
  });

  it("assert_conformance_result_v01_rejects_pass_without_evidence()", () => {
    const value = loadFixture<unknown>("negative-pass-without-evidence.json");
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.pass_without_evidence");
  });

  it("assert_conformance_result_v01_rejects_semantic_code_outside_whitelist()", () => {
    const value = loadFixture<unknown>("negative-disallowed-semantic-code.json");
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.semantic_code_not_allowed");
  });

  it("assert_conformance_result_v01_rejects_skip_shape_in_pass_envelope()", () => {
    const value = loadFixture<unknown>("negative-skip-as-pass.json");
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.unknown_field");
  });

  it("assert_conformance_result_v01_rejects_malformed_recorded_at()", () => {
    const value = loadFixture<unknown>("negative-malformed-recorded-at.json");
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.recorded_at_malformed");
  });

  it("assert_conformance_result_v01_rejects_unsupported_with_declared_in_manifest_true()", () => {
    const value = {
      ...positiveTextTraceResult(),
      profileId: "frame-capture",
      outcome: {
        kind: "unsupported",
        semanticCode: "utsushi.conformance.profile_not_declared",
        declaredInManifest: true,
      },
      evidence: [],
    };
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.declared_profile_reported_as_unsupported");
  });

  it("assert_conformance_result_v01_rejects_evidence_ref_state_path_with_local_path_shape()", () => {
    const value = {
      ...positiveTextTraceResult(),
      profileId: "snapshot-restore",
      evidence: [{ artifactKind: "statePath", path: "/home/user/leak" }],
    };
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.evidence_ref_invalid");
  });

  it("assert_conformance_result_v01_rejects_evidence_ref_runtime_artifact_outside_managed_root()", () => {
    const value = {
      ...positiveTextTraceResult(),
      profileId: "frame-capture",
      outcome: { kind: "pass", evidenceTier: "E2" },
      evidence: [
        {
          artifactKind: "runtimeArtifact",
          kind: "frame_capture",
          uri: "not/the/managed/root/trace.json",
        },
      ],
    };
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceResultV01(value);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.evidence_ref_invalid");
  });

  it("assert_conformance_manifest_v01_rejects_schema_version_drift()", () => {
    const manifest = baselineTextTraceManifest();
    const drifted = { ...manifest, schemaVersion: "0.0.0" };
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceManifestV01(drifted);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.schema_version_mismatch");
  });

  it("assert_conformance_manifest_v01_rejects_unknown_abi_version()", () => {
    const manifest = baselineTextTraceManifest();
    const drifted = { ...manifest, abiVersion: 99 };
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceManifestV01(drifted);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.abi_version_unsupported");
  });
});

describe("ConformanceManifestV01 / ResultV01 join validator", () => {
  it("rejects_orphan_result_not_declared_in_manifest", () => {
    const manifest = baselineTextTraceManifest();
    const orphan = loadFixture<ConformanceResultV01>("negative-orphan-result.json");
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceManifestResultJoinV01(manifest, [orphan]);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.profile_not_declared");
  });

  it("rejects skipping a declared profile", () => {
    const manifest = baselineTextTraceManifest();
    const skipResult: ConformanceResultV01 = {
      ...positiveTextTraceResult(),
      outcome: {
        kind: "skip",
        semanticCode: "utsushi.conformance.profile_not_reported",
        reason: "filter excluded",
      },
      evidence: [],
    };
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceManifestResultJoinV01(manifest, [skipResult]);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.declared_profile_skipped");
  });

  it("rejects pass result whose tier exceeds the manifest profile ceiling", () => {
    const manifest: ConformanceManifestV01 = {
      ...pairedManifest(),
      supportedProfiles: pairedManifest().supportedProfiles.map((profile) =>
        profile.id === "text-trace" ? { ...profile, evidenceTierCeiling: "E0" } : profile,
      ),
    };
    const results: ConformanceResultV01[] = [
      positiveTextTraceResult(),
      loadFixture<ConformanceResultV01>("positive-snapshot-restore-pass.json"),
      loadFixture<ConformanceResultV01>("positive-frame-capture-pass.json"),
      loadFixture<ConformanceResultV01>("positive-recording-capture-pass.json"),
    ];
    let captured: ConformanceIngestionError | undefined;
    try {
      assertConformanceManifestResultJoinV01(manifest, results);
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.pass_above_manifest_ceiling");
  });

  it("accepts a fully reported manifest", () => {
    const manifest = pairedManifest();
    const results: ConformanceResultV01[] = [
      positiveTextTraceResult(),
      loadFixture<ConformanceResultV01>("positive-snapshot-restore-pass.json"),
      loadFixture<ConformanceResultV01>("positive-frame-capture-pass.json"),
      loadFixture<ConformanceResultV01>("positive-recording-capture-pass.json"),
    ];
    expect(() => assertConformanceManifestResultJoinV01(manifest, results)).not.toThrow();
  });
});

describe("assertSemanticCodeAllowedV01", () => {
  it("accepts utsushi.conformance.* codes", () => {
    expect(() =>
      assertSemanticCodeAllowedV01("utsushi.conformance.profile_not_reported", "code"),
    ).not.toThrow();
  });
  it("accepts utsushi.snapshot.* codes", () => {
    expect(() =>
      assertSemanticCodeAllowedV01("utsushi.snapshot.diff_mismatch", "code"),
    ).not.toThrow();
  });
  it("accepts kaifuu.* codes", () => {
    expect(() =>
      assertSemanticCodeAllowedV01("kaifuu.patch_result.silent_partial_write", "code"),
    ).not.toThrow();
  });
  it("rejects utsushi.sink.* codes", () => {
    let captured: ConformanceIngestionError | undefined;
    try {
      assertSemanticCodeAllowedV01("utsushi.sink.unsupported_kind", "code");
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.semantic_code_not_allowed");
  });
  it("rejects non-namespaced codes", () => {
    let captured: ConformanceIngestionError | undefined;
    try {
      assertSemanticCodeAllowedV01("not-a-code", "code");
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.semantic_code_malformed");
  });
  it("rejects rgss3.* codes", () => {
    let captured: ConformanceIngestionError | undefined;
    try {
      assertSemanticCodeAllowedV01("rgss3.script.unknown_opcode", "code");
    } catch (error) {
      captured = error as ConformanceIngestionError;
    }
    expect(captured?.code).toBe("itotori.conformance.semantic_code_malformed");
  });
});
