// @vitest-environment jsdom
//
// Observable dashboard proof for the durable iteration loop. The real SPA
// reads lineage + feedback through the typed client, begins an exact-version
// play session, and navigates to the newly materialized refinement version.
// QA callouts deliberately remain visible annotations rather than action
// gates, even when contested and low-confidence.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  ApiPatchIterationFeedbackBatchResponse,
  ApiPatchIterationFeedbackResponse,
  ApiPatchIterationFeedbackInbox,
  ApiPatchIterationPatch,
  ApiPatchIterationPlayResponse,
  ApiPatchIterationRefineResponse,
  ApiPatchIterationVersion,
  ApiPatchIterationVersionsResponse,
} from "../src/api-schema.js";
import { App } from "../src/ui/App.js";
import { patchIterationHref } from "../src/ui/screens/PatchIterationScreen.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";

const LOCALE_BRANCH_ID = "locale-branch-patch-iteration";
const PATCH_V1 = "patch-version-v1";
const PATCH_V2 = "patch-version-v2";
const PATCH_V3 = "patch-version-v3";
const ITERATION_ROUTE = {
  pathname: "/play/patches",
  search: `?localeBranchId=${LOCALE_BRANCH_ID}&patchVersionId=${PATCH_V1}`,
};

const qaCallout = {
  journalFindingId: "qa-finding-1",
  bridgeUnitId: "bridge-unit-v1-1",
  severity: "warning",
  category: "terminology",
  note: "The shared name remains contested in this route.",
  confidence: "0.36",
  contested: true,
  informational: true as const,
};

const v1: ApiPatchIterationVersion = {
  patchVersionId: PATCH_V1,
  runId: "run-v1",
  parentPatchVersionId: null,
  origin: "run_finalizer",
  status: "playable",
  playableAt: "2026-07-13T12:00:00.000Z",
  selectedAt: "2026-07-13T12:00:01.000Z",
  artifactHashes: { patch: "sha256:patch-v1" },
  basePatchVersionId: null,
};

const v1Patch: ApiPatchIterationPatch = {
  patchVersionId: PATCH_V1,
  runId: "run-v1",
  parentPatchVersionId: null,
  origin: "run_finalizer",
  status: "playable",
  playableAt: "2026-07-13T12:00:00.000Z",
  selectedAt: "2026-07-13T12:00:01.000Z",
  artifactHashes: { patch: "sha256:patch-v1" },
  units: [
    {
      bridgeUnitId: "bridge-unit-v1-1",
      sourceRunId: "run-v1",
      journalOutcomeId: "outcome-v1-1",
      resultRevisionId: "result-v1-1",
      targetBody: "The first line of the playable v1 patch.",
      memberOrigin: "run_written_outcome",
      reusedFromPatchVersionId: null,
      unitOrdinal: 0,
    },
    {
      bridgeUnitId: "bridge-unit-v1-2",
      sourceRunId: "run-v1",
      journalOutcomeId: "outcome-v1-2",
      resultRevisionId: "result-v1-2",
      targetBody: "The unaffected v1 line stays available for reuse.",
      memberOrigin: "run_written_outcome",
      reusedFromPatchVersionId: null,
      unitOrdinal: 1,
    },
  ],
  qaCallouts: [qaCallout],
};

const v2: ApiPatchIterationVersion = {
  ...v1,
  patchVersionId: PATCH_V2,
  runId: "run-v2-result-edit",
  parentPatchVersionId: PATCH_V1,
  origin: "play_tester_edit",
  selectedAt: "2026-07-13T12:07:00.000Z",
  artifactHashes: { patch: "sha256:patch-v2" },
};

