// itotori-localize-fullproject-command + durable-journal production wiring — tests.
//
// Proves the general `itotori localize <project>` whole-project driver runs a
// FULL project (every in-scope unit) for any project given its config,
// persisting canonical outcomes, physical attempts, and QA callouts to real
// Postgres before exporting a patch to disk; cost + ZDR are recorded with no
// game-specific code path.
//
// Driven with the FAKE/synthetic model provider (deterministic, zero real
// cost, no live ZDR call) against a REAL Postgres — the test validates the
// MECHANISM. A real-provider full run is the field-test loop, out of scope.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import {
  ItotoriLocalizationJournalRepository,
  ItotoriTranslationScopeSettingsRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  localUserId,
  migrate,
  type AuthorizationActor,
  type DatabaseContext,
} from "@itotori/db";
import {
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  DrivenJournalPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "../src/orchestrator/project-driven-executor-sinks.js";
import {
  buildStructureResolver,
  parseLocalizeFullProjectConfig,
  runLocalizeFullProjectCommand,
  type LocalizeFullProjectConfig,
  type LocalizeFullProjectIo,
} from "../src/orchestrator/localize-fullproject-command.js";
import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
} from "../src/structure/index.js";
import type { WholeGameRenderValidationResult } from "../src/orchestrator/wholegame-render-validation-seam.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

// --- ids (text columns; UUID-ish so a shared DB never collides) -------------
const PROJECT_ID = "019ed0dd-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0dd-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0dd-0000-7000-8000-000000000003";
// Per-unit content-hash revision — DELIBERATELY distinct from the run/bundle
// REVISION_ID and never seeded into itotori_source_revisions. A complete
// localization run records its canonical outcomes against the run identity,
// while preserving the per-unit source revision as provenance.
const UNIT_CONTENT_HASH_REVISION_ID = "019ed0dd-0000-7000-8000-0000000000c0";
const ASSET_ID = "019ed0dd-0000-7000-8000-000000000004";
const SPEAKER_ID = "019ed0dd-0000-7000-8000-000000000005";
const SOURCE_BUNDLE_ID = "019ed0dd-0000-7000-8000-000000000006";
const WORKSPACE_ID = "019ed0dd-0000-7000-8000-000000000007";

const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1"; // written outcome
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2"; // QA-callout
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3"; // written outcome
const UNIT_UI = "019ed0aa-0000-7000-8000-0000000000e5"; // ui_label -> OUT OF SCOPE

const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";
const GENERIC_DRAFT = "Good morning.";
const CORRECTED_DRAFT = "Good morning, Yui.";
const PRIOR_FEEDBACK_PROMPT_MARKER = "Prior pass feedback";

// ---------------------------------------------------------------------------
// Config-parse unit tests (fast, no DB)
// ---------------------------------------------------------------------------

describe("parseLocalizeFullProjectConfig (game-agnostic config)", () => {
  const base = {
    schemaVersion: "itotori.localize-fullproject.config.v0",
    projectId: "p",
    localeBranchId: "b",
    sourceRevisionId: "r",
    engineProfile: "reallive",
    bridgePath: "/x/bridge.json",
    pairPolicyPath: "/x/pair.json",
  };
  it("accepts a minimal valid config and defaults are left unset", () => {
    const parsed = parseLocalizeFullProjectConfig(base);
    expect(parsed.projectId).toBe("p");
    expect(parsed.engineProfile).toBe("reallive");
    expect(parsed.translationScope).toBeUndefined();
  });
  it("rejects an unknown engine profile and an unknown scope", () => {
    expect(() => parseLocalizeFullProjectConfig({ ...base, engineProfile: "nope" })).toThrow(
      /engineProfile/u,
    );
    expect(() =>
      parseLocalizeFullProjectConfig({ ...base, translationScope: "everything" }),
    ).toThrow(/translationScope/u);
  });
  it("rejects a wrong schemaVersion and a missing identity field", () => {
    expect(() => parseLocalizeFullProjectConfig({ ...base, schemaVersion: "v1" })).toThrow(
      /schemaVersion/u,
    );
    const { projectId: _omit, ...noProject } = base;
    expect(() => parseLocalizeFullProjectConfig(noProject)).toThrow(/projectId/u);
  });
});

