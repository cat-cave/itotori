// A1 Style Lead — mutation-falsifiable proofs. Each clause below fails if its
// guarantee is removed.
//
// Clause 1 (cited source-language style-contract, claim-validated): runStyleLead
//   dispatches through the sole ZDR dispatch boundary, returns a style-contract WikiObject,
//   and re-proves every claim against the real snapshot; a fabricated citation, a
//   wrong terminal kind, a wrong served model, or a target-language object all
//   throw loudly.
// Clause 2 (reusable, org/user/genre-keyed abstraction): a second game's contract
//   FOLDS INTO the same artifact; a field observed in both games carries both
//   snapshots' provenance (REUSE), the artifact is keyed by org/genre not game,
//   and it is source-language, never target-bound.
// Clause 3 (versioning, operator constraints, field-scoped invalidation): a
//   value change mints a new version; an operator-locked field is held; and only
//   consumers that cited a CHANGED policy field are invalidated.

import { describe, expect, it } from "vitest";

import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  WIKI_OBJECT_SCHEMA_VERSION,
  type Citation,
  type DependencyRef,
  type WikiObject,
} from "../src/contracts/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import { ClaimValidationError } from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import {
  abstractStyleFromContract,
  appliesToSnapshot,
  assembleStyleLeadCallSpec,
  composeStyleLeadPrompt,
  foldStyleContract,
  inlineStylePromptStore,
  invalidatedStyleConsumers,
  recordedStyleLeadModel,
  runStyleLead,
  snapshotsForField,
  StyleLeadError,
  type AbstractStyleArtifact,
  type StyleLeadRequest,
} from "../src/roles/a1/index.js";
import { buildClaimFixture, unitFactIdAt } from "./support/claim-fixture.js";

const HASH = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as `sha256:${string}`;

type StyleBody = {
  registerPolicy: string;
  honorificPolicy: string;
  nameOrder: "source-order" | "given-first" | "contextual";
  profanityCeiling: "none" | "mild" | "moderate" | "unrestricted";
  punctuationRules: string[];
  audienceNote: string;
};

const BODY_A: StyleBody = {
  registerPolicy: "Polite-neutral narration; casual dialogue between peers.",
  honorificPolicy: "Retain honorifics for named characters.",
  nameOrder: "source-order",
  profanityCeiling: "mild",
  punctuationRules: ["ellipsis as three dots"],
  audienceNote: "Adult VN readers familiar with the genre.",
};

/** A schema-valid style-contract WikiObject. `citations` default to one shaped
 * (non-resolving) citation — fine for the pure abstraction proofs; the claim-validation
 * proofs pass RESOLVING citations built from the fixture. */
