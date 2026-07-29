import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  assertAlphaVerticalProofManifestV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertBenchmarkReportV02,
  assertContractCompatibilityReportV02,
  assertContractFixtureManifestV02,
  assertContractFixtureV02,
  assertDeltaPackageMetadataV02,
  assertFindingRecordFixtureV02,
  assertPatchExportV02,
  assertPatchResultV02,
  assertRuntimeEvidenceReportV02,
  assertRuntimeReport,
} from "../src/index.js";
import {
  bridgeV02Example,
  contractFixtureManifestV02Example,
  contractCompatibilityReportV02Example,
  alphaVerticalProofManifestV02Example,
  exampleFixture,
  publicFixture,
  publicFixtureSha256,
  PUBLIC_HELLO_GAME_GOLDEN_ARTIFACTS,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("has explicit validation expectations for each top-level example fixture", () => {
    const manifest = contractFixtureManifestV02Example();
    assertContractFixtureManifestV02(manifest);
    const expectedTopLevelFixtures = new Set(
      (manifest.validFixtures as Array<{ path: string }>)
        .map((fixture) => fixture.path)
        .filter((path) => path.startsWith("./") && !path.startsWith("./invalid/"))
        .map((path) => path.slice(2)),
    );
    const topLevelFixtures = readdirSync(new URL("./examples", import.meta.url)).filter((entry) =>
      entry.endsWith(".json"),
    );

    expect(new Set(topLevelFixtures)).toEqual(expectedTopLevelFixtures);
  });

  it("validates every committed contract fixture listed in the manifest", () => {
    const manifest = contractFixtureManifestV02Example();
    assertContractFixtureManifestV02(manifest);

    for (const fixture of manifest.validFixtures as Array<{ kind: string; path: string }>) {
      expect(() =>
        assertContractFixtureV02(
          fixture.kind,
          exampleFixture(`./examples/${fixture.path.slice(2)}`),
        ),
      ).not.toThrow();
    }
  });

  it("rejects every invalid contract fixture listed in the manifest with semantic errors", () => {
    const manifest = contractFixtureManifestV02Example();
    assertContractFixtureManifestV02(manifest);

    for (const fixture of manifest.invalidFixtures as Array<{
      kind: string;
      path: string;
      expectedSemanticError: string;
    }>) {
      expect(() =>
        assertContractFixtureV02(
          fixture.kind,
          exampleFixture(`./examples/${fixture.path.slice(2)}`),
        ),
      ).toThrow(new RegExp(fixture.expectedSemanticError));
    }
  });

  it("validates the committed contract compatibility report", () => {
    const report = contractCompatibilityReportV02Example();

    expect(() => assertContractCompatibilityReportV02(report)).not.toThrow();
  });

  it("accepts and validates the optional v0.2 out-of-band span flag", () => {
    const bridge = bridgeV02Example();
    const units = bridge.units as Array<Record<string, unknown>>;
    const spans = units[0]!.spans as Array<Record<string, unknown>>;
    spans[0]!.outOfBand = true;
    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();

    spans[0]!.outOfBand = "true";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/outOfBand must be a boolean/);
  });

  it("accepts minimal valid bridge bundles", () => {
    expect(() =>
      assertBridgeBundle({
        schemaVersion: "0.1.0",
        bridgeId: "019ed000-0000-7000-8000-000000000001",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        extractorName: "kaifuu-fixture",
        extractorVersion: "0.0.0",
        units: [],
      }),
    ).not.toThrow();
  });

  it("accepts the public multi-surface bridge golden snapshot", () => {
    const bridge = publicFixture("fixtures/hello-game/expected/bridge-v0.1.json");

    expect(() => assertBridgeBundle(bridge)).not.toThrow();

    const units = bridge.units as Array<{
      textSurface: string;
      protectedSpans: Array<{ kind: string; raw: string }>;
    }>;
    expect(new Set(units.map((unit) => unit.textSurface))).toEqual(
      new Set([
        "choice_label",
        "database_entry",
        "dialogue",
        "image_text",
        "metadata_text",
        "speaker_name",
        "tutorial_text",
        "ui_label",
      ]),
    );
    expect(units).toHaveLength(11);

    const spanKinds = new Set(
      units.flatMap((unit) => unit.protectedSpans.map((span) => span.kind)),
    );
    expect(spanKinds).toContain("variable_placeholder");
    expect(spanKinds).toContain("control_markup");
  });

  it("rejects malformed v0.1 protected span ranges", () => {
    const bridge = {
      schemaVersion: "0.1.0",
      bridgeId: "019ed000-0000-7000-8000-000000000001",
      sourceBundleHash: "hash",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "019ed000-0000-7000-8000-bridgeun0001",
          sourceUnitKey: "line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "hash",
          sourceLocale: "ja-JP",
          sourceText: "Hello, {player}.",
          speaker: "",
          textSurface: "dialogue",
          protectedSpans: [
            {
              kind: "variable_placeholder",
              raw: "{player}",
              start: 0,
              end: 8,
              preserveMode: "map",
              variableName: "player",
            },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "line.001",
          },
        },
      ],
    };

    expect(() => assertBridgeBundle(bridge)).toThrow(/raw must match sourceText byte range/);
  });

  it("accepts the public full-system hello-game v0.2 golden artifact corpus", () => {
    const manifest = publicFixture("fixtures/public/hello-game.manifest.json");
    const manifestFiles = manifest.files as Array<{
      path: string;
      role: string;
      redistributable: boolean;
    }>;

    for (const artifact of PUBLIC_HELLO_GAME_GOLDEN_ARTIFACTS) {
      expect(manifestFiles).toContainEqual(
        expect.objectContaining({
          path: artifact.path,
          role: artifact.role,
          redistributable: true,
        }),
      );
      expect(() =>
        assertContractFixtureV02(artifact.kind, publicFixture(artifact.path)),
      ).not.toThrow();
    }

    const expectedRoles = new Set([
      "patch-export",
      "patch-result",
      "delta-package",
      "runtime-report",
      "benchmark-report",
      "finding",
    ]);
    const manifestRoles = new Set(manifestFiles.map((file) => file.role));
    for (const role of expectedRoles) {
      expect(manifestRoles).toContain(role);
    }

    const bridge = publicFixture("fixtures/hello-game/expected/bridge-v0.2.json");
    const patchExport = publicFixture("fixtures/hello-game/expected/patch-export-v0.2.fr-FR.json");
    const patchResult = publicFixture("fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json");
    const deltaPackage = publicFixture(
      "fixtures/hello-game/expected/delta-package-v0.2.fr-FR.json",
    );
    const runtimeReport = publicFixture(
      "fixtures/hello-game/expected/runtime-report-v0.2.fr-FR.json",
    );
    const benchmarkReport = publicFixture(
      "fixtures/hello-game/expected/benchmark-report-v0.2.fr-FR.json",
    );
    const finding = publicFixture("fixtures/hello-game/expected/finding-v0.2.fr-FR.json");

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();
    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(() => assertPatchResultV02(patchResult)).not.toThrow();
    expect(() => assertDeltaPackageMetadataV02(deltaPackage)).not.toThrow();
    expect(() => assertRuntimeEvidenceReportV02(runtimeReport)).not.toThrow();
    expect(() => assertRuntimeReport(runtimeReport)).not.toThrow();
    expect(() => assertBenchmarkReportV02(benchmarkReport)).not.toThrow();
    expect(() => assertFindingRecordFixtureV02(finding)).not.toThrow();

    const bridgeUnits = bridge.units as Array<Record<string, unknown>>;
    const bridgeUnitIds = new Set(bridgeUnits.map((unit) => unit.bridgeUnitId));
    const patchEntries = patchExport.entries as Array<Record<string, unknown>>;
    expect(patchExport.sourceBridgeId).toBe(bridge.bridgeId);
    expect(patchExport.sourceBundleHash).toBe(bridge.sourceBundleHash);
    expect(patchExport.targetLocale).toBe("fr-FR");
    expect(patchEntries).toHaveLength(bridgeUnits.length);
    expect(patchEntries.every((entry) => bridgeUnitIds.has(entry.bridgeUnitId))).toBe(true);

    const sourceCompatibility = asTestRecord(
      patchResult.sourceCompatibility,
      "public patch result source compatibility",
    );
    expect(patchResult.patchExportId).toBe(patchExport.patchExportId);
    expect(sourceCompatibility.status).toBe("compatible");
    expect(sourceCompatibility.compatibleUnits).toHaveLength(patchEntries.length);

    expect(deltaPackage.sourceBridgeId).toBe(bridge.bridgeId);
    expect(deltaPackage.generatedPatchExportId).toBe(patchExport.patchExportId);
    expect(deltaPackage.generatedPatchExportHash).toBe(patchExport.patchExportHash);

    const traceEvents = runtimeReport.traceEvents as Array<{
      bridgeUnitRef: { bridgeUnitId: string };
    }>;
    expect(traceEvents.length).toBeGreaterThan(0);
    expect(traceEvents.every((event) => bridgeUnitIds.has(event.bridgeUnitRef.bridgeUnitId))).toBe(
      true,
    );
    expect(runtimeReport.fidelityTier).toBe("trace_only");

    const fixtureRefs = benchmarkReport.fixtureOrCorpusRefs as Array<Record<string, unknown>>;
    expect(fixtureRefs).toContainEqual(
      expect.objectContaining({
        corpusKind: "public_fixture",
        manifestUri: "fixtures/public/hello-game.manifest.json",
        publicContent: true,
      }),
    );

    const findingRecord = asTestRecord(finding.finding, "public standalone finding");
    expect(findingRecord.affectedRefs).toContainEqual(
      expect.objectContaining({
        subjectKind: "bridge_unit",
        subjectId: bridgeUnits[2]?.bridgeUnitId,
      }),
    );
  });

  it("accepts the public alpha vertical proof manifest fixture", () => {
    const manifest = publicFixture("fixtures/public/hello-game-alpha-vertical-proof.manifest.json");
    const proofPath = "fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json";
    const proofManifest = publicFixture(proofPath);
    const manifestFiles = manifest.files as Array<{
      path: string;
      role: string;
      sha256: string;
      redistributable: boolean;
    }>;

    expect(manifestFiles).toContainEqual(
      expect.objectContaining({
        path: proofPath,
        role: "alpha-proof-manifest",
        sha256: publicFixtureSha256(proofPath),
        redistributable: true,
      }),
    );
    expect(() => assertAlphaVerticalProofManifestV02(proofManifest)).not.toThrow();
    expect(proofManifest.fixture).toEqual(
      expect.objectContaining({
        fixtureId: "hello-game",
        publicManifestUri: "fixtures/public/hello-game.manifest.json",
        publicRedistribution: "allowed",
      }),
    );
    expect(proofManifest.runtimeTargetIds).toEqual(
      expect.arrayContaining([
        "kaifuu-fixture:patch-apply:fr-FR",
        "utsushi-fixture:web-review:fr-FR",
      ]),
    );
  });

  it.each([
    {
      name: "missing provider proof hash",
      mutate: (proofManifest: Record<string, unknown>) => {
        proofManifest.contentHashes = (
          proofManifest.contentHashes as Array<Record<string, unknown>>
        ).filter((entry) => entry.scope !== "provider_proof");
      },
      semanticError: /contentHashes must include provider_proof/,
    },
    {
      name: "missing bridge unit hashes",
      mutate: (proofManifest: Record<string, unknown>) => {
        proofManifest.contentHashes = (
          proofManifest.contentHashes as Array<Record<string, unknown>>
        ).filter((entry) => entry.scope !== "bridge_unit");
      },
      semanticError: /contentHashes must include bridge_unit/,
    },
    {
      name: "mismatched provider proof content id",
      mutate: (proofManifest: Record<string, unknown>) => {
        const providerHash = (proofManifest.contentHashes as Array<Record<string, unknown>>).find(
          (entry) => entry.scope === "provider_proof",
        );
        expect(providerHash).toBeDefined();
        providerHash!.contentId = "019ed025-0000-7000-8000-000000000202";
      },
      semanticError: /providerProofIds\[0\].*contentHashes/,
    },
    {
      name: "mismatched patch export content id",
      mutate: (proofManifest: Record<string, unknown>) => {
        const patchExportHash = (
          proofManifest.contentHashes as Array<Record<string, unknown>>
        ).find((entry) => entry.scope === "patch_export");
        expect(patchExportHash).toBeDefined();
        patchExportHash!.contentId = "fixtures/hello-game/expected/patch-export-other.json";
      },
      semanticError: /artifactRefs\.patch_export\.hash.*contentHashes/,
    },
  ])("rejects alpha proof manifests with $name", ({ mutate, semanticError }) => {
    const proofManifest = alphaVerticalProofManifestV02Example();
    mutate(proofManifest);

    expect(() => assertAlphaVerticalProofManifestV02(proofManifest)).toThrow(semanticError);
  });

  it("binds alpha proof fixture publicManifestHash to artifact refs and content hashes", () => {
    const proofManifest = alphaVerticalProofManifestV02Example();
    const fixture = asTestRecord(proofManifest.fixture, "alpha proof fixture");
    fixture.publicManifestHash =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(() => assertAlphaVerticalProofManifestV02(proofManifest)).toThrow(
      /fixture\.publicManifestHash.*publicFixtureManifest\.hash/,
    );

    const alignedProofManifest = alphaVerticalProofManifestV02Example();
    const alignedFixture = asTestRecord(alignedProofManifest.fixture, "aligned alpha fixture");
    const artifactRefs = asTestRecord(alignedProofManifest.artifactRefs, "aligned artifact refs");
    const publicFixtureManifestRef = asTestRecord(
      artifactRefs.publicFixtureManifest,
      "aligned public fixture manifest ref",
    );
    const publicFixtureHash = (
      alignedProofManifest.contentHashes as Array<Record<string, unknown>>
    ).find((entry) => entry.scope === "public_fixture_manifest");
    expect(publicFixtureHash).toBeDefined();

    alignedFixture.publicManifestHash =
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    publicFixtureManifestRef.hash = alignedFixture.publicManifestHash;
    publicFixtureHash!.hash = alignedFixture.publicManifestHash;

    expect(() => assertAlphaVerticalProofManifestV02(alignedProofManifest)).not.toThrow();
  });
});
