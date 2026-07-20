// Pure adapters from the RB-035 WikiObject wire envelopes to the product-surface
// dashboard read-models. Proves readiness, route facets, and write-loop
// addressing are derived — never invented.

import { describe, expect, it } from "vitest";
import {
  objectFromWikiShow,
  overviewFromWikiList,
  writeReceiptFromWikiWrite,
} from "../src/ui/screens/wiki-bible/adapt.js";
import type { WikiSourceObjectView } from "../src/wiki/dashboard/read-model.js";

const HASH = `sha256:${"c".repeat(64)}`;
const SNAPSHOT = `sha256:${"d".repeat(64)}`;
const NOW = "2026-07-16T12:00:00.000Z";

function source(objectId: string, routeId: string | null): WikiSourceObjectView {
  return {
    kind: "source",
    objectId,
    wikiKind: "source-object",
    category: "scene-summary",
    version: 1,
    lang: "ja",
    subject: { kind: "scene", id: objectId },
    routeScope: { kind: "global" },
    badges: {
      provisional: false,
      contextScope: "whole-game",
      runMode: "production",
      editedBy: null,
    },
    claims: [
      {
        claimId: `${objectId}-global`,
        statement: "canonical",
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [],
      },
      ...(routeId === null
        ? []
        : [
            {
              claimId: `${objectId}-route`,
              statement: "route claim",
              scope: { kind: "route" as const, routeId },
              kind: "arc" as const,
              confidence: "medium" as const,
              supersedesClaimId: null,
              citations: [],
            },
          ]),
    ],
    citations: [],
    media: [],
  };
}

describe("wiki bible RB-035 adapters", () => {
  it("builds overview readiness and route facets from wiki.list", () => {
    const overview = overviewFromWikiList({
      schemaVersion: "itotori.wiki.objects.v1",
      generatedAt: NOW,
      snapshotId: SNAPSHOT,
      sourceObjects: [source("obj-1", "route-akari"), source("obj-2", null)],
      renderings: [
        {
          kind: "rendering",
          renderingId: "obj-1-en",
          sourceObjectId: "obj-1",
          category: "scene-summary",
          version: 1,
          targetLanguage: "en",
          routeScope: { kind: "global" },
          badges: {
            provisional: false,
            contextScope: null,
            runMode: "production",
            editedBy: null,
          },
          claimRenderings: [],
        },
      ],
    });
    expect(overview.schemaVersion).toBe("itotori.wiki-dashboard.overview.v1");
    expect(overview.routes).toEqual([{ routeId: "route-akari", claimCount: 1 }]);
    expect(overview.readiness).toMatchObject({
      sourceObjectCount: 2,
      localizedSourceCount: 1,
      localizationCoveragePercent: 50,
    });
  });

  it("projects wiki.show into object detail with dependents", () => {
    const detail = objectFromWikiShow(
      {
        schemaVersion: "itotori.wiki.object.v1",
        generatedAt: NOW,
        view: source("obj-1", null),
        history: [
          {
            version: 1,
            supersedesVersion: null,
            contentHash: HASH,
            editedBy: null,
            provisional: false,
            createdAt: NOW,
          },
        ],
        dependencyImpact: {
          dependents: [
            {
              downstreamObjectId: "obj-1-en",
              downstreamWikiKind: "localized-rendering",
              downstreamVersion: 1,
              claimId: null,
              fieldPath: [],
              renderingId: "obj-1-en",
              protectedHuman: false,
            },
          ],
        },
      },
      SNAPSHOT,
    );
    expect(detail.schemaVersion).toBe("itotori.wiki-dashboard.object.v1");
    expect(detail.snapshotId).toBe(SNAPSHOT);
    expect(detail.object.kind === "source" && detail.object.objectId).toBe("obj-1");
    expect(detail.dependents).toHaveLength(1);
  });

  it("projects a write receipt so the surface re-selects the addressed object", () => {
    const receipt = writeReceiptFromWikiWrite(
      {
        schemaVersion: "itotori.wiki.write.v1",
        generatedAt: NOW,
        receipt: {
          durable: true,
          inputId: "human:fb:1",
          head: { objectId: "obj-1", version: 2, contentHash: HASH },
          view: source("obj-1", null),
          badges: {
            provisional: false,
            contextScope: "whole-game",
            runMode: "production",
            editedBy: "human",
          },
          dependencyImpact: {
            upstreamObjectId: "obj-1",
            priorVersion: 1,
            nextVersion: 2,
            consumers: [
              {
                downstreamWikiVersionId: "v-1",
                downstreamWikiKind: "localized-rendering",
                downstreamObjectId: "obj-1-en",
                downstreamVersion: 1,
                workKind: "enhancement",
                protectedHuman: false,
                matchedClaimIds: [],
                matchedFieldPaths: [],
              },
            ],
            enhancementWork: ["v-1"],
            reviewerWork: [],
            impactSetHash: HASH,
          },
        },
        history: [],
        dependencyImpact: {
          upstreamObjectId: "obj-1",
          priorVersion: 1,
          nextVersion: 2,
          consumers: [],
          enhancementWork: [],
          reviewerWork: [],
          impactSetHash: HASH,
        },
      },
      "source-object",
    );
    expect(receipt.schemaVersion).toBe("itotori.wiki-dashboard.write.v1");
    expect(receipt.addressedObjectId).toBe("obj-1");
    expect(receipt.addressedWikiKind).toBe("source-object");
    expect(receipt.invalidatedObjectIds).toEqual(["obj-1-en"]);
  });
});