function styleContract(opts: {
  objectId: string;
  version?: number;
  snapshotId: `sha256:${string}`;
  lang?: string;
  body?: Partial<StyleBody>;
  gameId?: string;
  citations?: Citation[];
}): WikiObject {
  const body = { ...BODY_A, ...opts.body };
  const citations: Citation[] = opts.citations ?? [
    {
      evidenceId: "unit:sample",
      evidenceHash: HASH("a"),
      snapshotId: opts.snapshotId,
      subject: { kind: "unit", id: "sample" },
      role: "establishes",
      playOrderIndex: 0,
    },
  ];
  const object = {
    schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
    objectId: opts.objectId,
    version: opts.version ?? 1,
    lang: opts.lang ?? "ja-JP",
    subject: { kind: "game", id: opts.gameId ?? "game-a" },
    scope: { kind: "global" },
    kind: "style-contract",
    body,
    claims: [
      {
        claimId: `${opts.objectId}:style-1`,
        statement: "The source narration keeps a polite-neutral register.",
        scope: { kind: "global" },
        kind: "style",
        confidence: "high",
        citations,
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
  return object;
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
    generationId: "generation:a1-rec",
    verification: "verified",
    usage: { promptTokens: 900, completionTokens: 300, reasoningTokens: 120, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: "0.0009" },
    events: [],
  });
}

function request(snapshotId: `sha256:${string}`): StyleLeadRequest {
  return {
    contextSnapshotId: snapshotId,
    sourceLanguage: "ja-JP",
    operatorBrief: "House style for a peer-to-peer romance VN; keep honorifics.",
    slice: [{ sceneId: "scene-0001", excerpt: "…" }],
    parentEventId: HASH("d"),
  };
}

const ORG_KEY = { orgId: "org:sweetie-house", userId: null, genre: "genre:romance-vn" };

describe("A1 clause 1 — a cited source-language style-contract, claim-validated", () => {
  it("PROOF: runStyleLead emits a style-contract whose claims re-prove against the snapshot", async () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 0);
    const record = index.get(factId)!;
    const resolving: Citation = {
      evidenceId: record.factId,
      evidenceHash: record.hash,
      snapshotId: record.snapshotId as `sha256:${string}`,
      subject: record.subject,
      role: "establishes",
      playOrderIndex: record.fromPlayOrder,
    };
    const contract = styleContract({
      objectId: "style:game-a",
      snapshotId: model.snapshotId,
      citations: [resolving],
    });

    const result = await runStyleLead(request(model.snapshotId), {
      model: recordedStyleLeadModel(recordedSuccess(contract)),
      storePrompt: inlineStylePromptStore(),
      validationModel: model,
    });

    expect(result.styleContract.kind).toBe("style-contract");
    expect(result.styleContract.lang).toBe("ja-JP");
    expect(result.served.model).toBe(deepSeekV4FlashProfile.model);
    // The served PROVIDER is recorded telemetry, not a pinned input (no provider pin).
    expect(result.served.provider).toBe("fireworks");
  });

  it("PROOF: a fabricated citation (hash-mismatch) is rejected by claim validation", async () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const record = index.get(unitFactIdAt(snapshot, 0))!;
    const forged: Citation = {
      evidenceId: record.factId,
      evidenceHash: HASH("f"), // wrong hash → cannot resolve
      snapshotId: record.snapshotId as `sha256:${string}`,
      subject: record.subject,
      role: "establishes",
      playOrderIndex: record.fromPlayOrder,
    };
    const contract = styleContract({
      objectId: "style:forged",
      snapshotId: model.snapshotId,
      citations: [forged],
    });
    await expect(
      runStyleLead(request(model.snapshotId), {
        model: recordedStyleLeadModel(recordedSuccess(contract)),
        storePrompt: inlineStylePromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it("PROOF: a wrong served model is rejected (certified model)", async () => {
    const { model } = buildClaimFixture();
    const contract = styleContract({ objectId: "style:x", snapshotId: model.snapshotId });
    await expect(
      runStyleLead(request(model.snapshotId), {
        model: recordedStyleLeadModel(recordedSuccess(contract, "openai/gpt-x")),
        storePrompt: inlineStylePromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(StyleLeadError);
  });

  it("PROOF: a target-language object is rejected — A1 authors SOURCE language", async () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const record = index.get(unitFactIdAt(snapshot, 0))!;
    const resolving: Citation = {
      evidenceId: record.factId,
      evidenceHash: record.hash,
      snapshotId: record.snapshotId as `sha256:${string}`,
      subject: record.subject,
      role: "establishes",
      playOrderIndex: record.fromPlayOrder,
    };
    const contract = styleContract({
      objectId: "style:en",
      snapshotId: model.snapshotId,
      lang: "en-US",
      citations: [resolving],
    });
    await expect(
      runStyleLead(request(model.snapshotId), {
        model: recordedStyleLeadModel(recordedSuccess(contract)),
        storePrompt: inlineStylePromptStore(),
        validationModel: model,
      }),
    ).rejects.toBeInstanceOf(StyleLeadError);
  });

  it("PROOF: the assembled CallSpec routes deepseek-v4-flash, ZDR, no provider, via A1/analysis/wiki-object", () => {
    const prompts = {
      systemRef: {
        storageRef: "s",
        contentHash: HASH("a"),
        encryption: "operator-managed" as const,
      },
      userRef: { storageRef: "u", contentHash: HASH("b"), encryption: "operator-managed" as const },
    };
    const spec = assembleStyleLeadCallSpec(request(HASH("e")), prompts);
    expect(spec.roleId).toBe("A1");
    expect(spec.purpose).toBe("analysis");
    expect(spec.requestedModel).toBe(deepSeekV4FlashProfile.model);
    expect(spec.output.name).toBe("wiki-object");
    expect(spec.providerPolicy).toMatchObject({ allowFallbacks: true, zdr: true });
    // No provider is named or pinned anywhere in the route.
    expect(JSON.stringify(spec.providerPolicy)).not.toMatch(/only|order/);
    const prompt = composeStyleLeadPrompt(request(HASH("e")));
    expect(prompt.system.length).toBeGreaterThan(0);
  });
});

describe("A1 clause 2 — a reusable, org/genre-keyed abstraction across TWO games", () => {
  const SNAP_A = HASH("1");
  const SNAP_B = HASH("2");

  it("PROOF: a field observed in two games carries BOTH snapshots' provenance (reuse), one artifact", () => {
    const gameA = styleContract({ objectId: "style:a", snapshotId: SNAP_A, gameId: "game-a" });
    // Game B shares the register policy but raises the profanity ceiling.
    const gameB = styleContract({
      objectId: "style:b",
      snapshotId: SNAP_B,
      gameId: "game-b",
      body: { profanityCeiling: "moderate" },
    });

    const v1 = abstractStyleFromContract(ORG_KEY, gameA);
    const { artifact, changedFields, addedFields } = foldStyleContract(v1, gameB);

    // ONE artifact — identity is org/genre, not the game or snapshot.
    expect(artifact.artifactId).toBe(v1.artifactId);
    expect(artifact.artifactId).not.toContain("game");
    expect(artifact.artifactId).not.toContain(SNAP_A);

    // registerPolicy was IDENTICAL in both games → reused, both snapshots cited.
    expect(snapshotsForField(artifact, "registerPolicy")).toEqual([SNAP_A, SNAP_B].sort());
    // The artifact APPLIES to both games.
    expect(appliesToSnapshot(artifact, SNAP_A)).toBe(true);
    expect(appliesToSnapshot(artifact, SNAP_B)).toBe(true);

    // It is a SOURCE-language policy, never a target-language guide.
    expect(artifact.sourceLanguage).toBe("ja-JP");
    expect(JSON.stringify(artifact)).not.toMatch(/targetLanguage|en-US/);

    // Only the profanity ceiling changed.
    expect(changedFields).toEqual(["profanityCeiling"]);
    expect(addedFields).toEqual([]);
  });
});

describe("A1 clause 3 — versioning, operator constraints, field-scoped invalidation", () => {
  const SNAP_A = HASH("3");
  const SNAP_B = HASH("4");

  it("PROOF: a value change mints a new version; an identical fold does not", () => {
    const gameA = styleContract({ objectId: "style:a", snapshotId: SNAP_A });
    const v1 = abstractStyleFromContract(ORG_KEY, gameA);
    expect(v1.version).toBe(1);
    expect(v1.supersedesVersion).toBeUndefined();

    const changed = foldStyleContract(
      v1,
      styleContract({
        objectId: "style:b",
        snapshotId: SNAP_B,
        body: { profanityCeiling: "moderate" },
      }),
    );
    expect(changed.versionBumped).toBe(true);
    expect(changed.artifact.version).toBe(2);
    expect(changed.artifact.supersedesVersion).toBe(1);

    const idempotent = foldStyleContract(
      v1,
      styleContract({ objectId: "style:c", snapshotId: SNAP_B }),
    );
    expect(idempotent.versionBumped).toBe(false);
    expect(idempotent.artifact.version).toBe(1);
    expect(idempotent.changedFields).toEqual([]);
  });

  it("PROOF: an operator-LOCKED field holds against a contradicting observation", () => {
    const gameA = styleContract({ objectId: "style:a", snapshotId: SNAP_A });
    const v1 = abstractStyleFromContract(ORG_KEY, gameA, { lockedFields: ["profanityCeiling"] });

    const fold = foldStyleContract(
      v1,
      styleContract({
        objectId: "style:b",
        snapshotId: SNAP_B,
        body: { profanityCeiling: "unrestricted" },
      }),
    );
    // The lock HELD the value; it is not a change, and no version was minted.
    expect(fold.heldFields).toEqual(["profanityCeiling"]);
    expect(fold.changedFields).toEqual([]);
    expect(fold.versionBumped).toBe(false);
    const held = fold.artifact.policies.find((p) => p.field === "profanityCeiling")!;
    expect(held.value).toBe("mild"); // game A's value, not "unrestricted"
    expect(held.locked).toBe(true);
  });

  it("PROOF: field-scoped invalidation touches ONLY consumers that cited a changed field", () => {
    const gameA = styleContract({ objectId: "style:a", snapshotId: SNAP_A });
    const v1 = abstractStyleFromContract(ORG_KEY, gameA);
    const fold = foldStyleContract(
      v1,
      styleContract({
        objectId: "style:b",
        snapshotId: SNAP_B,
        body: { profanityCeiling: "moderate" },
      }),
    );
    expect(fold.changedFields).toEqual(["profanityCeiling"]);

    const dep = (fieldPath: string[]): DependencyRef => ({
      upstreamObjectId: v1.artifactId,
      upstreamVersion: 1,
      claimId: null,
      fieldPath,
      renderingId: null,
      scope: { kind: "global" },
      fromPlayOrder: null,
      throughPlayOrder: null,
    });

    const profanityConsumer = { id: "P1-draft", dependencies: [dep(["profanityCeiling"])] };
    const registerConsumer = { id: "P1-other", dependencies: [dep(["registerPolicy"])] };
    const objectWideConsumer = { id: "coarse", dependencies: [dep([])] };
    const foreignConsumer = {
      id: "unrelated",
      dependencies: [
        {
          ...dep(["profanityCeiling"]),
          upstreamObjectId: "abstract-style:org=other:user=any:genre=other",
        },
      ],
    };

    const invalidated = invalidatedStyleConsumers(fold.artifact, fold.changedFields, [
      profanityConsumer,
      registerConsumer,
      objectWideConsumer,
      foreignConsumer,
    ]);
    const ids = invalidated.map((c) => c.id).sort();

    // The profanity consumer (cited a CHANGED field) and the coarse object-wide
    // consumer are invalidated; the register consumer (unchanged field) and the
    // foreign-object consumer are NOT — even though a new version was minted.
    expect(ids).toEqual(["P1-draft", "coarse"]);
    expect(ids).not.toContain("P1-other");
    expect(ids).not.toContain("unrelated");
  });

  it("PROOF: no changed fields ⇒ no invalidation at all", () => {
    const v1 = abstractStyleFromContract(
      ORG_KEY,
      styleContract({ objectId: "s", snapshotId: SNAP_A }),
    );
    const artifact: AbstractStyleArtifact = v1;
    const consumer = {
      id: "c",
      dependencies: [
        {
          upstreamObjectId: artifact.artifactId,
          upstreamVersion: 1,
          claimId: null,
          fieldPath: ["profanityCeiling"],
          renderingId: null,
          scope: { kind: "global" as const },
          fromPlayOrder: null,
          throughPlayOrder: null,
        },
      ],
    };
    expect(invalidatedStyleConsumers(artifact, [], [consumer])).toEqual([]);
  });
});
