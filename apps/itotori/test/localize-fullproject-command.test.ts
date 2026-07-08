// itotori-localize-fullproject-cli + pass-ledger-production-wiring — tests.
//
// Proves the two bundled nodes TOGETHER:
//   NODE 1 — the general `itotori localize <project>` whole-project driver runs
//     a FULL project (every in-scope unit) for any project given its config,
//     persisting drafts + reviewer-queue items to real Postgres + exporting a
//     patch to disk; cost + ZDR recorded; no game-specific code path.
//   NODE 2 — the DB-backed `PassLedgerPort` (DbPassLedger over the
//     `itotori_localization_pass_ledger` table) persists each pass, and the
//     driver runs THROUGH `runLocalizationPass` so a live pass N+1 CONSUMES the
//     persisted pass N feedback + accepted state.
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
  ItotoriDraftAttemptProviderLedgerRepository,
  ItotoriDraftJobRepository,
  ItotoriLocalizationPassLedgerRepository,
  ItotoriReviewerQueueRepository,
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
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  DrivenDbPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "../src/orchestrator/project-driven-executor-sinks.js";
import { DbPassLedger } from "../src/orchestrator/pass-ledger-db-adapter.js";
import {
  buildStructureResolver,
  parseLocalizeFullProjectConfig,
  runLocalizeFullProjectCommand,
  type LocalizeFullProjectConfig,
  type LocalizeFullProjectIo,
} from "../src/orchestrator/localize-fullproject-command.js";
import { parseNarrativeStructure } from "../src/agents/structure-informed-context/index.js";

// --- ids (text columns; UUID-ish so a shared DB never collides) -------------
const PROJECT_ID = "019ed0dd-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0dd-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0dd-0000-7000-8000-000000000003";
const ASSET_ID = "019ed0dd-0000-7000-8000-000000000004";
const SPEAKER_ID = "019ed0dd-0000-7000-8000-000000000005";
const SOURCE_BUNDLE_ID = "019ed0dd-0000-7000-8000-000000000006";
const WORKSPACE_ID = "019ed0dd-0000-7000-8000-000000000007";

