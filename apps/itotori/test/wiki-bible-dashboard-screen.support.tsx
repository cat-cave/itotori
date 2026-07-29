import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  WikiBibleDashboardScreen,
  parseWikiBibleRoute,
} from "../src/ui/screens/WikiBibleDashboardScreen.js";
import { AddressableFocusScreen } from "../src/ui/screens/AddressableFocusScreen.js";
import { parsePlayFlagComposerRoute } from "../src/ui/screens/PlayFlagComposerScreen.js";
import { grantedStudioCapabilityView } from "../src/ui/caps-context.js";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import { App } from "../src/ui/App.js";
import { parseAddressableLocation } from "../src/ui/addressable-routing.js";
import { parseReturnTo } from "../src/ui/screens/AddressableFocusScreen.js";
import type {
  WikiHistoryEntry,
  WikiRenderingView,
  WikiSourceObjectView,
} from "../src/wiki/dashboard/read-model.js";
import {
  authIdentityFixture,
  costReportFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
} from "./api-fixtures.js";

export const PROJECT_ID = "project-1";

export const LOCALE_BRANCH_ID = "019ed065-0000-7000-8000-000000000110";

export const SNAPSHOT_ID = `sha256:${"a".repeat(64)}`;

export const HASH = `sha256:${"b".repeat(64)}`;

export const CANONICAL_STATEMENT = "The shrine bell tolls at dawn.";

export const AKARI_STATEMENT = "Akari confesses her feelings at the shrine.";

export const YUKI_STATEMENT = "Yuki never once visits the shrine.";

export function badges(
  overrides: Partial<WikiSourceObjectView["badges"]> = {},
): WikiSourceObjectView["badges"] {
  return {
    provisional: false,
    contextScope: "whole-game",
    runMode: "production",
    editedBy: null,
    ...overrides,
  };
}

export function sceneObject(): WikiSourceObjectView {
  const canonicalCitation = {
    claimId: "claim-canonical",
    evidenceId: "ev-unit-42",
    evidenceHash: HASH,
    snapshotId: SNAPSHOT_ID,
    subject: { kind: "unit" as const, id: "unit-42" },
    role: "establishes" as const,
    playOrderIndex: 3,
    quotedSpan: "the bell",
  };
  const sceneCitation = {
    claimId: "claim-canonical",
    evidenceId: "ev-scene-2031",
    evidenceHash: HASH,
    snapshotId: SNAPSHOT_ID,
    subject: { kind: "scene" as const, id: "scene-2031" },
    role: "establishes" as const,
    playOrderIndex: 3,
    quotedSpan: null,
  };
  return {
    kind: "source",
    objectId: "obj-scene-1",
    wikiKind: "source-object",
    category: "scene-summary",
    version: 1,
    lang: "ja",
    subject: { kind: "scene", id: "scene-2031" },
    routeScope: { kind: "global" },
    badges: badges({
      // Limited-context + test badges are part of the product surface.
      contextScope: "route-slice",
      runMode: "pilot",
    }),
    claims: [
      {
        claimId: "claim-canonical",
        statement: CANONICAL_STATEMENT,
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [canonicalCitation, sceneCitation],
      },
      {
        claimId: "claim-akari",
        statement: AKARI_STATEMENT,
        scope: { kind: "route", routeId: "route-akari" },
        kind: "arc",
        confidence: "medium",
        supersedesClaimId: null,
        citations: [
          {
            claimId: "claim-akari",
            evidenceId: "ev-scene-akari",
            evidenceHash: HASH,
            snapshotId: SNAPSHOT_ID,
            subject: { kind: "scene", id: "scene-akari-9" },
            role: "reveal",
            playOrderIndex: 12,
            quotedSpan: null,
          },
        ],
      },
      {
        claimId: "claim-yuki",
        statement: YUKI_STATEMENT,
        scope: { kind: "route", routeId: "route-yuki" },
        kind: "arc",
        confidence: "low",
        supersedesClaimId: null,
        citations: [],
      },
    ],
    citations: [canonicalCitation, sceneCitation],
    media: [
      {
        kind: "screenshot",
        mediaId: "media-shot-1",
        sceneId: "scene-2031",
        availability: {
          status: "available",
          artifactUri: "artifacts/utsushi/runtime/test-run/screenshots/shot-1.png",
          contentHash: HASH,
          mediaType: "image/png",
          dimensions: { width: 1280, height: 720 },
          access: { redaction: "default-redacted", permission: "project-member" },
        },
      },
    ],
  };
}

export function alternateSceneObject(): WikiSourceObjectView {
  return {
    ...sceneObject(),
    objectId: "obj-scene-2",
    subject: { kind: "scene", id: "scene-elsewhere" },
    claims: [
      {
        claimId: "claim-other-canonical",
        statement: "The archive door stays locked until sunset.",
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [],
      },
    ],
    citations: [],
    media: [],
  };
}

export function renderingFixture(sourceObjectId = "obj-scene-1"): WikiRenderingView {
  return {
    kind: "rendering",
    renderingId: `rendering-${sourceObjectId}-en`,
    sourceObjectId,
    category: "scene-summary",
    version: 1,
    targetLanguage: "en",
    routeScope: { kind: "global" },
    badges: badges(),
    claimRenderings: [
      {
        claimId: sourceObjectId === "obj-scene-1" ? "claim-canonical" : "claim-other-canonical",
        text:
          sourceObjectId === "obj-scene-1"
            ? "The temple bell rings at first light."
            : "The archive door remains shut until sunset.",
      },
    ],
  };
}

