// wiki-structure-context-feed — pure unit tests for the structure-informed
// context feed builders.
//
// Asserts:
//   1. structured-context injection texts become feed items the reviewer can
//      read (scene summary + route + character arcs) with fedTheDraft=true;
//   2. bare artifact refs still surface classified items (fedTheDraft=false);
//   3. decision-record payload extraction is tolerant of missing/malformed
//      payloads and reconstructs the feed from the agentic-loop bridge shape.

import { describe, expect, it } from "vitest";
import type { StructuredContextInjection } from "../src/agents/structure-informed-context/shapes.js";
import {
  buildStructureContextFeedFromDecisionContext,
  buildStructureContextFeedFromInjection,
  classifyStructureContextArtifactRef,
  extractDecisionRecordStructureContext,
  structureContextFeedItemKindValues,
  structuredContextForDecisionRecord,
} from "../src/reviewer/structure-context-feed.js";

const INJECTION: StructuredContextInjection = {
  sceneId: 6010,
  sceneSummaryText:
    "Scene 6010: 3 messages; speakers Hero, Princess; opens with Hero; no choices; dispatches to scene 6020.",
  routePositionText:
    "Scene 6010 route position: position 1 of 2 in the dispatch order [6010 -> 6020]; entry scene; dispatches to scene 6020.",
  characterArcsText:
    "Speaker arcs in this scene:\n- Hero: appears in scenes 6010, 6020 (4 lines total).\n- Princess: appears in scenes 6010 (2 lines total).",
  artifactRefs: [
    "scene-summary:6010",
    "route-branch-map",
    "character-arc:Hero",
    "character-arc:Princess",
  ],
};

describe("classifyStructureContextArtifactRef", () => {
  it("classifies the closed taxonomy of structure-context refs", () => {
    expect(classifyStructureContextArtifactRef("scene-summary:6010")).toBe(
      structureContextFeedItemKindValues.sceneSummary,
    );
    expect(classifyStructureContextArtifactRef("character-arc:Hero")).toBe(
      structureContextFeedItemKindValues.characterArc,
    );
    expect(classifyStructureContextArtifactRef("character-bio:Hero")).toBe(
      structureContextFeedItemKindValues.characterBio,
    );
    expect(classifyStructureContextArtifactRef("character-rel:Hero->Princess")).toBe(
      structureContextFeedItemKindValues.characterRelationship,
    );
    expect(classifyStructureContextArtifactRef("route-branch-map")).toBe(
      structureContextFeedItemKindValues.routeMap,
    );
    expect(classifyStructureContextArtifactRef("route:main")).toBe(
      structureContextFeedItemKindValues.routeMap,
    );
    expect(classifyStructureContextArtifactRef("terminology-candidate:世界")).toBe(
      structureContextFeedItemKindValues.terminologyCandidate,
    );
    expect(classifyStructureContextArtifactRef("glossary-term:term-1")).toBe(
      structureContextFeedItemKindValues.glossaryTerm,
    );
    expect(classifyStructureContextArtifactRef("unknown-ref")).toBe(
      structureContextFeedItemKindValues.other,
    );
  });
});