const v2Patch: ApiPatchIterationPatch = {
  ...v1Patch,
  patchVersionId: PATCH_V2,
  runId: v2.runId,
  parentPatchVersionId: PATCH_V1,
  origin: "play_tester_edit",
  selectedAt: v2.selectedAt,
  artifactHashes: { ...v2.artifactHashes },
  units: v1Patch.units.map((unit) =>
    unit.bridgeUnitId === "bridge-unit-v1-1"
      ? {
          ...unit,
          resultRevisionId: "result-v2-1",
          targetBody: "The first line selected by the play-tester edit.",
          memberOrigin: "play_tester_edit",
          reusedFromPatchVersionId: PATCH_V1,
        }
      : { ...unit, reusedFromPatchVersionId: PATCH_V1 },
  ),
};

const feedback: ApiPatchIterationFeedbackInbox = {
  observedPatchVersionId: PATCH_V1,
  batches: [
    {
      feedbackBatchId: "feedback-batch-session",
      observedPatchVersionId: PATCH_V1,
      actorUserId: "local-user",
      selectionKind: "batch",
      label: "Session observations",
      createdAt: "2026-07-13T12:05:00.000Z",
      updatedAt: "2026-07-13T12:05:00.000Z",
      events: [
        {
          feedbackEventId: "feedback-event-comment",
          feedbackBatchId: "feedback-batch-session",
          observedPatchVersionId: PATCH_V1,
          playSessionId: "play-session-earlier",
          actorUserId: "local-user",
          eventKind: "comment",
          body: "The name felt inconsistent in context.",
          metadata: {
            contextCorrection: {
              rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
            },
          },
          resultRevisionId: null,
          contextArtifactId: "context-artifact-comment",
          contextEntryVersionId: "context-version-comment",
          affectedBridgeUnitIds: ["bridge-unit-v1-1"],
          createdAt: "2026-07-13T12:05:00.000Z",
        },
      ],
    },
    {
      feedbackBatchId: "feedback-individual-result-edit",
      observedPatchVersionId: PATCH_V1,
      actorUserId: "local-user",
      selectionKind: "individual",
      label: null,
      createdAt: "2026-07-13T12:06:00.000Z",
      updatedAt: "2026-07-13T12:06:00.000Z",
      events: [
        {
          feedbackEventId: "feedback-event-result-edit",
          feedbackBatchId: "feedback-individual-result-edit",
          observedPatchVersionId: PATCH_V1,
          playSessionId: "play-session-earlier",
          actorUserId: "local-user",
          eventKind: "result_edit",
          body: null,
          metadata: {
            targetBody: "The first line corrected after play.",
            resultRevisionPatchVersionId: PATCH_V2,
          },
          resultRevisionId: "result-v1-1-edited",
          contextArtifactId: null,
          contextEntryVersionId: null,
          affectedBridgeUnitIds: ["bridge-unit-v1-1"],
          createdAt: "2026-07-13T12:06:00.000Z",
        },
      ],
    },
  ],
};

const inheritedFeedback: ApiPatchIterationFeedbackInbox = {
  ...feedback,
  // The child is the currently selected surface, while every batch/event
  // preserves its immutable v1 observation provenance.
  observedPatchVersionId: PATCH_V2,
};

const versionsResponse: ApiPatchIterationVersionsResponse = {
  schemaVersion: "itotori.patch-iteration.versions.v0",
  versions: [v1],
};

const playResponse: ApiPatchIterationPlayResponse = {
  schemaVersion: "itotori.patch-iteration.play.v0",
  session: {
    playSessionId: "play-session-v1",
    observedPatchVersionId: PATCH_V1,
    actorUserId: "local-user",
    status: "active",
    startedAt: "2026-07-13T12:10:00.000Z",
    endedAt: null,
    qaCallouts: [qaCallout],
  },
};

const feedbackBatchResponse: ApiPatchIterationFeedbackBatchResponse = {
  schemaVersion: "itotori.patch-iteration.feedback-batch.v0",
  batch: {
    feedbackBatchId: "feedback-batch-dashboard",
    observedPatchVersionId: PATCH_V1,
    actorUserId: "local-user",
    selectionKind: "batch",
    label: "Dashboard route notes",
    createdAt: "2026-07-13T12:12:00.000Z",
    updatedAt: "2026-07-13T12:12:00.000Z",
    events: [],
  },
};