// ---------------------------------------------------------------------------
// End-to-end handoff (SPLIT producers): the whole-game driver joins the ACTUAL
// `kaifuu extract --whole-seen` BRIDGE output to the ACTUAL `utsushi structure`
// STRUCTURE output via `context.route.sceneKey`, and resolves every unit whose
// scene the driven playthrough crossed.
//
// The two fixtures are the VERBATIM output of two SEPARATE, correctly-layered
// producers (deps flow utsushi → kaifuu, never back):
//   - whole-seen-bridge.json    ← `kaifuu extract --whole-seen` (pure decode;
//       no utsushi dependency). Regenerate via the kaifuu-cli
//       `regenerate_whole_seen_ts_driver_fixture` ignored test.
//   - whole-seen-structure.json ← `utsushi structure` (replay-driven; owns the
//       real scene-dispatch order). Regenerate by running `utsushi structure`
//       over the same synthetic archive (kaifuu-cli
//       `materialize_synthetic_two_scene_archive_to_scratch` probe).
//
// This proves the produced bridge's `context.route.sceneKey` shape is exactly
// what the driver's `buildStructureResolver` consumes to join the independently
// -produced structure — closing the M1 handoff WITHOUT kaifuu depending on
// utsushi. Units routed to a scene the playthrough did NOT cross graceful-
// degrade (resolver → undefined), the documented whole-game behavior; the
// strong multi-scene proof is the env-gated real-Sweetie test.
// ---------------------------------------------------------------------------

