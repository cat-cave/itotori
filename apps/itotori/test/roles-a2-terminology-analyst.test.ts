// Terminology Analyst — mutation-falsifiable proofs. Each clause below fails if
// its guarantee is removed.
//
// Clause 1 (reasons ONLY over ambiguous candidates): the deterministic index
//   surfaces exactly the genuinely ambiguous term (conflicting policy) and hides
//   the unambiguous one; the analyst cannot rule off its dispatched candidate.
// Clause 2 (cited source-language ruling, no target form): runTermAnalyst
//   dispatches through the sole ZDR boundary, returns a term-ruling WikiObject
//   with meaning/register/source-scope/confidence, resolves every model-selected
//   occurrence label against the real snapshot, and rejects a wrong terminal, a
//   wrong served model, or a target-language object. The body carries NO target
//   form and the system stamps every ruling PROVISIONAL.
// Clause 3 (enumeration byte-derived; model lie ignored/rejected): the alias set,
//   occurrence count, and occurrence units come from the byte-derived index, not
//   the model — an alias re-count is rejected, a citation label for a non-existent
//   occurrence fails during same-snapshot resolution, and the result's
//   authoritative enumeration is the index's, never the model's.

import { describe, expect, it } from "vitest";

import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  WIKI_OBJECT_SCHEMA_VERSION,
  type CallSpec,
  type Citation,
  type RunModeValue,
  type WikiObject,
} from "../src/contracts/index.js";
import {
  assertCallUsesCertifiedRoleModelProfile,
  deepSeekV4FlashProfile,
} from "../src/llm/role-model-profiles.js";
import type { PolicyRecordV02 } from "@itotori/localization-bridge-schema";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import { CitationResolutionError } from "../src/wiki/citation-resolution.js";
import {
  ambiguousTermCandidates,
  assembleTermAnalystCallSpec,
  assertTermAnalystCertifiedRoute,
  composeTermAnalystPrompt,
  dispatchTermAnalyst,
  inlineTermPromptStore,
  isAmbiguousCandidate,
  recordedTermAnalystModel,
  readTermOccurrenceEvidence,
  runTermAnalyst,
  TermAnalystError,
  TermEnumerationError,
  TermAnalystRouteError,
  type AmbiguousTermCandidate,
  type TermAnalystRequest,
} from "../src/roles/a2/index.js";
import { ROSTER, specialistFor } from "../src/roster/index.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const HASH = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as `sha256:${string}`;

const AI_KEY = "term:ai";
const SOLO_KEY = "term:solo";

/** Two policy records disagree on the ruling for `term:ai` (a genuine
 * ambiguity); `term:solo` has a single, undisputed ruling. Both source forms are
 * REAL glyphs the fixture units carry, so occurrence counts are byte-derived. */
function policyRecords(): PolicyRecordV02[] {
  const base = {
    policyRecordKind: "romanized_term" as const,
    policyReason: "fixture",
  };
  return [
    {
      ...base,
      policyRecordId: "00000000-0000-7000-8000-000000000001",
      termKey: AI_KEY,
      sourceText: "あ",
      policyAction: "localize",
    },
    {
      ...base,
      policyRecordId: "00000000-0000-7000-8000-000000000002",
      termKey: AI_KEY,
      sourceText: "あ",
      policyAction: "romanize",
    },
    {
      ...base,
      policyRecordId: "00000000-0000-7000-8000-000000000003",
      termKey: SOLO_KEY,
      sourceText: "い",
      policyAction: "localize",
    },
  ] as PolicyRecordV02[];
}

/** The fact snapshot, read model, and candidate index are built over the same
 * real fixture bytes plus deterministic policy records. */
function fixture() {
  return buildClaimFixture({
    snapshotBundle: (bundle) => ({ ...bundle, policyRecords: policyRecords() }),
  });
}

function termIndex(model: ReturnType<typeof fixture>["model"]) {
  return model.factSnapshot;
}

/** A schema-valid term-ruling WikiObject. Enumeration (sourceForm/aliases) and
 * citations are supplied so each proof can inject a specific model behavior. */