const feedbackResponse: ApiPatchIterationFeedbackResponse = {
  schemaVersion: "itotori.patch-iteration.feedback.v0",
  feedback: {
    feedbackEventId: "feedback-event-dashboard",
    feedbackBatchId: "feedback-batch-dashboard",
    observedPatchVersionId: PATCH_V1,
    playSessionId: "play-session-v1",
    actorUserId: "local-user",
    eventKind: "comment",
    body: "The dashboard attached this route observation.",
    metadata: {
      contextCorrection: {
        rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
      },
    },
    resultRevisionId: null,
    contextArtifactId: "context-artifact-dashboard",
    contextEntryVersionId: "context-version-dashboard",
    affectedBridgeUnitIds: ["bridge-unit-v1-1"],
    createdAt: "2026-07-13T12:13:00.000Z",
  },
};

const refineResponse: ApiPatchIterationRefineResponse = {
  schemaVersion: "itotori.patch-iteration.refine.v0",
  refinement: {
    runId: "run-v2-refinement",
    basePatchVersionId: PATCH_V1,
    feedbackBatchIds: ["feedback-batch-session", "feedback-individual-result-edit"],
    wikiHeads: [],
    members: [
      {
        bridgeUnitId: "bridge-unit-v1-1",
        strategy: "redraft",
        basePatchVersionId: PATCH_V1,
        baseSourceRunId: "run-v1",
        baseJournalOutcomeId: "outcome-v1-1",
        baseResultRevisionId: "result-v1-1",
      },
      {
        bridgeUnitId: "bridge-unit-v1-2",
        strategy: "reuse",
        basePatchVersionId: PATCH_V1,
        baseSourceRunId: "run-v1",
        baseJournalOutcomeId: "outcome-v1-2",
        baseResultRevisionId: "result-v1-2",
      },
    ],
  },
  patch: {
    ...v1Patch,
    patchVersionId: PATCH_V2,
    runId: "run-v2-refinement",
    parentPatchVersionId: PATCH_V1,
    origin: "refinement_run",
    selectedAt: "2026-07-13T12:11:00.000Z",
    units: [
      {
        ...v1Patch.units[0]!,
        sourceRunId: "run-v2-refinement",
        journalOutcomeId: "outcome-v2-1",
        resultRevisionId: "result-v2-1",
        targetBody: "The first line corrected after play.",
      },
      {
        ...v1Patch.units[1]!,
        memberOrigin: "reused_from_base",
        reusedFromPatchVersionId: PATCH_V1,
      },
    ],
  },
};

const inheritedRefineResponse: ApiPatchIterationRefineResponse = {
  ...refineResponse,
  refinement: {
    ...refineResponse.refinement,
    runId: "run-v3-from-inherited-feedback",
    basePatchVersionId: PATCH_V2,
  },
  patch: {
    ...refineResponse.patch,
    patchVersionId: PATCH_V3,
    runId: "run-v3-from-inherited-feedback",
    parentPatchVersionId: PATCH_V2,
    units: v2Patch.units,
  },
};

let capturedPlay: unknown = null;
let capturedRefinement: unknown = null;
let capturedFeedbackBatch: unknown = null;
let capturedFeedback: unknown = null;

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get(`*/api/play/locale-branches/${LOCALE_BRANCH_ID}/patch-versions`, () =>
    apiJson("patchIteration.versions", versionsResponse),
  ),
  http.get(`*/api/play/patch-versions/${PATCH_V1}`, () =>
    apiJson("patchIteration.surface", {
      schemaVersion: "itotori.patch-iteration.surface.v0",
      patch: v1Patch,
      versions: [v1],
      feedback,
    }),
  ),
  http.post(`*/api/play/patch-versions/${PATCH_V1}/sessions`, async ({ request }) => {
    capturedPlay = await request.json();
    return apiJson("patchIteration.play", playResponse);
  }),
  http.post(`*/api/play/patch-versions/${PATCH_V1}/feedback-batches`, async ({ request }) => {
    capturedFeedbackBatch = await request.json();
    return apiJson("patchIteration.feedbackBatch", feedbackBatchResponse);
  }),
  http.post(`*/api/play/patch-versions/${PATCH_V1}/feedback`, async ({ request }) => {
    capturedFeedback = await request.json();
    return apiJson("patchIteration.feedback", feedbackResponse);
  }),
  http.post(`*/api/play/patch-versions/${PATCH_V1}/refine`, async ({ request }) => {
    capturedRefinement = await request.json();
    return apiJson("patchIteration.refine", refineResponse);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  capturedPlay = null;
  capturedRefinement = null;
  capturedFeedbackBatch = null;
  capturedFeedback = null;
});
afterAll(() => server.close());

