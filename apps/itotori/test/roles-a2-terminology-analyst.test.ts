// Terminology Analyst — mutation-falsifiable proofs. Each clause below fails if
// its guarantee is removed.
//
// Clause 1 (reasons ONLY over ambiguous candidates): the deterministic index
//   surfaces exactly the genuinely ambiguous term (conflicting policy) and hides
//   the unambiguous one; the analyst cannot rule off its dispatched candidate.
// Clause 2 (cited source-language ruling, no target form): runTermAnalyst
//   dispatches through the sole ZDR boundary, returns a term-ruling WikiObject
//   with meaning/register/source-scope/confidence, re-proves every claim against
//   the real snapshot, and rejects a wrong terminal, a wrong served model, or a
//   target-language object. The body carries NO target form.
// Clause 3 (enumeration byte-derived; model lie ignored/rejected): the alias set,
//   occurrence count, and occurrence units come from the byte-derived index, not
//   the model — an alias re-count is rejected, a citation to a unit the term
//   never occurs in (a ghost occurrence) is rejected even though it resolves, and
//   the result's authoritative enumeration is the index's, never the model's.

import { describe, expect, it } from "vitest";

import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  WIKI_OBJECT_SCHEMA_VERSION,
  type Citation,
  type WikiObject,
} from "../src/contracts/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import {
  materializeGlossaryConflicts,
  materializeTerminology,
} from "../src/prepass/terminology.js";
import type { PolicyRecordV02 } from "@itotori/localization-bridge-schema";
import { ClaimValidationError } from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import {
  ambiguousTermCandidates,
  assembleTermAnalystCallSpec,
  composeTermAnalystPrompt,
  inlineTermPromptStore,
  isAmbiguousCandidate,
  recordedTermAnalystModel,
  runTermAnalyst,
  TermAnalystError,
  TermEnumerationError,
  type AmbiguousTermCandidate,
  type TermAnalystRequest,
} from "../src/roles/a2/index.js";
import { buildClaimFixture, loadBundle } from "./support/claim-fixture.js";

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

/** The deterministic whole-game term/alias/occurrence/conflict index over the
 * real fixture bundle plus the crafted policy records. */
function termIndex() {
  const bundle = { ...loadBundle(), policyRecords: policyRecords() };
  return {
    terminology: materializeTerminology(bundle),
    glossaryConflicts: materializeGlossaryConflicts(bundle),
  };
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

/** A citation to the fixture unit with the given source key, resolved through
 * the real evidence index so hash/subject/play-order all resolve. */
function citationForUnit(
  fixture: ReturnType<typeof buildClaimFixture>,
  sourceUnitKey: string,
): Citation {
  const unit = fixture.snapshot.orderedUnits.find((u) => u.sourceUnitKey === sourceUnitKey)!;
  const record = buildEvidenceIndex(fixture.model).get(unit.factId)!;
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role: "establishes",
    playOrderIndex: record.fromPlayOrder,
  };
}

function request(
  snapshotId: `sha256:${string}`,
  candidate: AmbiguousTermCandidate,
): TermAnalystRequest {
  return {
    contextSnapshotId: snapshotId,
    sourceLanguage: "ja-JP",
    candidate,
    operatorBrief: "House glossary for a peer-to-peer romance VN.",
    parentEventId: HASH("d"),
  };
}

function aiCandidate(): AmbiguousTermCandidate {
  return ambiguousTermCandidates(termIndex()).find((c) => c.termKey === AI_KEY)!;
}

describe("A2 clause 1 — reasons ONLY over the ambiguous candidates the index flags", () => {
  it("PROOF: only the conflicting term is a candidate; the undisputed term is hidden", () => {
    const index = termIndex();
    const candidates = ambiguousTermCandidates(index);
    expect(candidates.map((c) => c.termKey)).toEqual([AI_KEY]);
    expect(isAmbiguousCandidate(index, AI_KEY)).toBe(true);
    expect(isAmbiguousCandidate(index, SOLO_KEY)).toBe(false);
    // The candidate carries a real reason it was flagged.
    expect(candidates[0]!.conflicts.some((c) => c.kind === "policy_action_conflict")).toBe(true);
  });

  it("PROOF: the analyst cannot rule off its dispatched candidate", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const ruling = termRuling({
      objectId: "term:off",
      snapshotId: model.snapshotId,
      termId: SOLO_KEY, // not the dispatched candidate
      citations: [citationForUnit(fixture, "reallive:scene-0001#0001")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate()), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermEnumerationError);
  });
});