describe("whole-game driver joins the REAL bridge + REAL structure by sceneKey", () => {
  const wholeSeenBridge = JSON.parse(
    readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8"),
  ) as { units: LocalizationUnitV02[] };
  const wholeSeenStructure = parseNarrativeStructure(
    JSON.parse(
      readFileSync(new URL("./fixtures/whole-seen-structure.json", import.meta.url), "utf8"),
    ),
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );

  it("resolves every unit whose scene the structure's real dispatch order crossed", () => {
    const units = wholeSeenBridge.units;
    expect(units.length).toBeGreaterThan(0);

    // Every bridge unit carries the numeric-bearing `scene-NNNN` route key the
    // resolver reads — the join key between the two producers.
    for (const unit of units) {
      expect(unit.context.route?.sceneKey).toMatch(/^scene-\d{4}$/u);
    }

    // The structure is the UTSUSHI-produced narrative structure whose
    // `sceneDispatchOrder` is the REAL play-loop dispatch order (the order
    // `observe_playthrough` crossed scenes), NOT archive slot order.
    const structureScenes = new Set(wholeSeenStructure.sceneDispatchOrder);
    expect(structureScenes.size).toBeGreaterThan(0);

    // The driver's OWN resolver — the exact seam the whole-game localize command
    // uses — joins each bridge unit to the structure by parsing its sceneKey.
    // `defaultSceneId` is set to a scene NOT in the structure so the join is
    // proven to come from the unit's OWN route key, never a blanket fallback.
    const resolver = buildStructureResolver(wholeSeenStructure, -999);
    const sceneNum = (unit: LocalizationUnitV02): number =>
      Number.parseInt(unit.context.route!.sceneKey!.replace("scene-", ""), 10);

    const resolvedScenes = new Set<number>();
    units.forEach((unit, unitIndex) => {
      const resolved = resolver({ unit, unitIndex, plannerSceneId: undefined });
      const scene = sceneNum(unit);
      if (structureScenes.has(scene)) {
        // Scene the playthrough crossed → resolves to THAT scene's structure.
        expect(resolved, `unit ${unit.bridgeUnitId} (scene ${scene}) must resolve`).toBeDefined();
        expect(resolved?.narrativeStructure).toBe(wholeSeenStructure);
        expect(resolved?.sceneId).toBe(scene);
        resolvedScenes.add(resolved!.sceneId);
      } else {
        // Scene the playthrough did NOT cross → documented graceful-degrade.
        expect(resolved, `unit ${unit.bridgeUnitId} (scene ${scene}) degrades`).toBeUndefined();
      }
    });

    // Every scene in the real dispatch order that the bridge carries units for
    // was resolved end-to-end (the join is complete over the crossed scenes).
    const bridgeScenesInStructure = new Set(
      units.map(sceneNum).filter((s) => structureScenes.has(s)),
    );
    expect(bridgeScenesInStructure.size).toBeGreaterThan(0);
    expect([...resolvedScenes].sort((a, b) => a - b)).toEqual(
      [...bridgeScenesInStructure].sort((a, b) => a - b),
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures (mirror the project-driven executor's journal behavior).
// ---------------------------------------------------------------------------

function makeStructureJson(): unknown {
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: SCENE_ID,
    sceneDispatchOrder: [SCENE_ID],
    scenes: [
      {
        sceneId: SCENE_ID,
        nextScene: null,
        messages: [
          { order: 0, speaker: SPEAKER_NAME, text: "おはよう。", textSurface: null },
          { order: 1, speaker: null, text: "青空が広がっていた。", textSurface: null },
        ],
        choices: [],
      },
    ],
  };
}

function makeUnit(
  bridgeUnitId: string,
  sourceText: string,
  surfaceKind: LocalizationUnitV02["surfaceKind"],
  lineNo: number,
): LocalizationUnitV02 {
  const key = `scene-${SCENE_ID}/line-${String(lineNo).padStart(3, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind,
    sourceUnitKey: key,
    occurrenceId: `occ-${lineNo}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `src-hash-${bridgeUnitId}`,
    sourceRevision: {
      revisionId: UNIT_CONTENT_HASH_REVISION_ID,
      revisionKind: "content_hash",
      value: "rev",
    },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "asset" },
    sourceLocation: { containerKey: "asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: { route: { sceneKey: `scene-${String(SCENE_ID).padStart(4, "0")}` } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: key,
      sourceRevision: {
        revisionId: UNIT_CONTENT_HASH_REVISION_ID,
        revisionKind: "content_hash",
        value: "rev",
      },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeBridge(): BridgeBundleV02 {
  const units: LocalizationUnitV02[] = [
    makeUnit(UNIT_A, "おはよう、和人。", "dialogue", 1),
    makeUnit(UNIT_B, "今日は和人に会った。", "dialogue", 2),
    makeUnit(UNIT_C, "いい天気だね。", "dialogue", 3),
    makeUnit(UNIT_UI, "設定", "ui_label", 4),
  ];
  return {
    schemaVersion: "0.2.0",
    bridgeId: "fullproject-fixture",
    sourceLocale: "ja-JP",
    units,
  } as unknown as BridgeBundleV02;
}

function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const blob = JSON.stringify(request);
  const match = blob.match(/019ed0aa-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) {
    throw new Error("fake provider could not locate a bridge unit id in the request");
  }
  return match[0];
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fake-narration",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string, draftText: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fake-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function criticalQaContent(bridgeUnitId: string): string {
  const finding: QaFinding = {
    findingId: `${bridgeUnitId}-critical-finding`,
    bridgeUnitId,
    severity: "critical",
    category: "mistranslation",
    evidenceRefs: [],
    recommendation: "fixture: the generic draft dropped the speaker name",
    agentRationale: "fake-critical-finding",
  };
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [finding],
  });
}

function cleanQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

/**
 * UNIT_B carries a critical QA annotation on the blank first pass. A second
 * pass must see the journal-derived feedback block and emit the corrected
 * target, proving that the durable journal (not an in-memory result) drives
 * multi-pass iteration.
 */
function makeCaptureFactory(): {
  factory: AgenticLoopProviderFactory;
  priorFeedbackSeen: Map<string, boolean>;
} {
  const priorFeedbackSeen = new Map<string, boolean>();
  const factory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `fullproject-fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        const blob = JSON.stringify(request);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "draft_translation") {
          const unitId = bridgeUnitIdOf(request);
          const sawPriorFeedback = blob.includes(PRIOR_FEEDBACK_PROMPT_MARKER);
          priorFeedbackSeen.set(unitId, sawPriorFeedback);
          if (unitId === UNIT_B) {
            return translationContent(unitId, sawPriorFeedback ? CORRECTED_DRAFT : GENERIC_DRAFT);
          }
          return translationContent(unitId, GENERIC_DRAFT);
        }
        if (request.taskKind === "llm_qa") {
          if (blob.includes(UNIT_B) && blob.includes(GENERIC_DRAFT)) {
            return criticalQaContent(UNIT_B);
          }
          return cleanQaContent();
        }
        return "";
      },
    });
  return { factory, priorFeedbackSeen };
}

// --- fs-backed io + config/fixture materialization --------------------------

function fsIo(): LocalizeFullProjectIo {
  return {
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
    writeJson: (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
  };
}

/** Materialize the bridge + structure + pair-policy + config into a temp dir. */
function materializeProject(dir: string): {
  configPath: string;
  config: LocalizeFullProjectConfig;
} {
  const bridgePath = join(dir, "bridge.json");
  const structurePath = join(dir, "structure.json");
  const pairPolicyPath = join(dir, "pair-policy.json");
  const configPath = join(dir, "localize.config.json");
  writeFileSync(bridgePath, JSON.stringify(makeBridge()));
  writeFileSync(structurePath, JSON.stringify(makeStructureJson()));
  // Reuse the checked-in v0.3 pair-policy fixture (DEV_PAIR).
  const pairPolicyFixture = new URL(
    "./fixtures/agentic-loop-smoke-pair-policy.json",
    import.meta.url,
  );
  writeFileSync(pairPolicyPath, readFileSync(pairPolicyFixture, "utf8"));
  const config: LocalizeFullProjectConfig = {
    schemaVersion: "itotori.localize-fullproject.config.v0",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    engineProfile: "reallive",
    translationScope: "dialogue-only",
    targetLocale: "en-US",
    bridgePath,
    pairPolicyPath,
    structureJsonPath: structurePath,
    dataRoot: "/scratch/itotori-research/fixture-project",
    maxRepairAttempts: 0,
  };
  writeFileSync(configPath, JSON.stringify(config));
  return { configPath, config };
}

async function seedProjectScope(pool: DatabaseContext["pool"]): Promise<void> {
  await pool.query("delete from itotori_localization_journal_runs where project_id = $1", [
    PROJECT_ID,
  ]);
  await pool.query("delete from itotori_projects where project_id = $1", [PROJECT_ID]);
  await pool.query(
    `insert into itotori_workspaces (workspace_id, name) values ($1, $2)
     on conflict (workspace_id) do nothing`,
    [WORKSPACE_ID, "fullproject pilot"],
  );
  await pool.query(
    `insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [PROJECT_ID, WORKSPACE_ID, "fullproject-pilot", "Fullproject Pilot", "ja-JP", "imported"],
  );
  await pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values ($1, $2, $3, $4)`,
    [REVISION_ID, PROJECT_ID, "bridge_revision", "fullproject-v1"],
  );
  await pool.query(
    `insert into itotori_source_bundles (
       source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
       schema_version, source_bundle_hash, source_locale,
       extractor_name, extractor_version, unit_count, asset_count
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0)`,
    [
      SOURCE_BUNDLE_ID,
      PROJECT_ID,
      REVISION_ID,
      "bridge-fullproject",
      "0.2.0",
      "hash:fullproject",
      "ja-JP",
      "structure-export",
      "1.0.0",
    ],
  );
  await pool.query(
    `insert into itotori_locale_branches (
       locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
     ) values ($1, $2, $3, $4, $5, $6)`,
    [LOCALE_BRANCH_ID, PROJECT_ID, SOURCE_BUNDLE_ID, "en-US", "English", "active"],
  );
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 6, 6, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

// ---------------------------------------------------------------------------
// The real-Postgres MECHANISM test (fake provider, no real cost / ZDR call)
// ---------------------------------------------------------------------------

describe("runLocalizeFullProjectCommand (full-project durable journal, real DB)", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "writes every in-scope unit and exports a complete patch without a deferred or human-routed result",
    async () => {
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };

      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const workDir = mkdtempSync(join(tmpdir(), "itotori-fullproject-"));
        const { configPath } = materializeProject(workDir);
        const io = fsIo();

        const runJournal = async (runLabel: string) => {
          const capture = makeCaptureFactory();
          const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
          const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
          const runDir = join(workDir, runLabel);
          mkdirSync(runDir, { recursive: true });
          const patchSink = new FsDrivenPatchExportSink(runDir);
          const clock = deterministicClock();
          const out = await runLocalizeFullProjectCommand({
            configPath,
            deps: {
              io,
              actor,
              providerFactory: capture.factory,
              sinks: { journal, patchExport: patchSink },
              now: clock,
            },
          });
          return { out, capture, runDir, patchSink };
        };

        const journalRun = await runJournal("journal-run");
        const result = journalRun.out.result;

        // Full-project drive: 3 dialogue units in scope, the ui_label OUT of scope.
        expect(result.unitsEnumerated).toBe(4);
        expect(result.unitsInScope).toBe(3);
        expect(result.unitsRun).toBe(3);
        // A critical QA finding remains an annotation on UNIT_B's selected
        // candidate; it cannot withhold the text or make the scope partial.
        expect(result.writtenOutcomeCount).toBe(3);
        expect(result.journalUnitsPersisted).toBe(3);
        expect(result.attemptsPersisted).toBeGreaterThan(3);
        expect(result.patchReport.coverageComplete).toBe(true);
        // Fake provider: real cost is a genuine zero; ZDR recorded true.
        expect(result.totalUsageCostUsd).toBe(0);
        expect(result.zdrConfirmed).toBe(true);

        // Patch exported to disk.
        expect(journalRun.patchSink.exportCount).toBe(1);
        expect(existsSync(join(journalRun.runDir, "translated-bridge.json"))).toBe(true);
        expect(existsSync(join(journalRun.runDir, "patch-report.json"))).toBe(true);
        // The inner driven command is preterminal; only node 5's durable
        // finalizer may emit the canonical run-summary projection.
        expect(existsSync(join(journalRun.runDir, "run-summary.json"))).toBe(false);

        // The journal read model is the durable source of truth: it returns
        // canonical selected bodies, all candidates, QA rationale, speaker
        // labels, and every physical provider attempt for this exact run.
        const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
        const persistedRun = await journalRepo.loadRun(actor, result.journalRunId);
        expect(persistedRun).toMatchObject({
          runId: result.journalRunId,
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: REVISION_ID,
          targetLocale: "en-US",
        });
        const outcomes = await journalRepo.loadRunOutcomes(actor, result.journalRunId);
        const attempts = await journalRepo.loadAttemptsForRun(actor, result.journalRunId);
        expect(outcomes).toHaveLength(3);
        expect(attempts).toHaveLength(result.attemptsPersisted);
        for (const outcome of outcomes) {
          const selected = outcome.candidates.find(
            (candidate) => candidate.id === outcome.outcome.selectedCandidateId,
          );
          expect(selected?.body.trim()).not.toHaveLength(0);
        }
        const flagged = outcomes.find((outcome) => outcome.bridgeUnitId === UNIT_B)!;
        expect(flagged.outcome.selectedCandidateId).toBe(flagged.candidates[0]?.id);
        expect(flagged.candidates).toHaveLength(1);
        // Every focused QA agent emits the same critical fixture finding. The
        // journal retains all four agent observations and their individual
        // renderable rationales instead of reducing them to a pass-level flag.
        expect(flagged.findings).toHaveLength(4);
        expect(flagged.findings.map((finding) => flagged.qaDetails[finding.id])).toEqual(
          Array.from({ length: 4 }, () =>
            expect.objectContaining({
              recommendation: "fixture: the generic draft dropped the speaker name",
              agentRationale: "fake-critical-finding",
            }),
          ),
        );
        expect(flagged.speakerLabels).toHaveLength(1);

        // A critical QA observation stays attached to UNIT_B's existing
        // selected candidate. The complete patch has neither a deferred unit
        // nor a human-routing projection anywhere in its run/report/output.
        const translatedBridge = JSON.parse(
          readFileSync(join(journalRun.runDir, "translated-bridge.json"), "utf8"),
        ) as {
          units: Array<{ bridgeUnitId: string; target?: { text?: string } }>;
        };
        const translatedInScope = translatedBridge.units.filter((unit) =>
          [UNIT_A, UNIT_B, UNIT_C].includes(unit.bridgeUnitId),
        );
        expect(translatedInScope).toHaveLength(3);
        for (const unit of translatedInScope) {
          expect(unit.target?.text.trim().length).toBeGreaterThan(0);
        }
        expect(
          JSON.stringify({ result, outcomes, patchReport: result.patchReport, translatedBridge }),
        ).not.toMatch(/(?:deferred|human.{0,16}queue|reviewer.{0,16}queue)/iu);
      } finally {
        await context.close();
      }
    },
    120_000,
  );

  it.skipIf(!process.env.DATABASE_URL)(
    "pass 2 consumes pass 1 selected text and QA feedback from the durable journal",
    async () => {
      // This regression reads the pass-1 journal while pass 2 is running.
      // Give it a migrated schema of its own so full-suite DB workers cannot
      // delete/reseed the fixed fixture project between those two passes.
      const context = await isolatedMigratedContext();
      const actor: AuthorizationActor = { userId: localUserId };

      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const workDir = mkdtempSync(join(tmpdir(), "itotori-fullproject-journal-passes-"));
        const { configPath } = materializeProject(workDir);
        const io = fsIo();
        const journalRepo = new ItotoriLocalizationJournalRepository(context.db);

        const runJournalPass = async (label: string) => {
          const capture = makeCaptureFactory();
          const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
          const runDir = join(workDir, label);
          mkdirSync(runDir, { recursive: true });
          const patchSink = new FsDrivenPatchExportSink(runDir);
          const out = await runLocalizeFullProjectCommand({
            configPath,
            deps: {
              io,
              actor,
              providerFactory: capture.factory,
              sinks: { journal, patchExport: patchSink },
              // The new read path: pass N+1 obtains prior state directly from
              // normalized journal runs/outcomes, not a legacy pass record.
              journalHistory: journalRepo,
              now: deterministicClock(),
            },
          });
          return { out, capture, patchSink, runDir };
        };

        const pass1 = await runJournalPass("pass-1");
        expect(pass1.out.priorJournalRun).toBeUndefined();
        expect(pass1.capture.priorFeedbackSeen.get(UNIT_B)).toBe(false);
        expect(pass1.out.result.writtenOutcomeCount).toBe(3);
        expect(pass1.out.result.patchReport.coverageComplete).toBe(true);

        const pass1Outcomes = await journalRepo.loadRunOutcomes(
          actor,
          pass1.out.result.journalRunId,
        );
        const pass1UnitB = pass1Outcomes.find((outcome) => outcome.bridgeUnitId === UNIT_B);
        expect(
          pass1UnitB?.candidates.find(
            (candidate) => candidate.id === pass1UnitB.outcome.selectedCandidateId,
          )?.body,
        ).toBe(GENERIC_DRAFT);
        expect(pass1UnitB?.outcome.qualityFlags).toEqual(
          expect.arrayContaining(["qa_unresolved", "repair_budget_exhausted"]),
        );
        expect(Object.values(pass1UnitB?.qaDetails ?? {})).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recommendation: "fixture: the generic draft dropped the speaker name",
            }),
          ]),
        );

        const pass2 = await runJournalPass("pass-2");
        // The production command read pass 1 from real Postgres before it
        // created pass 2; its lineage reports that exact durable source.
        expect(pass2.out.priorJournalRun).toEqual({
          runId: pass1.out.result.journalRunId,
          passNumber: 1,
          feedbackUnitCount: 3,
        });
        expect(pass2.capture.priorFeedbackSeen.get(UNIT_B)).toBe(true);
        expect(pass2.out.result.writtenOutcomeCount).toBe(3);
        expect(pass2.out.result.patchReport.coverageComplete).toBe(true);
        expect(pass2.patchSink.exportCount).toBe(1);

        const runs = await journalRepo.loadRunsForBranch(actor, LOCALE_BRANCH_ID);
        expect(runs.map((run) => run.runId)).toEqual([
          pass1.out.result.journalRunId,
          pass2.out.result.journalRunId,
        ]);
        const pass2Outcomes = await journalRepo.loadRunOutcomes(
          actor,
          pass2.out.result.journalRunId,
        );
        const pass2UnitB = pass2Outcomes.find((outcome) => outcome.bridgeUnitId === UNIT_B);
        expect(
          pass2UnitB?.candidates.find(
            (candidate) => candidate.id === pass2UnitB.outcome.selectedCandidateId,
          )?.body,
        ).toBe(CORRECTED_DRAFT);
        expect(pass2UnitB?.outcome.qualityFlags).toEqual([]);
        // The journal records the exact prior feedback packet/run identity that
        // produced pass 2, so the multi-pass context remains reviewable after
        // the original process exits.
        expect(pass2UnitB?.contextPacket).toMatchObject({
          priorPassFeedback: {
            passNumber: 1,
            priorDraftText: GENERIC_DRAFT,
            qualityFlags: expect.arrayContaining(["qa_unresolved"]),
            feedbackNote: expect.stringContaining(
              "fixture: the generic draft dropped the speaker name",
            ),
          },
          priorJournalRunId: pass1.out.result.journalRunId,
        });
        expect(pass2UnitB?.contextRefs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              refKind: "prior_pass_feedback",
              refId: pass1.out.result.journalRunId,
              details: expect.objectContaining({
                passNumber: 1,
                priorDraftText: GENERIC_DRAFT,
              }),
            }),
          ]),
        );
      } finally {
        await context.close();
      }
    },
    120_000,
  );

  it.skipIf(!process.env.DATABASE_URL)(
    "returns whole-game render-validation findings alongside the durable journal result",
    async () => {
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };

      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const workDir = mkdtempSync(join(tmpdir(), "itotori-fullproject-render-"));
        const { configPath } = materializeProject(workDir);
        const io = fsIo();

        const runJournal = async (
          runLabel: string,
          runtimeValidation: WholeGameRenderValidationResult | undefined,
        ) => {
          const capture = makeCaptureFactory();
          const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
          const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
          const runDir = join(workDir, runLabel);
          mkdirSync(runDir, { recursive: true });
          const patchSink = new FsDrivenPatchExportSink(runDir);
          const out = await runLocalizeFullProjectCommand({
            configPath,
            deps: {
              io,
              actor,
              providerFactory: capture.factory,
              sinks: { journal, patchExport: patchSink },
              ...(runtimeValidation !== undefined
                ? { afterExecutor: (result) => ({ ...result, runtimeValidation }) }
                : {}),
              now: deterministicClock(),
            },
          });
          return { out, capture };
        };

        const runtimeValidation: WholeGameRenderValidationResult = {
          schemaVersion: "itotori.wholegame-render-validation.v0",
          redaction: "on",
          coverage: {
            acceptedUnitCount: 2,
            candidateUnitCount: 1,
            selectedUnitCount: 1,
            candidateSceneCount: 1,
            validatedSceneCount: 1,
            sampled: false,
            sceneIds: [SCENE_ID],
            selectedUnitIds: [UNIT_A],
            skippedUnitIds: [],
          },
          findings: [
            {
              phase: "render-validate",
              bridgeUnitId: UNIT_A,
              sourceUnitKey: `scene-${SCENE_ID}/line-001`,
              sceneId: SCENE_ID,
              code: "native-cli-failed",
              message: `whole-game render-validate failed for unit ${UNIT_A} (scene 6010)`,
              diagnostic: {
                step: "localize.render-validate",
                code: "unknown",
                message: `whole-game render-validate failed for unit ${UNIT_A} (scene 6010)`,
                failingUnitId: UNIT_A,
                sceneId: SCENE_ID,
                inputs: { sceneId: SCENE_ID, expectedTextContains: "[REDACTED]" },
                repro: {
                  bridgeUnitId: UNIT_A,
                  sourceUnitKey: `scene-${SCENE_ID}/line-001`,
                  sceneId: SCENE_ID,
                },
                error: {
                  class: "Error",
                  message: "utsushi-cli render-validate exited with status 1",
                },
                occurredAt: new Date(Date.UTC(2026, 6, 8, 12, 0, 0)).toISOString(),
                schemaVersion: "itotori.pipeline-failure-diagnostic.v0",
              },
              artifactRefs: {
                replayLog: `artifacts/wholegame-render-validation/scene-6010/unit-${UNIT_A}/replay-log.json`,
                renderEvidence: `artifacts/wholegame-render-validation/scene-6010/unit-${UNIT_A}/render-evidence.json`,
              },
            },
          ],
        };

        const journalRun = await runJournal("journal-run", runtimeValidation);
        expect(journalRun.out.result.runtimeValidation?.coverage.validatedSceneCount).toBe(1);
        expect(journalRun.out.result.runtimeValidation?.findings).toHaveLength(1);
        expect(journalRun.out.result.runtimeValidation?.findings[0]?.bridgeUnitId).toBe(UNIT_A);
        expect(journalRun.out.result.runtimeValidation?.redaction).toBe("on");
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// itotori-translation-scope-configuration-ui — proves the DB-backed
// translation-scope DEFAULT (the Studio "Translation scope" settings screen
// persists via `settings.translationScope.save` ->
// `ItotoriTranslationScopeSettingsRepository.saveSettings`) is the SAME value
// `runLocalizeFullProjectCommand` reads when a run's config JSON omits
// `translationScope` — through the REAL repository (real Postgres), not a
// fake double standing in for persistence.
// ---------------------------------------------------------------------------

describe("runLocalizeFullProjectCommand reads the DB-backed translation-scope default", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "a scope saved via the settings repository is the SAME scope the localize command resolves and drives with",
    async () => {
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };

      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        // This is the EXACT repository the `settings.translationScope.save`
        // API route persists through (packages/itotori-db/src/repositories/
        // translation-scope-settings-repository.ts) and the live CLI
        // (localize-fullproject-cli.ts) resolves through.
        const translationScopeSettingsRepo = new ItotoriTranslationScopeSettingsRepository(
          context.db,
        );

        // A project/branch owner configured the "+ UI text" tier via the
        // Studio settings screen (write path proven independently by
        // packages/itotori-db/test/translation-scope-settings-repository.test.ts
        // and apps/itotori/test/api-handlers.test.ts).
        const saved = await translationScopeSettingsRepo.saveSettings(actor, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          scope: "dialogue-choices-ui",
        });
        expect(saved.scope).toBe("dialogue-choices-ui");

        const workDir = mkdtempSync(join(tmpdir(), "itotori-fullproject-scope-default-"));
        const { configPath } = materializeProject(workDir);
        // Strip the explicit `translationScope` the fixture config normally
        // pins, so the command must fall back to the DB-backed default —
        // exactly what a Studio-configured run (no explicit scope override in
        // its generated config) looks like.
        const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
        delete rawConfig.translationScope;
        writeFileSync(configPath, JSON.stringify(rawConfig));
        const io = fsIo();

        const capture = makeCaptureFactory();
        const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
        const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
        const runDir = join(workDir, "pass-1");
        mkdirSync(runDir, { recursive: true });
        const patchSink = new FsDrivenPatchExportSink(runDir);

        const out = await runLocalizeFullProjectCommand({
          configPath,
          deps: {
            io,
            actor,
            providerFactory: capture.factory,
            sinks: { journal, patchExport: patchSink },
            // The REAL production port: reads through the SAME repository
            // instance the save above just wrote through.
            translationScopeSettings: {
              resolveScope: (projectId, localeBranchId) =>
                translationScopeSettingsRepo.resolveScope(projectId, localeBranchId),
            },
            now: deterministicClock(),
          },
        });

        // The persisted "dialogue-choices-ui" scope is what the command
        // resolved and recorded in the exact journal-backed patch report.
        expect(out.result.patchReport.translationScope).toBe("dialogue-choices-ui");

        // Behavior proof, not just a label: the ui_label unit (UNIT_UI, out of
        // scope under the "dialogue-only" default proven in the sibling
        // describe block above) is now IN SCOPE because "dialogue-choices-ui"
        // includes the UI tier.
        expect(out.result.unitsEnumerated).toBe(4);
        expect(out.result.unitsInScope).toBe(4);
        expect(out.result.unitsRun).toBe(4);

        // No provisional summary may fabricate terminal coverage from this
        // preterminal command; the durable finalizer projects it later.
        expect(existsSync(join(runDir, "run-summary.json"))).toBe(false);

        // Re-reading the setting directly (the same read a second run, or the
        // Studio GET route, would perform) confirms it is durably persisted,
        // not an artifact of this one process's cache.
        const reread = await translationScopeSettingsRepo.resolveScope(
          PROJECT_ID,
          LOCALE_BRANCH_ID,
        );
        expect(reread).toBe("dialogue-choices-ui");
      } finally {
        await context.close();
      }
    },
    120_000,
  );

  it.skipIf(!process.env.DATABASE_URL)(
    "an EXPLICIT config.translationScope still wins over the persisted DB default",
    async () => {
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };

      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const translationScopeSettingsRepo = new ItotoriTranslationScopeSettingsRepository(
          context.db,
        );
        // Persist "all" in the DB, but the run config below pins
        // "dialogue-only" explicitly — the explicit config value must win.
        await translationScopeSettingsRepo.saveSettings(actor, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          scope: "all",
        });

        const workDir = mkdtempSync(join(tmpdir(), "itotori-fullproject-scope-override-"));
        const { configPath } = materializeProject(workDir); // pins "dialogue-only"
        const io = fsIo();

        const capture = makeCaptureFactory();
        const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
        const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
        const runDir = join(workDir, "pass-1");
        mkdirSync(runDir, { recursive: true });
        const patchSink = new FsDrivenPatchExportSink(runDir);

        const out = await runLocalizeFullProjectCommand({
          configPath,
          deps: {
            io,
            actor,
            providerFactory: capture.factory,
            sinks: { journal, patchExport: patchSink },
            translationScopeSettings: {
              resolveScope: (projectId, localeBranchId) =>
                translationScopeSettingsRepo.resolveScope(projectId, localeBranchId),
            },
            now: deterministicClock(),
          },
        });

        expect(out.result.patchReport.translationScope).toBe("dialogue-only");
        expect(out.result.unitsInScope).toBe(3); // UNIT_UI stays out of scope
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});