export function historyFixture(): WikiHistoryEntry[] {
  return [
    {
      version: 1,
      supersedesVersion: null,
      contentHash: HASH,
      editedBy: null,
      provisional: false,
      createdAt: "2026-07-15T00:00:00.000Z",
    },
  ];
}

export function wikiListBody() {
  return {
    schemaVersion: "itotori.wiki.objects.v1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    snapshotId: SNAPSHOT_ID,
    sourceObjects: [sceneObject(), alternateSceneObject()],
    renderings: [renderingFixture(), renderingFixture("obj-scene-2")],
  };
}

export function wikiShowBody(object: WikiSourceObjectView) {
  return {
    schemaVersion: "itotori.wiki.object.v1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    view: object,
    history: historyFixture(),
    dependencyImpact: {
      dependents: [
        {
          downstreamObjectId: "rendering-scene-1-en",
          downstreamWikiKind: "localized-rendering",
          downstreamVersion: 1,
          claimId: "claim-canonical",
          fieldPath: [] as string[],
          renderingId: "rendering-scene-1-en",
          protectedHuman: false,
        },
      ],
    },
  };
}

export function wikiWriteBody(inputId: string, object: WikiSourceObjectView) {
  return {
    schemaVersion: "itotori.wiki.write.v1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    receipt: {
      durable: true as const,
      inputId,
      head: { objectId: object.objectId, version: 2, contentHash: HASH },
      view: object,
      badges: badges({ editedBy: "human" }),
      dependencyImpact: {
        upstreamObjectId: object.objectId,
        priorVersion: 1,
        nextVersion: 2,
        consumers: [
          {
            downstreamWikiVersionId: "v-rendering-1",
            downstreamWikiKind: "localized-rendering" as const,
            downstreamObjectId: "rendering-scene-1-en",
            downstreamVersion: 1,
            workKind: "enhancement" as const,
            protectedHuman: false,
            matchedClaimIds: ["claim-canonical"],
            matchedFieldPaths: [] as string[][],
          },
        ],
        enhancementWork: ["v-rendering-1"],
        reviewerWork: [] as string[],
        impactSetHash: HASH,
      },
    },
    history: [
      ...historyFixture(),
      {
        version: 2,
        supersedesVersion: 1,
        contentHash: HASH,
        editedBy: "human",
        provisional: false,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    dependencyImpact: {
      upstreamObjectId: object.objectId,
      priorVersion: 1,
      nextVersion: 2,
      consumers: [
        {
          downstreamWikiVersionId: "v-rendering-1",
          downstreamWikiKind: "localized-rendering" as const,
          downstreamObjectId: "rendering-scene-1-en",
          downstreamVersion: 1,
          workKind: "enhancement" as const,
          protectedHuman: false,
          matchedClaimIds: ["claim-canonical"],
          matchedFieldPaths: [] as string[][],
        },
      ],
      enhancementWork: ["v-rendering-1"],
      reviewerWork: [] as string[],
      impactSetHash: HASH,
    },
  };
}

export function sourceObjectFor(objectId: string): WikiSourceObjectView | null {
  if (objectId === "obj-scene-1") {
    return sceneObject();
  }
  if (objectId === "obj-scene-2") {
    return alternateSceneObject();
  }
  return null;
}

export const flagReceipt = {
  schemaVersion: "itotori.play.flag-annotation.v0" as const,
  projectId: PROJECT_ID,
  localeBranchId: LOCALE_BRANCH_ID,
  feedbackReportId: "feedback-1",
  feedbackEvidenceId: "feedback-evidence-1",
  severity: "warning" as const,
  category: "context",
  note: "The cited line does not match this route.",
  triageLabel: "context",
  contextStatus: "scheduled",
  contextCorrectionId: "correction-1",
  duplicate: false,
};

export const capturedWrite: { value: unknown } = { value: null };

export const server = setupServer(
  http.get("*/api/auth/identity", () => HttpResponse.json(authIdentityFixture)),
  http.get("*/api/projects/status", () => HttpResponse.json(dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => HttpResponse.json(costReportFixture)),
  http.get("*/api/projects", () => HttpResponse.json(portfolioProjectsFixture)),
  http.get("*/api/wiki", () => HttpResponse.json(wikiListBody())),
  http.get("*/api/wiki/source-object/:objectId", ({ params }) => {
    const object = sourceObjectFor(String(params.objectId));
    return object === null
      ? new HttpResponse(null, { status: 404 })
      : HttpResponse.json(wikiShowBody(object));
  }),
  http.post("*/api/wiki/source-object/:objectId/:operation", async ({ params, request }) => {
    capturedWrite.value = await request.json();
    const object = sourceObjectFor(String(params.objectId));
    if (object === null) {
      return new HttpResponse(null, { status: 404 });
    }
    const inputId = params.operation === "edit" ? "edit-abc" : "feedback-abc";
    return HttpResponse.json(wikiWriteBody(inputId, object));
  }),
  http.post(`*/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/flags`, () =>
    HttpResponse.json(flagReceipt),
  ),
  http.get(`*/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/unit-feedback`, () =>
    HttpResponse.json({
      schemaVersion: "itotori.play.unit-feedback.v0",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      bridgeUnitId: "unit-42",
      notes: [],
    }),
  ),
);

export function renderScreen(
  search = `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}&snapshotId=${encodeURIComponent(SNAPSHOT_ID)}`,
) {
  const route = parseWikiBibleRoute("/bible", search);
  if (route === null) {
    throw new Error("route did not parse");
  }
  return render(
    <RedactionGovernor revealSensitive={false}>
      <WikiBibleDashboardScreen route={route} />
    </RedactionGovernor>,
  );
}