function termRuling(opts: {
  objectId: string;
  snapshotId: `sha256:${string}`;
  lang?: string;
  termId?: string;
  sourceForm?: string;
  aliases?: string[];
  citations: Citation[];
}): WikiObject {
  return {
    schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
    objectId: opts.objectId,
    version: 1,
    lang: opts.lang ?? "ja-JP",
    subject: { kind: "glossary-term", id: opts.termId ?? AI_KEY },
    scope: { kind: "global" },
    kind: "term-ruling",
    body: {
      termId: opts.termId ?? AI_KEY,
      sourceForm: opts.sourceForm ?? "あ",
      meaning: "An informal greeting interjection between peers.",
      register: "Casual; peer-to-peer.",
      confidence: "high",
      sourceScope: { kind: "global" },
      aliases: opts.aliases ?? ["あ"],
    },
    claims: [
      {
        claimId: `${opts.objectId}:term-1`,
        statement: "The term reads as a casual greeting in its occurrences.",
        scope: { kind: "global" },
        kind: "term",
        confidence: "high",
        citations: opts.citations,
      },
    ],
    media: [],
    dependencies: [],
    provisional: false,
    provenance: {
      contextSnapshotId: opts.snapshotId,
      contextScope: "whole-game",
      runMode: "production",
      snapshotKind: "context",
    },
  } as unknown as WikiObject;
}

function recordedSuccess(object: WikiObject, servedModel = deepSeekV4FlashProfile.model) {
  return CallResultSchema.parse({
    schemaVersion: CALL_RESULT_SCHEMA_VERSION,
    status: "success",
    memoKey: HASH("b"),
    requested: { model: deepSeekV4FlashProfile.model },
    memoHit: true,
    value: object,
    responseEventId: HASH("c"),
    served: { status: "confirmed", model: servedModel, provider: "fireworks" },
    generationId: "generation:a2-rec",
    verification: "verified",
    usage: { promptTokens: 900, completionTokens: 300, reasoningTokens: 120, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: "0.0009" },
    events: [],
  });
}

/** A model-authored occurrence-label citation. Its mechanical coordinates are
 * deliberately wrong: A2 overwrites them from the immutable snapshot. */
function citationForOccurrence(label: string): Citation {
  return {
    evidenceId: label,
    evidenceHash: HASH("0"),
    snapshotId: HASH("0"),
    subject: { kind: "unit", id: "model-invented-subject" },
    role: "establishes",
    playOrderIndex: 999,
  };
}

function request(
  snapshotId: `sha256:${string}`,
  candidate: AmbiguousTermCandidate,
  runMode?: RunModeValue,
): TermAnalystRequest {
  return {
    contextSnapshotId: snapshotId,
    sourceLanguage: "ja-JP",
    candidate,
    ...(runMode === undefined ? {} : { runMode }),
    operatorBrief: "House glossary for a peer-to-peer romance VN.",
    parentEventId: HASH("d"),
  };
}

function aiCandidate(model: ReturnType<typeof fixture>["model"]): AmbiguousTermCandidate {
  return ambiguousTermCandidates(termIndex(model)).find((c) => c.termKey === AI_KEY)!;
}

describe("A2 clause 1 — reasons ONLY over the ambiguous candidates the index flags", () => {
  it("PROOF: only the conflicting term is a candidate; the undisputed term is hidden", () => {
    const { model } = fixture();
    const index = termIndex(model);
    const candidates = ambiguousTermCandidates(index);
    expect(candidates.map((c) => c.termKey)).toEqual([AI_KEY]);
    expect(isAmbiguousCandidate(index, AI_KEY)).toBe(true);
    expect(isAmbiguousCandidate(index, SOLO_KEY)).toBe(false);
    // The candidate carries a real reason it was flagged.
    expect(candidates[0]!.conflicts.some((c) => c.kind === "policy_action_conflict")).toBe(true);
  });

  it("PROOF: the analyst cannot rule off its dispatched candidate", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:off",
      snapshotId: model.snapshotId,
      termId: SOLO_KEY, // not the dispatched candidate
      citations: [citationForOccurrence("o1")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermEnumerationError);
  });
});

