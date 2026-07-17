// Citation resolution — model-selected evidence ids are bound to snapshot facts,
// while a quoted span is a read-proof that must be verbatim source text.

import { describe, expect, it } from "vitest";

import {
  WIKI_OBJECT_SCHEMA_VERSION,
  WikiObjectSchema,
  type Citation,
  type WikiObject,
} from "../src/contracts/index.js";
import type { ReadModel } from "../src/read-tools/index.js";
import {
  CitationResolutionError,
  resolveObjectCitations,
} from "../src/wiki/citation-resolution.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const ZERO = `sha256:${"0".repeat(64)}` as `sha256:${string}`;

/** A one-unit ReadModel is sufficient to prove citation resolution without
 * depending on unrelated scene, character, or glossary evidence. */
function smallReadModel(): ReadModel {
  const { model, snapshot } = buildClaimFixture();
  const unit = snapshot.orderedUnits[0]!;
  const bundleUnit = model.bundleUnits.get(unit.bridgeUnitId)!;
  return {
    ...model,
    factSnapshot: {
      ...snapshot,
      orderedUnits: [unit],
      scenes: [],
      characters: [],
    },
    bundleUnits: new Map([[unit.bridgeUnitId, bundleUnit]]),
    characterProfiles: new Map(),
    localization: null,
  };
}

function styleContract(citation: Citation): Extract<WikiObject, { kind: "style-contract" }> {
  const parsed = WikiObjectSchema.parse({
    schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
    objectId: "style:resolution-test",
    version: 1,
    lang: "ja-JP",
    subject: { kind: "game", id: "resolution-test" },
    scope: { kind: "global" },
    kind: "style-contract",
    body: {
      registerPolicy: "Neutral narration.",
      honorificPolicy: "Retain honorifics.",
      nameOrder: "source-order",
      profanityCeiling: "mild",
      punctuationRules: ["Preserve ellipses."],
      audienceNote: "Test readers.",
    },
    claims: [
      {
        claimId: "claim:resolution-test:style",
        statement: "The source uses a neutral register.",
        scope: { kind: "global" },
        kind: "style",
        confidence: "high",
        citations: [citation],
      },
    ],
    media: [],
    dependencies: [],
    provisional: false,
    provenance: {
      authorRoleId: "A1",
      contextSnapshotId: ZERO,
      contextScope: "whole-game",
      runMode: "test-dev",
      snapshotKind: "context",
    },
  });
  if (parsed.kind !== "style-contract") throw new Error("expected a style contract");
  return parsed;
}

function modelCitation(evidenceId: string, quotedSpan: string): Citation {
  return {
    evidenceId,
    evidenceHash: ZERO,
    snapshotId: ZERO,
    subject: { kind: "unit", id: "model-invented-subject" },
    role: "establishes",
    quotedSpan,
    playOrderIndex: 999,
  };
}

describe("citation resolution", () => {
  it("maps the model's label to the real fact id and overwrites snapshot-owned coordinates", () => {
    const model = smallReadModel();
    const [unit] = model.factSnapshot.orderedUnits;
    const sourceText = model.bundleUnits.get(unit!.bridgeUnitId)!.sourceText;
    const record = buildEvidenceIndex(model).get(unit!.factId)!;
    const quotedSpan = sourceText.slice(0, 1);
    // The model cites the short LABEL it was shown, never the uuid fact id.
    const labelToFactId = new Map([["u1", record.factId]]);
    const object = styleContract(modelCitation("u1", quotedSpan));

    const resolved = resolveObjectCitations(object, model, labelToFactId);
    const citation = resolved.claims[0]!.citations[0]!;

    expect(resolved).not.toBe(object);
    expect(citation).toMatchObject({
      evidenceId: record.factId, // the label was resolved to the real fact id
      evidenceHash: record.hash,
      snapshotId: record.snapshotId,
      subject: record.subject,
      role: "establishes",
      quotedSpan,
      playOrderIndex: record.fromPlayOrder,
    });
  });

  it("rejects a citation whose label does not name a provided unit", () => {
    const model = smallReadModel();
    const [unit] = model.factSnapshot.orderedUnits;
    const labelToFactId = new Map([["u1", unit!.factId]]);
    const object = styleContract(modelCitation("u9", "source text"));

    expect(() => resolveObjectCitations(object, model, labelToFactId)).toThrow(
      CitationResolutionError,
    );
    try {
      resolveObjectCitations(object, model, labelToFactId);
    } catch (error) {
      expect((error as CitationResolutionError).code).toBe("evidence-unresolvable");
    }
  });

  it("rejects a quoted span that is not verbatim source text for the cited unit", () => {
    const model = smallReadModel();
    const [unit] = model.factSnapshot.orderedUnits;
    const labelToFactId = new Map([["u1", unit!.factId]]);
    const object = styleContract(modelCitation("u1", "fabricated quotation"));

    expect(() => resolveObjectCitations(object, model, labelToFactId)).toThrow(
      CitationResolutionError,
    );
    try {
      resolveObjectCitations(object, model, labelToFactId);
    } catch (error) {
      expect((error as CitationResolutionError).code).toBe("quoted-span-not-found");
    }
  });
});
