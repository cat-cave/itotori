// A7 Character Biographer — mutation-falsifiable proofs over REAL decoded bytes.
//
// Every clause of the role fails if its guarantee is removed:
//   Clause 1 — ONE cited, portrait-bearing source-language bio for EVERY
//              character in the deterministic index; none skipped.
//   Clause 2 — LOCAL-ONLY (web disabled — the default) still produces qualifying
//              bios from same-game evidence, performing ZERO egress.
//   Clause 3 — with web egress operator-enabled, web claims are confidence
//              medium-or-lower, DISTINCT from the grounded bio, can never override
//              a same-game fact, and every same-game citation resolves.
//
// The model boundary is a RECORDED responder (no network, no DB): the assembly is
// deterministic and the guarantees are the module's, not the model's.

import { describe, expect, it } from "vitest";

import { ClaimValidationError, validateWikiObjectClaims } from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import {
  EgressDeniedError,
  type EgressPolicy,
  type WebSearchProvider,
} from "../src/egress/index.js";
import type { MediaArtifactFacts } from "../src/wiki/media-index.js";
import {
  A7RoleError,
  A7_LOCAL_ONLY,
  a7WebEnabled,
  assembleCharacterBio,
  biographRoster,
  buildA7WebSearchTool,
  buildCharacterPortrait,
  characterIndex,
  citeableCharacterUnits,
  readCharacterEvidence,
  type A7BioDraft,
  type A7Context,
  type A7ModelCaller,
  type A7PortraitProvider,
  type A7WebContext,
} from "../src/roles/a7/index.js";
import { buildClaimFixture, type FixtureCharacterSpec } from "./support/claim-fixture.js";

const CONTEXT: A7Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

/** Two canonical characters seeded into the deterministic index, each bound to a
 * real scene-1 ordered unit as its whole-game evidence. */
const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

function fixture() {
  return buildClaimFixture({ characters: CHARACTERS });
}

function portraitFacts(seed: string): MediaArtifactFacts {
  return {
    artifactUri: `artifacts/utsushi/runtime/test-run/screenshots/portrait-${seed}.png`,
    contentHash: `sha256:${seed.repeat(64).slice(0, 64)}`,
    mediaType: "image/png",
    dimensions: { width: 256, height: 256 },
    access: { redaction: "default-redacted", permission: "project-member" },
  };
}

/** A portrait provider that serves an available portrait for every character. */
const portraits: A7PortraitProvider = (characterId) => ({
  status: "available",
  facts: portraitFacts(characterId === "nam-11" ? "a" : "b"),
});

/** A recorded responder that authors a bio citing the character's own first
 * whole-game unit by its short label (u1) and LIES with a fabricated trait id
 * the module must ignore. */
function recordedCaller(seen?: string[]): A7ModelCaller {
  return async (request) => {
    seen?.push(request.character.characterId);
    const anchor = citeableCharacterUnits(request.character)[0]!.label;
    const draft: A7BioDraft = {
      storyRole: `${request.character.decodedLabel} は物語を動かす。`,
      definingTraits: ["まっすぐ", "芯が強い"],
      notableMomentEvidenceIds: [anchor],
      claims: [{ statement: "この人物は決断を促す。", confidence: "high", evidenceIds: [anchor] }],
    };
    return draft;
  };
}

const ENABLED_POLICY: EgressPolicy = { operatorEnabled: true, qualifyingRun: false };

/** A web provider that returns one hit corroborating the same-game label and one
 * hit contradicting it, so reconciliation must corroborate (medium) the first and
 * SUPPRESS the second. */
const webProvider: WebSearchProvider = {
  async search(query) {
    return [
      { url: "https://ref.example/a", title: "t", excerpt: query, retrievedContent: `ok:${query}` },
      {
        url: "https://ref.example/b",
        title: "t",
        excerpt: `${query} は宇宙人である`,
        retrievedContent: `no:${query}`,
      },
    ];
  },
};

function webContext(policy: EgressPolicy, spy?: WebSearchProvider): A7WebContext {
  return {
    policy,
    provider: spy ?? webProvider,
    now: () => new Date("2026-07-16T00:00:00Z"),
  };
}