function useDefaultChildSurface(feedbackForChild: ApiPatchIterationFeedbackInbox): void {
  server.use(
    http.get(`*/api/play/locale-branches/${LOCALE_BRANCH_ID}/patch-versions`, () =>
      apiJson("patchIteration.versions", {
        schemaVersion: "itotori.patch-iteration.versions.v0",
        versions: [v1, v2],
      }),
    ),
    http.get(`*/api/play/patch-versions/${PATCH_V2}`, () =>
      apiJson("patchIteration.surface", {
        schemaVersion: "itotori.patch-iteration.surface.v0",
        patch: v2Patch,
        versions: [v1, v2],
        feedback: feedbackForChild,
      }),
    ),
    http.post(`*/api/play/patch-versions/${PATCH_V2}/refine`, async ({ request }) => {
      capturedRefinement = await request.json();
      return apiJson("patchIteration.refine", inheritedRefineResponse);
    }),
  );
}

function inheritedFeedbackWithCommentMetadata(
  metadata: Record<string, unknown>,
): ApiPatchIterationFeedbackInbox {
  return {
    ...inheritedFeedback,
    batches: inheritedFeedback.batches.map((batch) =>
      batch.feedbackBatchId !== "feedback-batch-session"
        ? batch
        : {
            ...batch,
            events: batch.events.map((event) =>
              event.feedbackEventId === "feedback-event-comment" ? { ...event, metadata } : event,
            ),
          },
    ),
  };
}

function inheritedFeedbackWithMixedContextCorrectionStates(): ApiPatchIterationFeedbackInbox {
  const pendingMetadata = {
    contextCorrection: {
      rerun: { state: "pending", jobStatus: "queued", error: null },
    },
  };
  const succeededMetadata = {
    contextCorrection: {
      rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
    },
  };
  const feedbackWithPendingComment = inheritedFeedbackWithCommentMetadata(pendingMetadata);
  return {
    ...feedbackWithPendingComment,
    batches: feedbackWithPendingComment.batches.map((batch) =>
      batch.feedbackBatchId !== "feedback-batch-session"
        ? batch
        : {
            ...batch,
            events: [
              ...batch.events,
              {
                ...batch.events[0]!,
                feedbackEventId: "feedback-event-comment-succeeded-sibling",
                metadata: succeededMetadata,
              },
            ],
          },
    ),
  };
}

