// @vitest-environment jsdom
// ITOTORI-082 — reviewer detail view (pure render) tests.

import { describe, expect, it } from "vitest";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
} from "@itotori/db";
import {
  deniedContextFixture,
  draftFixture,
  parseReviewerDetailRoute,
  readyContextFixture,
  renderReviewerDetailView,
  reviewerDetailDiagnosticCodeValues,
  reviewerDetailViewInternals,
  runtimeBenchmarkFixture,
  runtimeProviderProofFixture,
  runtimeScreenshotFixture,
  runtimeTextTraceFixture,
  sourceUnitFixture,
  staleContextFixture,
  type ReviewerDetailContext,
} from "../src/reviewer/index.js";

function renderInto(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("parseReviewerDetailRoute", () => {
  it("recognizes /reviewer-queue/:reviewItemId", () => {
    expect(parseReviewerDetailRoute("/reviewer-queue/reviewer-queue-1")).toEqual({
      reviewItemId: "reviewer-queue-1",
    });
  });

  it("URL-decodes the review item id", () => {
    expect(parseReviewerDetailRoute("/reviewer-queue/reviewer-queue-1%2Fextra")).toEqual({
      reviewItemId: "reviewer-queue-1/extra",
    });
  });

  it("returns null for unrelated routes", () => {
    expect(parseReviewerDetailRoute("/reviewer-queue/")).toBeNull();
    expect(parseReviewerDetailRoute("/api/projects")).toBeNull();
    expect(parseReviewerDetailRoute("/style-guide-builder")).toBeNull();
  });
});

describe("renderReviewerDetailView — denial UI", () => {
  it("renders the denial pane when the actor cannot read the queue", () => {
    const root = renderInto(renderReviewerDetailView(deniedContextFixture("anon")));
    const main = root.querySelector(".reviewer-detail");
    expect(main?.getAttribute("data-state")).toBe("denied");
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.textContent).toContain("Access denied");
    expect(root.textContent).toContain("queue.read");
  });

  it("does NOT render any evidence payload below the denial banner", () => {
    const root = renderInto(renderReviewerDetailView(deniedContextFixture("anon")));
    // None of the detail panels should be present at all.
    expect(root.querySelector('[data-panel-id="source-unit"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="draft"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="runtime-evidence"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="glossary"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="rationale"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="comparison"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="transitions"]')).toBeNull();
  });

  it("preserves the review item id in the data attribute even on denial", () => {
    const context = deniedContextFixture();
    const root = renderInto(renderReviewerDetailView(context));
    const main = root.querySelector(".reviewer-detail")!;
    expect(main.getAttribute("data-review-item-id")).toBe(context.reviewItemId);
  });
});