describe("clause 1 — one cited, portrait-bearing bio for EVERY indexed character", () => {
  it("PROOF: coverage equals the deterministic index exactly; none skipped", async () => {
    const { model } = fixture();
    const index = characterIndex(model).map((character) => character.characterId);
    const result = await biographRoster(model, CONTEXT, recordedCaller(), portraits);

    // The character set is the index's exactly.
    expect(result.coveredCharacterIds).toEqual(index);
    expect(result.bios.map((bio) => bio.characterId)).toEqual(index);
    expect(result.bios.length).toBe(index.length);
  });

  it("PROOF: every bio is a source-language character-bio with a portrait + cited whole-game evidence", async () => {
    const { model } = fixture();
    const result = await biographRoster(model, CONTEXT, recordedCaller(), portraits);
    for (const { characterId, bio } of result.bios) {
      expect(bio.kind).toBe("character-bio");
      expect(bio.lang).toBe(model.sourceLanguage);
      expect(bio.subject).toEqual({ kind: "character", id: characterId });
      // A7 is an analyst: a cited interpretation remains revisable until the
      // Wiki acceptance workflow promotes it.
      expect(bio.provisional).toBe(true);
      // A portrait media reference is always present, bound to this character.
      const portrait = bio.media.find((ref) => ref.kind === "portrait");
      expect(portrait?.kind === "portrait" ? portrait.characterId : null).toBe(characterId);
      // Cited whole-game evidence: the presence claim resolves against the index.
      expect(bio.claims.length).toBeGreaterThan(0);
      expect(() => validateWikiObjectClaims(bio, model)).not.toThrow();
      const body = bio.kind === "character-bio" ? bio.body : null;
      expect(body?.notableMomentEvidenceIds.length).toBeGreaterThan(0);
      expect(body?.definingTraits.length).toBeGreaterThan(0);
    }
  });

  it("PROOF: an empty character index fails loud (never a silent zero-bio pass)", async () => {
    const { model } = buildClaimFixture();
    await expect(
      biographRoster(model, CONTEXT, recordedCaller(), portraits),
    ).rejects.toBeInstanceOf(A7RoleError);
    await expect(biographRoster(model, CONTEXT, recordedCaller(), portraits)).rejects.toThrow(
      /empty-character-index/u,
    );
  });

  it("PROOF: A7 labels each unit u1,u2,… and a copied [uN] label resolves to its fact id", () => {
    const { model } = fixture();
    const evidence = readCharacterEvidence(model, CONTEXT, characterIndex(model)[0]!);
    const citeable = citeableCharacterUnits(evidence);
    // Small labels the flash model can copy — NOT the uuid-based fact ids.
    expect(citeable.map((entry) => entry.label)).toEqual(
      evidence.notableUnitIds.map((_, index) => `u${index + 1}`),
    );
    // A model that copies u1 resolves to the real first whole-game unit fact id
    // with NO drop needed.
    const bio = assembleCharacterBio(
      model,
      CONTEXT,
      evidence,
      {
        storyRole: "x",
        definingTraits: ["y"],
        notableMomentEvidenceIds: ["u1"],
        claims: [{ statement: "決断を促す。", confidence: "high", evidenceIds: ["u1"] }],
      },
      buildCharacterPortrait(evidence.characterId, portraits(evidence.characterId)),
    );
    const modelClaim = bio.claims.find((claim) => claim.claimId.includes(":claim:"))!;
    expect(modelClaim.citations).toHaveLength(1);
    expect(modelClaim.citations[0]!.evidenceId).toBe(evidence.notableUnitIds[0]!);
  });

  it("PROOF: a MODEL claim citing ONLY an out-of-range label is DROPPED, not crashed over", () => {
    const { model } = fixture();
    const evidence = readCharacterEvidence(model, CONTEXT, characterIndex(model)[0]!);
    // A label past the character's unit count (the flash model mis-copied it) —
    // the recoverable slip the repair path absorbs instead of crashing.
    const bio = assembleCharacterBio(
      model,
      CONTEXT,
      evidence,
      {
        storyRole: "x",
        definingTraits: ["y"],
        notableMomentEvidenceIds: ["u1"],
        claims: [
          { statement: "存在しない証拠を引く。", confidence: "high", evidenceIds: ["u999"] },
        ],
      },
      buildCharacterPortrait(evidence.characterId, portraits(evidence.characterId)),
    );
    // Assembling did NOT throw; the unprovable model claim was repaired away.
    // The bio still carries its cited whole-game presence claim.
    expect(() => validateWikiObjectClaims(bio, model)).not.toThrow();
    const modelClaims = bio.claims.filter((claim) => claim.claimId.includes(":claim:"));
    expect(modelClaims).toHaveLength(0);
    expect(bio.claims.length).toBeGreaterThan(0);
  });

  it("PROOF: a MIX of a real and a mis-cited label keeps ONLY the resolvable citation", () => {
    const { model } = fixture();
    const evidence = readCharacterEvidence(model, CONTEXT, characterIndex(model)[0]!);
    const goodFactId = evidence.notableUnitIds[0]!;
    const bio = assembleCharacterBio(
      model,
      CONTEXT,
      evidence,
      {
        storyRole: "x",
        definingTraits: ["y"],
        notableMomentEvidenceIds: ["u1"],
        claims: [{ statement: "決断を促す。", confidence: "high", evidenceIds: ["u1", "u999"] }],
      },
      buildCharacterPortrait(evidence.characterId, portraits(evidence.characterId)),
    );
    const index = buildEvidenceIndex(model);
    const modelClaim = bio.claims.find((claim) => claim.claimId.includes(":claim:"))!;
    // The claim survives with its real support; the mis-cited label is gone.
    expect(modelClaim.citations).toHaveLength(1);
    expect(modelClaim.citations[0]!.evidenceId).toBe(goodFactId);
    // Gate NOT weakened: every surviving citation resolves against the snapshot.
    for (const claim of bio.claims) {
      for (const citation of claim.citations) {
        expect(index.get(citation.evidenceId)).toBeDefined();
      }
    }
  });

  it("PROOF: the gate the repair feeds still REJECTS a fabricated citation", () => {
    const { model } = fixture();
    const evidence = readCharacterEvidence(model, CONTEXT, characterIndex(model)[0]!);
    const bio = assembleCharacterBio(
      model,
      CONTEXT,
      evidence,
      {
        storyRole: "x",
        definingTraits: ["y"],
        notableMomentEvidenceIds: ["u1"],
        claims: [],
      },
      buildCharacterPortrait(evidence.characterId, portraits(evidence.characterId)),
    );
    // The repair does not soften the citation gate: hand a claim a fabricated
    // evidence id straight to the gate and it still fails loud (the repair
    // only prevents a fabricated citation from ever reaching the object, it
    // never admits one).
    const tampered = {
      ...bio,
      claims: [
        {
          ...bio.claims[0]!,
          citations: [{ ...bio.claims[0]!.citations[0]!, evidenceId: "unit:fabricated" }],
        },
      ],
    };
    try {
      validateWikiObjectClaims(tampered, model);
      throw new Error("expected the citation gate to reject the fabricated citation");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimValidationError);
      expect((error as ClaimValidationError).code).toBe("evidence-unresolvable");
    }
  });
});