describe("SPA shell — patch iteration dashboard", () => {
  it("opens the exact patched runtime and refines selected feedback without QA gating", async () => {
    const navigate = vi.fn();
    render(<App location={ITERATION_ROUTE} navigate={navigate} />);

    // Wait for the typed versions + exact historical surface, not merely the
    // static shell header (which renders during the loading state too).
    expect(await screen.findByLabelText("Patch iteration dashboard")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Patch iterations" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "patch-iteration");
    expect(main).toHaveAttribute("data-state", "ready");
    expect(main).toHaveAttribute("data-locale-branch-id", LOCALE_BRANCH_ID);
    expect(screen.getByRole("link", { name: "Play route map" })).toHaveAttribute(
      "href",
      "/play/routemap",
    );
    expect(screen.queryByRole("link", { name: "Scene picker" })).not.toBeInTheDocument();

    const dashboard = screen.getByLabelText("Patch iteration dashboard");
    expect(dashboard).toHaveAttribute("data-qa-gates-actions", "false");
    const callouts = screen.getByLabelText("Informational QA callouts");
    expect(callouts).toHaveTextContent("terminology: The shared name remains contested");
    expect(callouts.closest("section")).toHaveAttribute("data-gates-actions", "false");

    const play = screen.getByRole("button", { name: "Play this patch" });
    const refine = screen.getByRole("button", { name: "Refine selected feedback" });
    expect(play).toBeEnabled();
    expect(refine).toBeEnabled();

    fireEvent.click(play);
    await waitFor(() => expect(capturedPlay).toEqual({}));
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.getAttribute("data-patch-iteration-status") === "play-started",
      ),
    ).toHaveTextContent(/Patched runtime opened.*play-session-v1.*linked/i);

    fireEvent.click(screen.getByLabelText("Select feedback batch Session observations"));
    fireEvent.click(screen.getByText("Optional scope and wiki inputs"));
    fireEvent.change(screen.getByLabelText("Additional bridge-unit IDs (comma-separated)"), {
      target: { value: "bridge-unit-v1-3" },
    });
    fireEvent.change(screen.getByLabelText("Target bodies JSON (unit ID → target text)"), {
      target: { value: '{"bridge-unit-v1-3":"A broadened choice target."}' },
    });
    fireEvent.change(screen.getByLabelText("Explicit wiki heads JSON (optional)"), {
      target: {
        value: '[{"contextArtifactId":"wiki-artifact-1","contextEntryVersionId":"wiki-version-1"}]',
      },
    });
    fireEvent.click(refine);
    await waitFor(() => {
      expect(capturedRefinement).toEqual({
        feedbackBatchIds: [],
        feedbackEventIds: ["feedback-event-result-edit"],
        scopeUnitIds: ["bridge-unit-v1-1", "bridge-unit-v1-2", "bridge-unit-v1-3"],
        targetBodiesByUnit: { "bridge-unit-v1-3": "A broadened choice target." },
        wikiHeads: [
          { contextArtifactId: "wiki-artifact-1", contextEntryVersionId: "wiki-version-1" },
        ],
      });
    });
    expect(navigate).toHaveBeenCalledWith(
      patchIterationHref({ localeBranchId: LOCALE_BRANCH_ID, patchVersionId: PATCH_V2 }),
    );
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.getAttribute("data-patch-iteration-status") === "refinement-built",
      ),
    ).toHaveTextContent(/Refinement produced.*patch-version-v2/i);

    const feedbackBatches = screen.getByLabelText("Feedback batches");
    expect(feedbackBatches.querySelectorAll(":scope > li")).toHaveLength(1);
    expect(
      within(screen.getByLabelText("Individual feedback events")).getAllByRole("listitem"),
    ).toHaveLength(1);
  });

  it("records dashboard feedback against the retained exact play session", async () => {
    render(<App location={ITERATION_ROUTE} navigate={vi.fn()} />);
    await screen.findByLabelText("Patch iteration dashboard");

    fireEvent.click(screen.getByRole("button", { name: "Play this patch" }));
    await waitFor(() => expect(capturedPlay).toEqual({}));

    fireEvent.change(screen.getByLabelText("Batch label (optional)"), {
      target: { value: "Dashboard route notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create feedback batch" }));
    await waitFor(() => expect(capturedFeedbackBatch).toEqual({ label: "Dashboard route notes" }));

    const batchId = screen.getByLabelText(/Feedback batch ID/);
    await waitFor(() => expect(batchId).toHaveValue("feedback-batch-dashboard"));
    fireEvent.change(screen.getByLabelText("Comment (required)"), {
      target: { value: "The dashboard attached this route observation." },
    });
    fireEvent.change(screen.getByLabelText("Affected bridge-unit IDs (comma-separated)"), {
      target: { value: "bridge-unit-v1-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Attach feedback" }));
    await waitFor(() => {
      expect(capturedFeedback).toEqual({
        feedbackBatchId: "feedback-batch-dashboard",
        playSessionId: "play-session-v1",
        eventKind: "comment",
        body: "The dashboard attached this route observation.",
        affectedBridgeUnitIds: ["bridge-unit-v1-1"],
      });
    });
  });

  it("refuses an unscoped comment locally instead of POSTing an event-only feedback item", async () => {
    render(<App location={ITERATION_ROUTE} navigate={vi.fn()} />);
    await screen.findByLabelText("Patch iteration dashboard");

    fireEvent.change(screen.getByLabelText("Comment (required)"), {
      target: { value: "This comment has no target unit." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Attach feedback" }));

    expect(
      await screen.findByText(
        "A comment needs a non-blank note and at least one bridge-unit ID so it can become a canonical correction.",
      ),
    ).toBeInTheDocument();
    expect(capturedFeedback).toBeNull();
  });

  it("writes added context through the canonical WikiBrain feedback path", async () => {
    render(<App location={ITERATION_ROUTE} navigate={vi.fn()} />);
    await screen.findByLabelText("Patch iteration dashboard");

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "added_context" } });
    expect(screen.getByLabelText("Write through canonical WikiBrain")).toBeChecked();
    fireEvent.change(screen.getByLabelText("Affected bridge-unit IDs (comma-separated)"), {
      target: { value: "bridge-unit-v1-1" },
    });
    fireEvent.change(screen.getByLabelText("Context entry kind"), {
      target: { value: "glossary" },
    });
    fireEvent.change(screen.getByLabelText("Context entry title"), {
      target: { value: "Moonlit Gate" },
    });
    fireEvent.change(screen.getByLabelText("Context entry body"), {
      target: { value: "Use Moonlit Gate consistently in this route." },
    });
    fireEvent.change(screen.getByLabelText("Why this context matters"), {
      target: { value: "The first play session exposed a terminology mismatch." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Attach feedback" }));

    await waitFor(() => {
      expect(capturedFeedback).toEqual({
        eventKind: "added_context",
        contextFeedback: {
          operation: "add",
          kind: "glossary",
          title: "Moonlit Gate",
          body: "Use Moonlit Gate consistently in this route.",
          reason: "The first play session exposed a terminology mismatch.",
          affectedBridgeUnitIds: ["bridge-unit-v1-1"],
        },
      });
    });
  });

  it("writes a wiki edit through the canonical WikiBrain feedback path", async () => {
    render(<App location={ITERATION_ROUTE} navigate={vi.fn()} />);
    await screen.findByLabelText("Patch iteration dashboard");

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "wiki_edit" } });
    fireEvent.change(screen.getByLabelText("Affected bridge-unit IDs (comma-separated)"), {
      target: { value: "bridge-unit-v1-1, bridge-unit-v1-2" },
    });
    fireEvent.change(screen.getByLabelText("Existing wiki/context artifact ID"), {
      target: { value: "wiki-artifact-gate" },
    });
    fireEvent.change(screen.getByLabelText("Replacement context body"), {
      target: { value: "The corrected canonical gate description." },
    });
    fireEvent.change(screen.getByLabelText("Why this context matters"), {
      target: { value: "The route proof contradicted the previous wiki entry." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Attach feedback" }));

    await waitFor(() => {
      expect(capturedFeedback).toEqual({
        eventKind: "wiki_edit",
        contextFeedback: {
          operation: "edit",
          contextArtifactId: "wiki-artifact-gate",
          body: "The corrected canonical gate description.",
          reason: "The route proof contradicted the previous wiki entry.",
          affectedBridgeUnitIds: ["bridge-unit-v1-1", "bridge-unit-v1-2"],
        },
      });
    });
  });

  it("shows inherited v1 feedback on the default selected child and refines from that child", async () => {
    useDefaultChildSurface(inheritedFeedback);
    const navigate = vi.fn();
    render(
      <App
        location={{
          pathname: "/play/patches",
          search: `?localeBranchId=${LOCALE_BRANCH_ID}`,
        }}
        navigate={navigate}
      />,
    );

    const dashboard = await screen.findByLabelText("Patch iteration dashboard");
    expect(dashboard.querySelector("[data-active-patch-version-id]")).toHaveAttribute(
      "data-active-patch-version-id",
      PATCH_V2,
    );
    expect(screen.getByText(/The name felt inconsistent in context\./u)).toBeInTheDocument();
    expect(screen.getByLabelText("Feedback batches")).toHaveTextContent("Session observations");
    expect(screen.getByLabelText("Individual feedback events")).toHaveTextContent("result_edit");
    expect(
      screen.getByLabelText("Select feedback event feedback-event-result-edit"),
    ).toBeDisabled();
    expect(screen.getByText("already applied")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refine selected feedback" }));
    await waitFor(() => {
      expect(capturedRefinement).toEqual({
        feedbackBatchIds: ["feedback-batch-session"],
        feedbackEventIds: [],
      });
    });
    expect(navigate).toHaveBeenCalledWith(
      patchIterationHref({ localeBranchId: LOCALE_BRANCH_ID, patchVersionId: PATCH_V3 }),
    );
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.getAttribute("data-patch-iteration-status") === "refinement-built",
      ),
    ).toHaveTextContent(new RegExp(PATCH_V3, "u"));
  });

  it.each([
    ["pending", { state: "pending", jobStatus: "queued", error: null }],
    ["failed", { state: "failed", jobStatus: "dead_letter", error: "redraft exhausted" }],
  ] as const)(
    "keeps inherited feedback with a $state canonical rerun visible but disabled",
    async (_state, rerun) => {
      useDefaultChildSurface(
        inheritedFeedbackWithCommentMetadata({ contextCorrection: { rerun } }),
      );
      render(
        <App
          location={{
            pathname: "/play/patches",
            search: `?localeBranchId=${LOCALE_BRANCH_ID}`,
          }}
          navigate={vi.fn()}
        />,
      );

      await screen.findByLabelText("Patch iteration dashboard");
      const batches = screen.getByLabelText("Feedback batches");
      const batch = batches.querySelector('[data-feedback-batch-id="feedback-batch-session"]');
      expect(batch).toHaveAttribute("data-refinement-status", "canonical_redraft_not_succeeded");
      expect(screen.getByLabelText("Select feedback batch Session observations")).toBeDisabled();
      expect(
        within(batches).getAllByText(/canonical redraft not succeeded/u).length,
      ).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Refine selected feedback" })).toBeDisabled();
    },
  );

  it("disables an atomic batch when a failed-redraft event has a refinable sibling", async () => {
    useDefaultChildSurface(inheritedFeedbackWithMixedContextCorrectionStates());
    render(
      <App
        location={{
          pathname: "/play/patches",
          search: `?localeBranchId=${LOCALE_BRANCH_ID}`,
        }}
        navigate={vi.fn()}
      />,
    );

    await screen.findByLabelText("Patch iteration dashboard");
    const batches = screen.getByLabelText("Feedback batches");
    const batch = batches.querySelector('[data-feedback-batch-id="feedback-batch-session"]');
    expect(batch).toHaveAttribute("data-selected", "false");
    expect(batch).toHaveAttribute("data-refinement-status", "canonical_redraft_not_succeeded");
    expect(screen.getByLabelText("Select feedback batch Session observations")).toBeDisabled();
    expect(
      batches.querySelector('[data-feedback-event-id="feedback-event-comment-succeeded-sibling"]'),
    ).toHaveAttribute("data-refinement-status", "refinable");
  });

  it("keeps legacy/reference-only inherited context feedback refinable", async () => {
    useDefaultChildSurface(inheritedFeedbackWithCommentMetadata({}));
    render(
      <App
        location={{
          pathname: "/play/patches",
          search: `?localeBranchId=${LOCALE_BRANCH_ID}`,
        }}
        navigate={vi.fn()}
      />,
    );

    await screen.findByLabelText("Patch iteration dashboard");
    expect(screen.getByLabelText("Select feedback batch Session observations")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refine selected feedback" })).toBeEnabled();
  });
});
