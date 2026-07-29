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

import {
  HASH,
  AI_KEY,
  SOLO_KEY,
  policyRecords,
  fixture,
  termIndex,
  termRuling,
  recordedSuccess,
  citationForOccurrence,
  request,
  aiCandidate,
} from "./roles-a2-terminology-analyst.support.js";

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
  it("PROOF: the policy manifest entry is the immutable A2 analyst and its semantic validator runs", () => {
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

  it("PROOF: A2 reads exactly the pre-pass occurrence keys through policy", () => {
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