describe("renderReviewerDetailView — ready view", () => {
  it("renders source, draft, policy, glossary, QA findings, runtime evidence, rationale, and transition panels", () => {
    const context = readyContextFixture();
    const root = renderInto(renderReviewerDetailView(context));
    for (const id of [
      "source-unit",
      "draft",
      "comparison",
      "policy",
      "glossary",
      "qa-findings",
      "runtime-evidence",
      "rationale",
      "transitions",
    ]) {
      expect(root.querySelector(`[data-panel-id="${id}"]`), `expected panel ${id}`).not.toBeNull();
    }
  });

  it("renders the side-by-side comparison panel with source, draft, and approved patch when present", () => {
    const context: ReviewerDetailContext = {
      ...readyContextFixture(),
      draft: draftFixture({ approvedPatchText: "Hello, world!" }),
    };
    const root = renderInto(renderReviewerDetailView(context));
    expect(root.querySelector('[data-comparison-side="source"]')?.textContent).toContain(
      context.source!.sourceText,
    );
    expect(root.querySelector('[data-comparison-side="draft"]')?.textContent).toContain(
      context.draft!.draftText,
    );
    expect(root.querySelector('[data-comparison-side="approved-patch"]')?.textContent).toContain(
      "Hello, world!",
    );
  });

  it("renders runtime evidence rows with tier, runtime target id, observation events, and artifact hashes (no local path)", () => {
    const context: ReviewerDetailContext = {
      ...readyContextFixture(),
      runtimeEvidence: [runtimeTextTraceFixture(), runtimeScreenshotFixture()],
    };
    const root = renderInto(renderReviewerDetailView(context));
    const tiers = Array.from(root.querySelectorAll("[data-evidence-tier]")).map((node) =>
      node.getAttribute("data-evidence-tier"),
    );
    expect(tiers).toEqual(["tier-2-trace", "tier-3-recording"]);

    const targets = Array.from(root.querySelectorAll("[data-runtime-target-id]")).map((node) =>
      node.getAttribute("data-runtime-target-id"),
    );
    expect(targets).toEqual(["utsushi-runtime-target-fixture", "utsushi-runtime-target-fixture"]);

    const observations = Array.from(root.querySelectorAll("[data-observation-event-id]")).map(
      (node) => node.getAttribute("data-observation-event-id"),
    );
    expect(observations).toEqual([
      "observation-event-text-1",
      "observation-event-text-2",
      "observation-event-screenshot-1",
    ]);

    const hashes = Array.from(root.querySelectorAll("[data-artifact-hash]")).map((node) =>
      node.getAttribute("data-artifact-hash"),
    );
    expect(hashes).toEqual(["sha256:text-trace-bytes-1", "sha256:screenshot-bytes-1"]);

    // Audit guard: no local path attribute should ever be emitted.
    expect(root.innerHTML).not.toMatch(/data-local-path/);
    expect(root.innerHTML).not.toMatch(/file:\/\//);
  });

  it("renders benchmark + provider proof fixtures with their proof refs", () => {
    const context: ReviewerDetailContext = {
      ...readyContextFixture(),
      runtimeEvidence: [runtimeBenchmarkFixture(), runtimeProviderProofFixture()],
    };
    const root = renderInto(renderReviewerDetailView(context));
    const proofRefs = Array.from(root.querySelectorAll("[data-provider-proof-ref]")).map((node) =>
      node.getAttribute("data-provider-proof-ref"),
    );
    expect(proofRefs).toEqual([
      "provider:openrouter:run-benchmark-1",
      "provider:openrouter:run-benchmark-2",
      "provider:openrouter:proof-recording-1",
      "provider:openai:proof-recording-2",
    ]);
  });

  it("surfaces the persisted item evidence tier / artifact hashes / observation events on the runtime evidence header for runtime_evidence items", () => {
    const context = readyContextFixture();
    context.item = {
      ...context.item!,
      itemKind: reviewerQueueItemKindValues.runtimeEvidence,
      evidenceTier: "tier-2-trace",
      observationEventIds: ["observation-event-fixture-1"],
      artifactHashes: ["sha256:fixture-runtime-bytes"],
    };
    const root = renderInto(renderReviewerDetailView(context));
    const panel = root.querySelector('[data-panel-id="runtime-evidence"]')!;
    expect(panel.textContent).toContain("tier-2-trace");
    expect(panel.textContent).toContain("observation-event-fixture-1");
    expect(panel.textContent).toContain("sha256:fixture-runtime-bytes");
  });

  it("disables every action button when the actor lacks queue.manage", () => {
    const context: ReviewerDetailContext = {
      ...readyContextFixture(),
      permission: {
        actorUserId: "viewer",
        canReadQueue: true,
        canManageQueue: false,
        denialReasons: [],
      },
    };
    const root = renderInto(renderReviewerDetailView(context));
    const buttons = Array.from(root.querySelectorAll(".action-strip button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("renders kind-specific actions: QA / runtime / feedback expose request_repair", () => {
    expect(
      reviewerDetailViewInternals
        .actionButtonsForKind(reviewerQueueItemKindValues.qa)
        .map((b) => b.action),
    ).toContain(reviewerQueueActionValues.requestRepair);
    expect(
      reviewerDetailViewInternals
        .actionButtonsForKind(reviewerQueueItemKindValues.runtimeEvidence)
        .map((b) => b.action),
    ).toEqual(
      expect.arrayContaining([
        reviewerQueueActionValues.requestRepair,
        reviewerQueueActionValues.importRuntimeFeedback,
      ]),
    );
    expect(
      reviewerDetailViewInternals
        .actionButtonsForKind(reviewerQueueItemKindValues.glossary)
        .map((b) => b.action),
    ).toContain(reviewerQueueActionValues.updateGlossary);
    expect(
      reviewerDetailViewInternals
        .actionButtonsForKind(reviewerQueueItemKindValues.style)
        .map((b) => b.action),
    ).toContain(reviewerQueueActionValues.updateStyle);
  });
});

describe("renderReviewerDetailView — stale and missing context", () => {
  it("renders a diagnostic banner and per-panel missing-context blocks on a stale source revision", () => {
    const context = staleContextFixture();
    const root = renderInto(renderReviewerDetailView(context));

    expect(root.querySelector(".diagnostic-banner")).not.toBeNull();
    expect(
      root.querySelector(
        `[data-diagnostic-code="${reviewerDetailDiagnosticCodeValues.staleSourceRevision}"]`,
      ),
    ).not.toBeNull();
    expect(
      root.querySelector(
        `[data-diagnostic-code="${reviewerDetailDiagnosticCodeValues.missingDraft}"]`,
      ),
    ).not.toBeNull();
    expect(
      root.querySelector(
        `[data-diagnostic-code="${reviewerDetailDiagnosticCodeValues.missingPolicy}"]`,
      ),
    ).not.toBeNull();

    // Draft + policy panels render the missing-context block; they
    // never render an empty card.
    const draftPanel = root.querySelector('[data-panel-id="draft"]')!;
    expect(draftPanel.querySelector("[data-missing-context]")).not.toBeNull();
    const policyPanel = root.querySelector('[data-panel-id="policy"]')!;
    expect(policyPanel.querySelector("[data-missing-context]")).not.toBeNull();
  });

  it("never renders runtime evidence rows when the runtime evidence list is empty", () => {
    const context = staleContextFixture();
    const root = renderInto(renderReviewerDetailView(context));
    const panel = root.querySelector('[data-panel-id="runtime-evidence"]')!;
    expect(panel.querySelector("table")).toBeNull();
  });
});

describe("renderReviewerDetailView — comparison snapshot stability", () => {
  it("emits a deterministic comparison snapshot for source vs draft vs approved patch", () => {
    const context: ReviewerDetailContext = {
      ...readyContextFixture(),
      source: sourceUnitFixture({ sourceText: "源文" }),
      draft: draftFixture({ draftText: "Source draft", approvedPatchText: "Source patch" }),
    };
    const html = renderReviewerDetailView(context);
    expect(html).toContain("Source (ja-JP)");
    expect(html).toContain("Draft (en-US)");
    expect(html).toContain("Approved patch output");
    expect(html).toContain("源文");
    expect(html).toContain("Source draft");
    expect(html).toContain("Source patch");
  });
});

describe("renderReviewerDetailView — defensive escaping", () => {
  it("escapes hostile strings in source text, draft text, and ids", () => {
    const context: ReviewerDetailContext = {
      ...readyContextFixture(),
      reviewItemId: "<reviewer-queue-1>",
      source: sourceUnitFixture({ sourceText: "<script>alert(1)</script>" }),
      draft: draftFixture({ draftText: "<img onerror=alert(1)>" }),
    };
    const html = renderReviewerDetailView(context);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("readyContextFixture defaults", () => {
  it("carries every evidence row through the renderer in order", () => {
    const context = readyContextFixture();
    expect(context.runtimeEvidence.map((entry) => entry.evidenceKind)).toEqual([
      "text_trace",
      "screenshot_artifact",
      "benchmark_finding",
      "recording_artifact",
    ]);
    expect(context.item?.state).toBe(reviewerQueueItemStateValues.pending);
  });
});