describe("A2 role configuration — analyst shape and certified route", () => {
  it("PROOF: the RB-040 manifest entry is the immutable A2 analyst and its semantic validator runs", () => {
    const a2 = ROSTER.A2;
    expect(a2).toMatchObject({
      roleId: "A2",
      shape: "analyst",
      version: "itotori.role.A2.v2",
      granularity: "per-term",
      wikiObjectKind: "term-ruling",
      modelProfileKey: deepSeekV4FlashProfile.profileId,
      dagPosition: {
        stage: "pre-production",
        upstream: ["A1"],
        downstream: ["P1", "P2", "P3", "Q3"],
      },
    });
    expect(Object.isFrozen(a2)).toBe(true);
    expect(a2.tools).toEqual([
      "decode_get_units",
      "decode_get_route_graph",
      "decode_get_character_occurrences",
      "outputs_get_accepted",
      "references_search",
    ]);
    expect(specialistFor("A2").validate(undefined)).toHaveLength(1);
  });

  it("PROOF: A2's route guard rejects a forged model even in test-dev", () => {
    const { model } = fixture();
    const prompts = {
      systemRef: {
        storageRef: "s",
        contentHash: HASH("a"),
        encryption: "operator-managed" as const,
      },
      userRef: { storageRef: "u", contentHash: HASH("b"), encryption: "operator-managed" as const },
    };
    const certified = assembleTermAnalystCallSpec(
      request(model.snapshotId, aiCandidate(model), "test-dev"),
      prompts,
    );
    expect(() => assertTermAnalystCertifiedRoute(certified)).not.toThrow();
    const forged: CallSpec = { ...certified, requestedModel: "openai/gpt-forgery" };
    // The shared test-dev check permits the forged route; A2's own dispatch
    // envelope does not, and it rejects before an injected port can run.
    expect(() => assertCallUsesCertifiedRoleModelProfile(forged)).not.toThrow();
    expect(() => assertTermAnalystCertifiedRoute(forged)).toThrow(TermAnalystRouteError);
  });

  it("PROOF: a forged test-dev route is refused before the model port is reached", async () => {
    const { model } = fixture();
    const prompts = {
      systemRef: {
        storageRef: "s",
        contentHash: HASH("a"),
        encryption: "operator-managed" as const,
      },
      userRef: { storageRef: "u", contentHash: HASH("b"), encryption: "operator-managed" as const },
    };
    const certified = assembleTermAnalystCallSpec(
      request(model.snapshotId, aiCandidate(model), "test-dev"),
      prompts,
    );
    const forged: CallSpec = { ...certified, requestedModel: "openai/gpt-forgery" };
    let reached = false;
    await expect(
      dispatchTermAnalyst(forged, async () => {
        reached = true;
        return recordedSuccess(
          termRuling({ objectId: "term:unreachable", snapshotId: model.snapshotId, citations: [] }),
        );
      }),
    ).rejects.toBeInstanceOf(TermAnalystRouteError);
    expect(reached).toBe(false);
  });

  it("PROOF: A2 reads exactly the pre-pass occurrence keys through RB-025", () => {
    const { model } = fixture();
    const candidate = aiCandidate(model);
    const evidence = readTermOccurrenceEvidence(model, candidate);
    expect(evidence.occurrences.map((occurrence) => occurrence.sourceUnitKey)).toEqual(
      candidate.occurrenceUnitKeys,
    );
    expect(evidence.occurrences.map((occurrence) => occurrence.label)).toEqual([
      "o1",
      "o2",
      "o3",
      "o4",
    ]);
    expect(evidence.occurrencePages.every((page) => page.tool === "decode_get_units")).toBe(true);
  });
});