describe("clause 2 — LOCAL-ONLY produces qualifying bios with zero egress", () => {
  it("PROOF: the default (no web context) produces bios and performs no web reconciliation", async () => {
    const { model } = fixture();
    const result = await biographRoster(model, CONTEXT, recordedCaller(), portraits);
    // Bios are produced from same-game evidence alone.
    expect(result.bios.length).toBe(characterIndex(model).length);
    for (const { bio, web } of result.bios) {
      expect(web).toBeNull();
      expect(() => validateWikiObjectClaims(bio, model)).not.toThrow();
    }
  });

  it("PROOF: a disabled egress policy performs ZERO egress even with a provider present", async () => {
    const { model } = fixture();
    let searches = 0;
    const spy: WebSearchProvider = {
      async search() {
        searches += 1;
        return [];
      },
    };
    // A7_LOCAL_ONLY is the default posture: the boundary is closed.
    expect(a7WebEnabled(A7_LOCAL_ONLY)).toBe(false);
    const result = await biographRoster(model, CONTEXT, recordedCaller(), portraits, {
      web: webContext(A7_LOCAL_ONLY, spy),
    });
    // The provider was never called: no query, no byte left.
    expect(searches).toBe(0);
    for (const { web } of result.bios) expect(web).toBeNull();
  });

  it("PROOF: A7's web tool fails closed under a disabled policy (no provider call)", async () => {
    const { model } = fixture();
    let searches = 0;
    const spy: WebSearchProvider = {
      async search() {
        searches += 1;
        return [];
      },
    };
    const tool = buildA7WebSearchTool(webContext(A7_LOCAL_ONLY, spy), model.snapshotId);
    await expect(
      tool.execute({ query: "アイ", maxRows: 10, maxBytes: 1_000 }, undefined),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(searches).toBe(0);
  });
});

describe("clause 3 — web-enabled: capped, distinct, dominated, and citations resolve", () => {
  it("PROOF: web egress is A7-only + operator-gated", () => {
    expect(a7WebEnabled(A7_LOCAL_ONLY)).toBe(false);
    expect(a7WebEnabled(ENABLED_POLICY)).toBe(true);
  });

  it("PROOF: web claims are medium-or-lower, distinct from the grounded bio, and never override a same-game fact", async () => {
    const { model } = fixture();
    const result = await biographRoster(model, CONTEXT, recordedCaller(), portraits, {
      web: webContext(ENABLED_POLICY),
    });
    for (const { bio, web } of result.bios) {
      expect(web).not.toBeNull();
      const reconciliation = web!;
      // Capped at medium: no usable web claim is ever high.
      for (const claim of reconciliation.usable) {
        expect(["low", "medium"]).toContain(claim.confidence);
      }
      // The corroborated claim reaches exactly medium; the contradicting claim is
      // SUPPRESSED — a same-game fact dominates, never overridden.
      expect(reconciliation.usable.some((claim) => claim.confidence === "medium")).toBe(true);
      expect(reconciliation.suppressed.length).toBeGreaterThan(0);
      // DISTINCT: no web-provenance evidence id appears in the grounded bio claims.
      const groundedEvidenceIds = bio.claims.flatMap((claim) =>
        claim.citations.map((citation) => citation.evidenceId),
      );
      expect(groundedEvidenceIds.some((id) => id.startsWith("web:"))).toBe(false);
      const webIds = reconciliation.usable.map((claim) => claim.evidenceId);
      expect(webIds.every((id) => id.startsWith("web:"))).toBe(true);
      expect(webIds.some((id) => groundedEvidenceIds.includes(id))).toBe(false);
      // Every same-game citation on the grounded bio resolves.
      expect(() => validateWikiObjectClaims(bio, model)).not.toThrow();
    }
  });
});