const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1"; // accepted
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2"; // deferred pass 1, accepted pass 2
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3"; // accepted
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
// Fixtures (mirror project-driven-executor.test.ts / pass-ledger.test.ts)
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
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "asset" },
    sourceLocation: { containerKey: "asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: { route: { sceneKey: `scene-${String(SCENE_ID).padStart(4, "0")}` } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: key,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
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
 * Fake provider factory: UNIT_B is the FLAGGED unit whose outcome depends
 * ENTIRELY on whether the prior-pass feedback reached its translation prompt —
 * exactly the seam the DB pass ledger controls. When the "Prior pass feedback"
 * block is present it emits the corrected draft (QA clean -> accepted);
 * otherwise the generic draft (critical finding -> deferred).
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
  await pool.query("delete from itotori_localization_pass_ledger where project_id = $1", [
    PROJECT_ID,
  ]);
  await pool.query("delete from itotori_reviewer_queue_transitions where locale_branch_id = $1", [
    LOCALE_BRANCH_ID,
  ]);
  await pool.query("delete from itotori_reviewer_queue_items where project_id = $1", [PROJECT_ID]);
  await pool.query("delete from itotori_draft_jobs where project_id = $1", [PROJECT_ID]);
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

describe("runLocalizeFullProjectCommand (full-project drive + persisted pass N->N+1, real DB)", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "drives every in-scope unit, persists drafts + reviewer items + the pass record, exports a patch, and pass 2 consumes persisted pass 1",
    async () => {
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };

      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const passLedgerRepo = new ItotoriLocalizationPassLedgerRepository(context.db);
        const passLedger = new DbPassLedger(passLedgerRepo);

        const workDir = mkdtempSync(join(tmpdir(), "itotori-fullproject-"));
        const { configPath } = materializeProject(workDir);
        const io = fsIo();

        const runOnePass = async (runLabel: string) => {
          const capture = makeCaptureFactory();
          const draftJobRepo = new ItotoriDraftJobRepository(context.db);
          const ledgerRepo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
          const reviewerQueueRepo = new ItotoriReviewerQueueRepository(context.db);
          const dbAdapter = new DrivenDbPersistenceAdapter(draftJobRepo, ledgerRepo, {
            projectId: PROJECT_ID,
            localeBranchId: LOCALE_BRANCH_ID,
            actor,
            pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
          });
          const runDir = join(workDir, runLabel);
          mkdirSync(runDir, { recursive: true });
          const patchSink = new FsDrivenPatchExportSink(runDir);
          const clock = deterministicClock();
          const out = await runLocalizeFullProjectCommand({
            configPath,
            runSummaryPath: join(runDir, "run-summary.json"),
            deps: {
              io,
              actor,
              providerFactory: capture.factory,
              sinks: { draft: dbAdapter, providerRun: dbAdapter, patchExport: patchSink },
              passLedger,
              reviewerQueue: { repository: reviewerQueueRepo },
              now: clock,
            },
          });
          return { out, capture, runDir, patchSink };
        };

        // ---------------- PASS 1 (blank first pass) ----------------
        const pass1 = await runOnePass("pass-1");
        const p1 = pass1.out;

        // Full-project drive: 3 dialogue units in scope, the ui_label OUT of scope.
        expect(p1.result.unitsEnumerated).toBe(4);
        expect(p1.result.unitsInScope).toBe(3);
        expect(p1.result.unitsRun).toBe(3);
        // UNIT_B deferred (flagged), UNIT_A + UNIT_C accepted.
        expect(p1.result.acceptedDraftCount).toBe(2);
        expect(p1.result.deferredCount).toBe(1);
        // Pass 1 is a blank first pass — the ledger recorded pass 1, no prior.
        expect(p1.record.passNumber).toBe(1);
        expect(p1.record.priorPassNumber).toBeUndefined();
        expect(p1.prior).toBeUndefined();
        // Fake provider: real cost is a genuine zero; ZDR recorded true.
        expect(p1.result.totalUsageCostUsd).toBe(0);
        expect(p1.result.zdrConfirmed).toBe(true);
        expect(pass1.capture.priorFeedbackSeen.get(UNIT_B)).toBe(false);

        // Patch exported to disk.
        expect(pass1.patchSink.exportCount).toBe(1);
        expect(existsSync(join(pass1.runDir, "translated-bridge.json"))).toBe(true);
        expect(existsSync(join(pass1.runDir, "patch-report.json"))).toBe(true);
        expect(existsSync(join(pass1.runDir, "run-summary.json"))).toBe(true);

        // Drafts + reviewer items landed in REAL Postgres.
        const draftJobsAfter1 = Number(
          (
            await context.pool.query(
              "select count(*)::int as n from itotori_draft_jobs where project_id = $1",
              [PROJECT_ID],
            )
          ).rows[0].n,
        );
        expect(draftJobsAfter1).toBe(3);
        const queueAfter1 = Number(
          (
            await context.pool.query(
              "select count(*)::int as n from itotori_reviewer_queue_items where project_id = $1",
              [PROJECT_ID],
            )
          ).rows[0].n,
        );
        expect(queueAfter1).toBe(p1.result.reviewerQueueItemCount);
        expect(queueAfter1).toBeGreaterThanOrEqual(1); // the deferred UNIT_B

        // The pass record persisted (NODE 2): one row, passNumber 1.
        const ledgerAfter1 = await context.pool.query(
          "select pass_number, prior_pass_number, total_usage_cost_usd, zdr_confirmed from itotori_localization_pass_ledger where locale_branch_id = $1 order by pass_number",
          [LOCALE_BRANCH_ID],
        );
        expect(ledgerAfter1.rows.map((r) => Number(r.pass_number))).toEqual([1]);
        expect(Number(ledgerAfter1.rows[0].total_usage_cost_usd)).toBe(0);
        expect(ledgerAfter1.rows[0].zdr_confirmed).toBe(true);

        // The DbPassLedger read path sees the persisted pass 1 (medium of iteration).
        const latest = await passLedger.loadLatestPass(actor, LOCALE_BRANCH_ID);
        expect(latest?.passNumber).toBe(1);
        const deferredUnit = latest?.outputs.unitOutcomes.find((u) => !u.accepted);
        expect(deferredUnit?.bridgeUnitId).toBe(UNIT_B);

        // ---------------- PASS 2 (consumes persisted pass 1) ----------------
        const pass2 = await runOnePass("pass-2");
        const p2 = pass2.out;

        // The driver LOADED pass 1 from the DB ledger and threaded UNIT_B's prior
        // feedback into its pass-2 translation prompt (the crux N->N+1 seam).
        expect(p2.prior?.passNumber).toBe(1);
        expect(p2.record.passNumber).toBe(2);
        expect(p2.record.priorPassNumber).toBe(1);
        expect(pass2.capture.priorFeedbackSeen.get(UNIT_B)).toBe(true);

        // Consuming the persisted feedback flipped UNIT_B to accepted.
        expect(p2.result.deferredCount).toBe(0);
        expect(p2.result.acceptedDraftCount).toBe(3);
        const pass2UnitB = p2.record.outputs.unitOutcomes.find((u) => u.bridgeUnitId === UNIT_B);
        expect(pass2UnitB?.accepted).toBe(true);
        expect(pass2UnitB?.draftText).toBe(CORRECTED_DRAFT);
        // UNIT_B is the accepted delta vs pass 1 (was deferred, now accepted).
        expect(p2.record.acceptedDeltas.map((d) => d.bridgeUnitId)).toEqual([UNIT_B]);

        // Two pass rows now persisted, chained 1 -> 2.
        const ledgerAfter2 = await context.pool.query(
          "select pass_number, prior_pass_number from itotori_localization_pass_ledger where locale_branch_id = $1 order by pass_number",
          [LOCALE_BRANCH_ID],
        );
        expect(ledgerAfter2.rows.map((r) => Number(r.pass_number))).toEqual([1, 2]);
        expect(Number(ledgerAfter2.rows[1].prior_pass_number)).toBe(1);

        // Full history round-trips through the DB adapter.
        const history = await passLedger.loadPassesForBranch(actor, LOCALE_BRANCH_ID);
        expect(history.map((h) => h.passNumber)).toEqual([1, 2]);
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});