describe("A2 clause 2 — a cited source-language ruling, claim-validated, no target form", () => {
  it("PROOF: runTermAnalyst emits a term-ruling whose claims re-prove against the snapshot", async () => {
    const { model } = fixture();
    const candidate = aiCandidate(model);
    const ruling = termRuling({
      objectId: "term:ai-ruling",
      snapshotId: model.snapshotId,
      citations: [citationForOccurrence("o2")],
    });

    const result = await runTermAnalyst(request(model.snapshotId, candidate), {
      model: recordedTermAnalystModel(recordedSuccess(ruling)),
      storePrompt: inlineTermPromptStore(),
      validationModel: model,
    });

    expect(result.termRuling.kind).toBe("term-ruling");
    expect(result.termRuling.lang).toBe("ja-JP");
    expect(result.termRuling.body.meaning.length).toBeGreaterThan(0);
    expect(result.termRuling.body.register.length).toBeGreaterThan(0);
    expect(result.termRuling.body.sourceScope).toEqual({ kind: "global" });
    expect(result.termRuling.body.confidence).toBe("high");
    expect(result.termRuling.provisional).toBe(true);
    // The served MODEL is certified; the served PROVIDER is recorded telemetry.
    expect(result.served.model).toBe(deepSeekV4FlashProfile.model);
    expect(result.served.provider).toBe("fireworks");
    const evidence = readTermOccurrenceEvidence(model, candidate);
    const expected = buildEvidenceIndex(model).get(evidence.occurrences[1]!.factId)!;
    expect(result.termRuling.claims[0]!.citations[0]).toMatchObject({
      evidenceId: expected.factId,
      evidenceHash: expected.hash,
      snapshotId: expected.snapshotId,
      subject: expected.subject,
      role: "establishes",
      playOrderIndex: expected.fromPlayOrder,
    });
    // NO ad hoc target form: the source ruling body has no target-language field.
    expect(Object.keys(result.termRuling.body).sort()).toEqual(
      [
        "aliases",
        "confidence",
        "meaning",
        "register",
        "sourceForm",
        "sourceScope",
        "termId",
      ].sort(),
    );
    expect(JSON.stringify(result.termRuling.body)).not.toMatch(/target|en-US/i);
  });

  it("PROOF: a citation label for a non-existent occurrence fails same-snapshot resolution", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:forged",
      snapshotId: model.snapshotId,
      citations: [citationForOccurrence("o999")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(CitationResolutionError);
  });

  it("PROOF: a wrong served model is rejected (certified model only)", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:x",
      snapshotId: model.snapshotId,
      citations: [citationForOccurrence("o1")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
        model: recordedTermAnalystModel(recordedSuccess(ruling, "openai/gpt-x")),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermAnalystError);
  });

  it("PROOF: a target-language object is rejected — the analyst authors SOURCE language", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:en",
      snapshotId: model.snapshotId,
      lang: "en-US",
      citations: [citationForOccurrence("o1")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermAnalystError);
  });

  it("PROOF: the assembled CallSpec routes deepseek-v4-flash, ZDR, no provider, via A2/analysis/wiki-object", () => {
    const { model } = fixture();
    const prompts = {
      systemRef: {
        storageRef: "s",
        contentHash: HASH("a"),
        encryption: "operator-managed" as const,
      },
      userRef: { storageRef: "u", contentHash: HASH("b"), encryption: "operator-managed" as const },
    };
    const spec = assembleTermAnalystCallSpec(request(HASH("e"), aiCandidate(model)), prompts);
    expect(spec.roleId).toBe("A2");
    expect(spec.purpose).toBe("analysis");
    expect(spec.requestedModel).toBe(deepSeekV4FlashProfile.model);
    expect(spec.output.name).toBe("wiki-object");
    expect(spec.providerPolicy).toMatchObject({ allowFallbacks: true, zdr: true });
    // No provider is named or pinned anywhere in the route.
    expect(JSON.stringify(spec.providerPolicy)).not.toMatch(/only|order/);
    const prompt = composeTermAnalystPrompt(
      request(HASH("e"), aiCandidate(model)),
      readTermOccurrenceEvidence(model, aiCandidate(model)),
    );
    expect(prompt.system.length).toBeGreaterThan(0);
    // The prompt hands the model the byte-derived enumeration and forbids a re-count.
    expect(prompt.user).toContain("do not re-count");
  });
});

describe("A2 clause 3 — enumeration byte-derived; a model lie is ignored/rejected", () => {
  it("PROOF: the candidate's enumeration IS the byte-derived index (real occurrence count)", () => {
    const { model } = fixture();
    const candidate = aiCandidate(model);
    // `あ` occurs in four fixture units across the two scenes — a mechanical
    // substring count, not a model assertion.
    expect(candidate.aliases).toEqual(["あ"]);
    expect(candidate.occurrenceCount).toBe(4);
    expect(candidate.occurrenceUnitKeys).toEqual([
      "reallive:scene-0001#0000",
      "reallive:scene-0001#0001",
      "reallive:scene-0002#0000",
      "reallive:scene-0002#0001",
    ]);
  });

  it("PROOF: the result's authoritative enumeration is the index's, not the model's body", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:ai-ok",
      snapshotId: model.snapshotId,
      citations: [citationForOccurrence("o2")],
    });
    const result = await runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
      model: recordedTermAnalystModel(recordedSuccess(ruling)),
      storePrompt: inlineTermPromptStore(),
      validationModel: model,
    });
    expect(result.enumeration.occurrenceCount).toBe(4);
    expect(result.enumeration.aliases).toEqual(["あ"]);
    expect(result.enumeration.occurrenceUnitKeys).toEqual(aiCandidate(model).occurrenceUnitKeys);
  });

  it("PROOF: a model that re-enumerates the aliases is rejected", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:ai-drift",
      snapshotId: model.snapshotId,
      aliases: ["あ", "ゐ"], // a ghost alias the bytes never carried
      citations: [citationForOccurrence("o1")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermEnumerationError);
  });

  it("PROOF: a non-existent occurrence label is rejected before it can become evidence", async () => {
    const { model } = fixture();
    const ruling = termRuling({
      objectId: "term:ai-ghost",
      snapshotId: model.snapshotId,
      citations: [citationForOccurrence("o999")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate(model)), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(CitationResolutionError);
  });
});
