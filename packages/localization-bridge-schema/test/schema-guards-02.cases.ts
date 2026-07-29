import { describe, expect, it } from "vitest";
import {
  assertBridgeBundleV02,
  assertBenchmarkReportV02,
  assertContractFixtureV02,
} from "../src/index.js";
import {
  bridgeV02Example,
  benchmarkReportV02Example,
  publicFixture,
  publicFixtureSha256,
  PUBLIC_SEEDED_DEFECT_GOLDEN_ARTIFACTS,
  bridgeV02Units,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("accepts the public seeded localization defect benchmark report", () => {
    const manifest = publicFixture("fixtures/public/seeded-localization-defects.manifest.json");
    const manifestFiles = manifest.files as Array<{
      path: string;
      role: string;
      redistributable: boolean;
    }>;

    expect(manifestFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/source.json",
          role: "source-game",
          redistributable: true,
        }),
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/seeded-defect-oracle-v0.1.json",
          role: "metadata",
          redistributable: true,
        }),
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/false-positive-cases-v0.1.json",
          role: "metadata",
          redistributable: true,
        }),
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/defect-coverage-matrix-v0.1.json",
          role: "metadata",
          redistributable: true,
        }),
      ]),
    );

    for (const artifact of PUBLIC_SEEDED_DEFECT_GOLDEN_ARTIFACTS) {
      expect(manifestFiles).not.toContainEqual(expect.objectContaining({ path: artifact.path }));
      expect(() =>
        assertContractFixtureV02(artifact.kind, publicFixture(artifact.path)),
      ).not.toThrow();
    }

    const benchmarkReport = publicFixture(
      "fixtures/seeded-localization-defects/expected/benchmark-report-v0.2.en-US.json",
    );
    const findings = benchmarkReport.findingRecords as Array<Record<string, unknown>>;

    expect(() => assertBenchmarkReportV02(benchmarkReport)).not.toThrow();
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ qualitySeverity: "critical", category: "protected_content" }),
        expect.objectContaining({
          qualitySeverity: "neutral",
          adjudicationState: "rejected_false_positive",
        }),
      ]),
    );
  });

  it("keeps the seeded localization defect oracle, coverage matrix, report, manifest, and taxonomy aligned", () => {
    const taxonomy = publicFixture("docs/localization-quality-taxonomy.json");
    const oracle = publicFixture(
      "fixtures/seeded-localization-defects/seeded-defect-oracle-v0.1.json",
    );
    const falsePositiveCases = publicFixture(
      "fixtures/seeded-localization-defects/false-positive-cases-v0.1.json",
    );
    const coverageMatrix = publicFixture(
      "fixtures/seeded-localization-defects/defect-coverage-matrix-v0.1.json",
    );
    const benchmarkReport = publicFixture(
      "fixtures/seeded-localization-defects/expected/benchmark-report-v0.2.en-US.json",
    );

    const categorySubcategories = new Map(
      (taxonomy.categories as Array<Record<string, unknown>>).map((category) => [
        category.id as string,
        new Set(
          (category.subcategories as Array<Record<string, unknown>>).map(
            (subcategory) => subcategory.id as string,
          ),
        ),
      ]),
    );
    const seededDefectKinds = new Map(
      (taxonomy.seededDefectKinds as Array<Record<string, unknown>>).map((kind) => [
        kind.id as string,
        kind,
      ]),
    );
    const seededDefects = oracle.seededDefects as Array<Record<string, unknown>>;
    const seededDefectsById = new Map(
      seededDefects.map((defect) => [defect.seededDefectId as string, defect]),
    );
    const falsePositiveCasesById = new Map(
      (falsePositiveCases.cases as Array<Record<string, unknown>>).map((testCase) => [
        testCase.falsePositiveCaseId as string,
        testCase,
      ]),
    );
    const reportOracleById = new Map(
      (benchmarkReport.seededDefectOracle as Array<Record<string, unknown>>).map((defect) => [
        defect.seededDefectId as string,
        defect,
      ]),
    );
    const reportFindings = benchmarkReport.findingRecords as Array<Record<string, unknown>>;
    const reportFindingsBySeededDefectId = new Map(
      reportFindings
        .filter((finding) => typeof finding.seededDefectId === "string")
        .map((finding) => [finding.seededDefectId as string, finding]),
    );

    for (const seededDefect of seededDefects) {
      const defectId = seededDefect.seededDefectId as string;
      const category = seededDefect.category as string;
      const qualitySubcategory = seededDefect.qualitySubcategory as string;
      expect(
        categorySubcategories.get(category)?.has(qualitySubcategory),
        `${defectId} uses known taxonomy pair ${category}/${qualitySubcategory}`,
      ).toBe(true);

      const seededDefectKind = asTestRecord(
        seededDefectKinds.get(seededDefect.seedKind as string),
        `taxonomy seededDefectKinds.${String(seededDefect.seedKind)}`,
      );
      expect(seededDefectKind).toMatchObject({
        category,
        subcategory: qualitySubcategory,
        expectedRootCause: seededDefect.expectedRootCause,
      });

      const reportOracle = asTestRecord(
        reportOracleById.get(defectId),
        `report oracle ${defectId}`,
      );
      expect(reportOracle).toMatchObject({
        seedKind: seededDefect.seedKind,
        category,
        qualitySubcategory,
        qualitySeverity: seededDefect.qualitySeverity,
        expectedRootCause: seededDefect.expectedRootCause,
      });
      expect(new Set(reportOracle.expectedDetectorKinds as string[])).toEqual(
        new Set(seededDefect.expectedDetectorKinds as string[]),
      );

      const reportFinding = asTestRecord(
        reportFindingsBySeededDefectId.get(defectId),
        `report finding for ${defectId}`,
      );
      expect(reportFinding).toMatchObject({
        category,
        qualitySubcategory,
        qualitySeverity: seededDefect.qualitySeverity,
      });
    }

    for (const coverage of coverageMatrix.coverage as Array<Record<string, unknown>>) {
      const category = coverage.category as string;
      const qualitySubcategory = coverage.qualitySubcategory as string;
      expect(
        categorySubcategories.get(category)?.has(qualitySubcategory),
        `${String(coverage.acceptanceCase)} uses known taxonomy pair`,
      ).toBe(true);

      for (const defectId of (coverage.seededDefectIds as string[] | undefined) ?? []) {
        const seededDefect = asTestRecord(
          seededDefectsById.get(defectId),
          `coverage seeded defect ${defectId}`,
        );
        expect(seededDefect).toMatchObject({ category, qualitySubcategory });
      }

      for (const falsePositiveCaseId of (coverage.falsePositiveCaseIds as string[] | undefined) ??
        []) {
        const falsePositiveCase = asTestRecord(
          falsePositiveCasesById.get(falsePositiveCaseId),
          `coverage false positive ${falsePositiveCaseId}`,
        );
        expect(falsePositiveCase).toMatchObject({
          candidateCategory: category,
          candidateQualitySubcategory: qualitySubcategory,
        });
      }
    }

    for (const falsePositiveCase of falsePositiveCases.cases as Array<Record<string, unknown>>) {
      const finding = asTestRecord(
        reportFindings.find((candidate) =>
          (candidate.affectedRefs as Array<Record<string, unknown>>).some(
            (affectedRef) => affectedRef.subjectId === falsePositiveCase.affectedBridgeUnitId,
          ),
        ),
        `report false positive ${String(falsePositiveCase.falsePositiveCaseId)}`,
      );
      expect(finding).toMatchObject({
        detectorKind: falsePositiveCase.detectorKind,
        category: falsePositiveCase.candidateCategory,
        qualitySubcategory: falsePositiveCase.candidateQualitySubcategory,
        qualitySeverity: falsePositiveCase.qualitySeverity,
        adjudicationState: falsePositiveCase.adjudicationState,
      });
    }

    const fixtureRef = asTestRecord(
      (benchmarkReport.fixtureOrCorpusRefs as Array<Record<string, unknown>>).find(
        (ref) => ref.manifestUri === "fixtures/public/seeded-localization-defects.manifest.json",
      ),
      "seeded benchmark report fixture ref",
    );
    expect(fixtureRef.manifestHash).toBe(
      `sha256:${publicFixtureSha256("fixtures/public/seeded-localization-defects.manifest.json")}`,
    );
  });

  it("accepts the v0.2 bridge surface example", () => {
    const bridge = bridgeV02Example();

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();

    const units = bridge.units as Array<{ speaker?: { knowledgeState?: string } }>;
    const speakerStates = units.map((unit) => unit.speaker?.knowledgeState).filter(Boolean);
    expect(speakerStates).toContain("parser_unknown");
    expect(speakerStates).toContain("reader_unknown");
    expect(speakerStates).toContain("known");
    expect(speakerStates).toContain("not_applicable");
  });

  it("types speaker truth across a resolved+unresolved mix without false parser_unknown", () => {
    // Bridge v0.2 additively carries raw speaker text, resolved display
    // identity, reader-safe label, canonical ref, reveal state, and RGB. A
    // resolved name stays `known` / `reader_unknown` — never mislabelled
    // `parser_unknown` just because the reader is masked or colour is present.
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);

    const known = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState === "known" &&
        unit.surfaceKind === "dialogue",
    );
    expect(known).toBeDefined();
    const knownSpeaker = asTestRecord(known!.speaker, "known dialogue speaker");
    expect(knownSpeaker.knowledgeState).toBe("known");
    expect(knownSpeaker.displayName).toBe("Mira");
    expect(knownSpeaker.canonicalNameRef).toBe("character/mira");
    expect(knownSpeaker.revealState).toBe("revealed");
    expect(knownSpeaker.textColor).toEqual([204, 204, 255]);
    expect(knownSpeaker.knowledgeState).not.toBe("parser_unknown");

    const readerUnknown = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState ===
        "reader_unknown",
    );
    expect(readerUnknown).toBeDefined();
    const maskedSpeaker = asTestRecord(readerUnknown!.speaker, "reader_unknown speaker");
    expect(maskedSpeaker.knowledgeState).toBe("reader_unknown");
    expect(maskedSpeaker.displayName).toBe("Rook");
    expect(maskedSpeaker.readerLabel).toBe("???");
    expect(maskedSpeaker.canonicalNameRef).toBe("character/rook");
    expect(maskedSpeaker.revealState).toBe("concealed");
    expect(maskedSpeaker.textColor).toEqual([180, 180, 180]);
    // A resolved-but-concealed identity is NOT parser_unknown.
    expect(maskedSpeaker.knowledgeState).not.toBe("parser_unknown");

    const parserUnknown = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState ===
        "parser_unknown",
    );
    expect(parserUnknown).toBeDefined();
    const unresolvedSpeaker = asTestRecord(parserUnknown!.speaker, "parser_unknown speaker");
    expect(unresolvedSpeaker.knowledgeState).toBe("parser_unknown");
    expect(unresolvedSpeaker.rawSpeakerText).toBe("???");
    expect(unresolvedSpeaker.evidence).toEqual(expect.any(String));
    // Genuinely unresolved speakers carry no fabricated resolved identity.
    expect(unresolvedSpeaker.displayName).toBeUndefined();
    expect(unresolvedSpeaker.speakerId).toBeUndefined();
    expect(unresolvedSpeaker.readerLabel).toBeUndefined();

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();
  });

  it("rejects malformed additive speaker revealState and textColor", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const known = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState === "known" &&
        unit.surfaceKind === "dialogue",
    );
    expect(known).toBeDefined();
    const speaker = asTestRecord(known!.speaker, "known speaker");

    speaker.revealState = "spoiler";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/revealState/);

    speaker.revealState = "revealed";
    speaker.textColor = [300, 0, 0];
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/textColor/);

    speaker.textColor = [10, 20];
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/textColor/);
  });

  it("rejects known+concealed and parser_unknown carrying resolved-name fields", () => {
    // Invariant: knowledgeState pins revealState when present.
    // A `known`+`concealed` speaker would fall into the consumer's concealed
    // branch and leak `displayName` as a supposedly reader-safe label.
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const known = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState === "known" &&
        unit.surfaceKind === "dialogue",
    );
    expect(known).toBeDefined();
    const knownSpeaker = asTestRecord(known!.speaker, "known speaker");
    knownSpeaker.revealState = "concealed";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/revealState/);

    // Restore and flip a reader_unknown to the wrong reveal value.
    knownSpeaker.revealState = "revealed";
    const readerUnknown = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState ===
        "reader_unknown",
    );
    expect(readerUnknown).toBeDefined();
    const maskedSpeaker = asTestRecord(readerUnknown!.speaker, "reader_unknown speaker");
    maskedSpeaker.revealState = "revealed";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/revealState/);
    maskedSpeaker.revealState = "concealed";

    // A genuinely unresolved speaker must not invent a resolved identity.
    const parserUnknown = units.find(
      (unit) =>
        (unit.speaker as { knowledgeState?: string } | undefined)?.knowledgeState ===
        "parser_unknown",
    );
    expect(parserUnknown).toBeDefined();
    const unresolved = asTestRecord(parserUnknown!.speaker, "parser_unknown speaker");
    unresolved.displayName = "Leaked Name";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/displayName/);
    delete unresolved.displayName;
    unresolved.speakerId = "01920000-0000-7000-8000-00000000dead";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/speakerId/);
    delete unresolved.speakerId;
    unresolved.readerLabel = "???";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/readerLabel/);
    delete unresolved.readerLabel;
    unresolved.canonicalNameRef = "character/leaked";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/canonicalNameRef/);
    delete unresolved.canonicalNameRef;
    unresolved.revealState = "revealed";
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/revealState/);
    delete unresolved.revealState;
    unresolved.textColor = [1, 2, 3];
    expect(() => assertBridgeBundleV02(bridge)).toThrow(/textColor/);
  });

  it("rejects duplicate v0.2 bridge unit ids", () => {
    const bridge = bridgeV02Example();
    const units = bridge.units as Array<Record<string, unknown>>;
    const firstUnit = units[0]!;
    const secondUnit = units[1]!;
    units[1] = { ...secondUnit, bridgeUnitId: firstUnit.bridgeUnitId };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(
      /BridgeBundleV02\.units\[1\]\.bridgeUnitId must be unique/,
    );
  });

  it("keeps raw MTL baselines in the benchmark report schema", () => {
    const report = benchmarkReportV02Example();

    expect(() => assertBenchmarkReportV02(report)).not.toThrow();
    expect(report.systemsCompared).toContainEqual(
      expect.objectContaining({
        systemId: "raw-mtl-baseline",
        systemKind: "raw_mtl_baseline",
      }),
    );
  });
});
