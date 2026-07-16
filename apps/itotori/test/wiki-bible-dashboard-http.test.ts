// The Wiki bible dashboard HTTP adapter composes the wiki object API into the
// product-surface read-models. This drives the REAL handler against a
// structurally-real object API surface, proving the overview composition (route
// facets + readiness), the object detail, the non-blocking write's loop-close
// addressing, and the error mapping — no HTTP framework in the way.

import { describe, expect, it } from "vitest";
import {
  WikiObjectApiError,
  type WikiObjectApiService,
  type WikiObjectView,
  type WikiShowResult,
  type WikiWriteReceipt,
} from "../src/wiki/object-api/index.js";
import {
  handleWikiDashboardRequest,
  type WikiDashboardObject,
  type WikiDashboardOverview,
  type WikiDashboardWriteReceipt,
} from "../src/wiki/dashboard/index.js";

const HASH = `sha256:${"d".repeat(64)}`;
const SNAPSHOT_ID = `sha256:${"e".repeat(64)}`;
const NOW = "2026-07-16T00:00:00.000Z";

function sourceView(objectId: string, routeId: string | null): WikiObjectView {
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
        claimId: `${objectId}-c1`,
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
              claimId: `${objectId}-c2`,
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

function renderingView(sourceObjectId: string): WikiObjectView {
  return {
    kind: "rendering",
    renderingId: `${sourceObjectId}-en`,
    sourceObjectId,
    category: "scene-summary",
    version: 1,
    targetLanguage: "en",
    routeScope: { kind: "global" },
    badges: { provisional: false, contextScope: null, runMode: "production", editedBy: null },
    claimRenderings: [],
  };
}

function writeReceipt(): WikiWriteReceipt {
  return {
    durable: true,
    inputId: "feedback-1",
    head: { objectId: "obj-1", version: 2, contentHash: HASH },
    view: sourceView("obj-1", "route-akari"),
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
          matchedClaimIds: ["obj-1-c1"],
          matchedFieldPaths: [],
        },
      ],
      enhancementWork: ["v-1"],
      reviewerWork: [],
      impactSetHash: HASH,
    },
  };
}

function fakeService(
  overrides: Partial<Record<keyof WikiObjectApiService, unknown>> = {},
): WikiObjectApiService {
  const base = {
    list: async () => ({
      sourceObjects: [sourceView("obj-1", "route-akari"), sourceView("obj-2", null)],
      renderings: [renderingView("obj-1")],
    }),
    show: async (): Promise<WikiShowResult | null> => ({
      view: sourceView("obj-1", "route-akari"),
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
      dependents: [],
    }),
    openEditSession: async () => ({ objectId: "obj-1", wikiKind: "source-object" }),
    edit: async () => writeReceipt(),
    feedback: async () => writeReceipt(),
  };
  return { ...base, ...overrides } as unknown as WikiObjectApiService;
}

describe("wiki bible dashboard HTTP adapter", () => {
  it("composes the overview: route facets + readiness from the resolved list", async () => {
    const response = await handleWikiDashboardRequest(fakeService(), {
      method: "GET",
      snapshotId: SNAPSHOT_ID,
      objectId: null,
      wikiKind: null,
      body: null,
      now: NOW,
    });
    expect(response.status).toBe(200);
    const body = response.body as WikiDashboardOverview;
    expect(body.sourceObjects.map((view) => view.objectId)).toEqual(["obj-1", "obj-2"]);
    expect(body.routes).toEqual([{ routeId: "route-akari", claimCount: 1 }]);
    expect(body.readiness).toMatchObject({
      sourceObjectCount: 2,
      localizedSourceCount: 1,
      localizationCoveragePercent: 50,
    });
  });

  it("requires a snapshotId to browse the overview", async () => {
    const response = await handleWikiDashboardRequest(fakeService(), {
      method: "GET",
      snapshotId: null,
      objectId: null,
      wikiKind: null,
      body: null,
      now: NOW,
    });
    expect(response.status).toBe(400);
  });

  it("returns one object's view, history, and dependents", async () => {
    const response = await handleWikiDashboardRequest(fakeService(), {
      method: "GET",
      snapshotId: SNAPSHOT_ID,
      objectId: "obj-1",
      wikiKind: "source-object",
      body: null,
      now: NOW,
    });
    expect(response.status).toBe(200);
    const body = response.body as WikiDashboardObject;
    expect(body.object.objectId).toBe("obj-1");
    expect(body.history.map((entry) => entry.version)).toEqual([1]);
  });

  it("maps an unknown object to a 404", async () => {
    const response = await handleWikiDashboardRequest(fakeService({ show: async () => null }), {
      method: "GET",
      snapshotId: SNAPSHOT_ID,
      objectId: "missing",
      wikiKind: "source-object",
      body: null,
      now: NOW,
    });
    expect(response.status).toBe(404);
  });

  it("closes the loop: a feedback write receipt addresses the SAME object with its invalidations", async () => {
    const response = await handleWikiDashboardRequest(fakeService(), {
      method: "POST",
      snapshotId: SNAPSHOT_ID,
      objectId: "obj-1",
      wikiKind: "source-object",
      body: { input: { kind: "feedback", inputId: "feedback-1", text: "observed at dusk" } },
      now: NOW,
    });
    expect(response.status).toBe(200);
    const body = response.body as WikiDashboardWriteReceipt;
    expect(body.addressedObjectId).toBe("obj-1");
    expect(body.head.version).toBe(2);
    expect(body.invalidatedObjectIds).toEqual(["obj-1-en"]);
  });

  it("rejects a missing input body with a 400", async () => {
    const response = await handleWikiDashboardRequest(fakeService(), {
      method: "POST",
      snapshotId: SNAPSHOT_ID,
      objectId: "obj-1",
      wikiKind: "source-object",
      body: {},
      now: NOW,
    });
    expect(response.status).toBe(400);
  });

  it("maps a wiki object API error on the write path to a typed response", async () => {
    const response = await handleWikiDashboardRequest(
      fakeService({
        openEditSession: async () => {
          throw new WikiObjectApiError("wiki object obj-1 has no current head");
        },
      }),
      {
        method: "POST",
        snapshotId: SNAPSHOT_ID,
        objectId: "obj-1",
        wikiKind: "source-object",
        body: { input: { kind: "feedback", inputId: "feedback-1", text: "x" } },
        now: NOW,
      },
    );
    expect(response.status).toBe(404);
  });
});