describe("buildStructureContextFeedFromInjection", () => {
  it("builds a fedTheDraft feed with scene summary / route / character arcs the translator saw", () => {
    const feed = buildStructureContextFeedFromInjection({
      structuredContext: INJECTION,
      contextArtifactRefs: [...INJECTION.artifactRefs, "terminology-candidate:世界"],
      citationRefs: ["glossary:term-yusha"],
      sceneId: 6010,
    });
    expect(feed).not.toBeNull();
    expect(feed!.fedTheDraft).toBe(true);
    expect(feed!.sceneId).toBe(6010);
    expect(feed!.whyHeading).toMatch(/fed this draft/i);

    const kinds = feed!.items.map((item) => item.kind);
    expect(kinds).toContain(structureContextFeedItemKindValues.sceneSummary);
    expect(kinds).toContain(structureContextFeedItemKindValues.routeMap);
    expect(kinds).toContain(structureContextFeedItemKindValues.characterArc);
    expect(kinds).toContain(structureContextFeedItemKindValues.terminologyCandidate);
    expect(kinds).toContain(structureContextFeedItemKindValues.glossaryTerm);
    expect(feed!.citationRefs).toEqual(["glossary:term-yusha"]);

    const scene = feed!.items.find(
      (item) => item.kind === structureContextFeedItemKindValues.sceneSummary,
    );
    expect(scene?.body).toBe(INJECTION.sceneSummaryText);
    expect(scene?.feedRole).toMatch(/Fed the draft/i);

    const arcs = feed!.items.find(
      (item) => item.kind === structureContextFeedItemKindValues.characterArc,
    );
    expect(arcs?.body).toContain("Hero");
    expect(arcs?.body).toContain("Princess");
  });

  it("surfaces bare artifact refs when no structured injection was stored", () => {
    const feed = buildStructureContextFeedFromInjection({
      contextArtifactRefs: ["scene-summary:6010", "character-arc:Hero"],
      sceneId: 6010,
    });
    expect(feed).not.toBeNull();
    expect(feed!.fedTheDraft).toBe(false);
    expect(feed!.items).toHaveLength(2);
    expect(feed!.items[0]!.body).toMatch(/Cited scene summary/);
  });

  it("surfaces draft citationRefs as glossary feed items even when they are not context artifacts", () => {
    const feed = buildStructureContextFeedFromInjection({
      contextArtifactRefs: ["scene-summary:6010"],
      citationRefs: ["term-yusha"],
      sceneId: 6010,
    });
    expect(feed).not.toBeNull();
    expect(feed!.citationRefs).toEqual(["term-yusha"]);
    const glossary = feed!.items.find(
      (item) => item.kind === structureContextFeedItemKindValues.glossaryTerm,
    );
    expect(glossary?.artifactRef).toBe("term-yusha");
    expect(glossary?.body).toContain("term-yusha");
  });

  it("returns null when nothing is available", () => {
    expect(
      buildStructureContextFeedFromInjection({
        contextArtifactRefs: [],
      }),
    ).toBeNull();
  });
});

describe("extractDecisionRecordStructureContext + build from decision context", () => {
  it("extracts structured context from the agentic-loop bridge decision-record shape", () => {
    const payload = {
      source: "agentic_loop",
      decisionRecord: {
        schemaVersion: "itotori.agentic-loop-decision-record.v1",
        context: {
          contextArtifactRefs: INJECTION.artifactRefs,
          citationRefs: ["term-yusha"],
          sceneId: 6010,
          structuredContext: structuredContextForDecisionRecord(INJECTION),
        },
      },
    };
    const extracted = extractDecisionRecordStructureContext(payload);
    expect(extracted).not.toBeNull();
    expect(extracted!.sceneId).toBe(6010);
    expect(extracted!.citationRefs).toEqual(["term-yusha"]);
    expect(extracted!.structuredContext?.sceneSummaryText).toBe(INJECTION.sceneSummaryText);

    const feed = buildStructureContextFeedFromDecisionContext(extracted);
    expect(feed?.fedTheDraft).toBe(true);
    expect(feed?.items.some((i) => i.body === INJECTION.sceneSummaryText)).toBe(true);
    expect(
      feed?.items.some((i) => i.kind === structureContextFeedItemKindValues.glossaryTerm),
    ).toBe(true);
  });

  it("returns null for missing or empty payloads", () => {
    expect(extractDecisionRecordStructureContext(null)).toBeNull();
    expect(extractDecisionRecordStructureContext({})).toBeNull();
    expect(
      extractDecisionRecordStructureContext({
        decisionRecord: { context: { contextArtifactRefs: [] } },
      }),
    ).toBeNull();
  });
});