describe("A2 clause 2 — a cited source-language ruling, claim-validated, no target form", () => {
  it("PROOF: runTermAnalyst emits a term-ruling whose claims re-prove against the snapshot", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const ruling = termRuling({
      objectId: "term:ai-ruling",
      snapshotId: model.snapshotId,
      citations: [citationForUnit(fixture, "reallive:scene-0001#0001")],
    });

    const result = await runTermAnalyst(request(model.snapshotId, aiCandidate()), {
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
    // The served MODEL is certified; the served PROVIDER is recorded telemetry.
    expect(result.served.model).toBe(deepSeekV4FlashProfile.model);
    expect(result.served.provider).toBe("fireworks");
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

  it("PROOF: a fabricated citation (hash-mismatch) is rejected by claim validation", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const real = citationForUnit(fixture, "reallive:scene-0001#0001");
    const forged: Citation = { ...real, evidenceHash: HASH("f") };
    const ruling = termRuling({
      objectId: "term:forged",
      snapshotId: model.snapshotId,
      citations: [forged],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate()), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it("PROOF: a wrong served model is rejected (certified model only)", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const ruling = termRuling({
      objectId: "term:x",
      snapshotId: model.snapshotId,
      citations: [citationForUnit(fixture, "reallive:scene-0001#0001")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate()), {
        model: recordedTermAnalystModel(recordedSuccess(ruling, "openai/gpt-x")),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermAnalystError);
  });

  it("PROOF: a target-language object is rejected — the analyst authors SOURCE language", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const ruling = termRuling({
      objectId: "term:en",
      snapshotId: model.snapshotId,
      lang: "en-US",
      citations: [citationForUnit(fixture, "reallive:scene-0001#0001")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate()), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermAnalystError);
  });

  it("PROOF: the assembled CallSpec routes deepseek-v4-flash, ZDR, no provider, via A2/analysis/wiki-object", () => {
    const prompts = {
      systemRef: {
        storageRef: "s",
        contentHash: HASH("a"),
        encryption: "operator-managed" as const,
      },
      userRef: { storageRef: "u", contentHash: HASH("b"), encryption: "operator-managed" as const },
    };
    const spec = assembleTermAnalystCallSpec(request(HASH("e"), aiCandidate()), prompts);
    expect(spec.roleId).toBe("A2");
    expect(spec.purpose).toBe("analysis");
    expect(spec.requestedModel).toBe(deepSeekV4FlashProfile.model);
    expect(spec.output.name).toBe("wiki-object");
    expect(spec.providerPolicy).toMatchObject({ allowFallbacks: true, zdr: true });
    // No provider is named or pinned anywhere in the route.
    expect(JSON.stringify(spec.providerPolicy)).not.toMatch(/only|order/);
    const prompt = composeTermAnalystPrompt(request(HASH("e"), aiCandidate()));
    expect(prompt.system.length).toBeGreaterThan(0);
    // The prompt hands the model the byte-derived enumeration and forbids a re-count.
    expect(prompt.user).toContain("do not re-count");
  });
});

describe("A2 clause 3 — enumeration byte-derived; a model lie is ignored/rejected", () => {
  it("PROOF: the candidate's enumeration IS the byte-derived index (real occurrence count)", () => {
    const candidate = aiCandidate();
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
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const ruling = termRuling({
      objectId: "term:ai-ok",
      snapshotId: model.snapshotId,
      citations: [citationForUnit(fixture, "reallive:scene-0001#0001")],
    });
    const result = await runTermAnalyst(request(model.snapshotId, aiCandidate()), {
      model: recordedTermAnalystModel(recordedSuccess(ruling)),
      storePrompt: inlineTermPromptStore(),
      validationModel: model,
    });
    expect(result.enumeration.occurrenceCount).toBe(4);
    expect(result.enumeration.aliases).toEqual(["あ"]);
    expect(result.enumeration.occurrenceUnitKeys).toEqual(aiCandidate().occurrenceUnitKeys);
  });

  it("PROOF: a model that re-enumerates the aliases is rejected", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    const ruling = termRuling({
      objectId: "term:ai-drift",
      snapshotId: model.snapshotId,
      aliases: ["あ", "ゐ"], // a ghost alias the bytes never carried
      citations: [citationForUnit(fixture, "reallive:scene-0001#0001")],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate()), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermEnumerationError);
  });

  it("PROOF: a ghost-occurrence citation is rejected even though it resolves", async () => {
    const { model, snapshot } = buildClaimFixture();
    const fixture = { model, snapshot };
    // `reallive:scene-0001#0002` carries `い`, NOT `あ` — a real, resolvable unit
    // that is not an occurrence of this term. The citation resolves against the
    // snapshot, yet the byte-derived occurrence guard refuses it.
    const ghost = citationForUnit(fixture, "reallive:scene-0001#0002");
    const ruling = termRuling({
      objectId: "term:ai-ghost",
      snapshotId: model.snapshotId,
      citations: [ghost],
    });
    await expect(
      runTermAnalyst(request(model.snapshotId, aiCandidate()), {
        model: recordedTermAnalystModel(recordedSuccess(ruling)),
        storePrompt: inlineTermPromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(TermEnumerationError);
  });
});
