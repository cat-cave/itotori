// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  PatchIterationPanel,
  type PatchIterationPanelProps,
} from "../src/ui/screens/PatchIterationPanel.js";

function panelProps(overrides: Partial<PatchIterationPanelProps> = {}): PatchIterationPanelProps {
  return {
    versions: [
      {
        patchVersionId: "patch-v1",
        parentPatchVersionId: null,
        status: "playable",
        scopeSummary: "Route A · 24 units",
        openHref: "/patches/patch-v1",
        artifactHref: "/patches/patch-v1/download",
      },
      {
        patchVersionId: "patch-v2",
        parentPatchVersionId: "patch-v1",
        status: "playable",
        scopeSummary: "Route A · 24 units",
        openHref: "/patches/patch-v2",
        artifactHref: "/patches/patch-v2/download",
      },
    ],
    activePatchVersionId: "patch-v2",
    baseScopeUnitIds: ["bridge-unit-v2-1", "bridge-unit-v2-2"],
    feedback: {
      eventCount: 3,
      individualEventCount: 1,
      batches: [
        {
          feedbackBatchId: "feedback-batch-1",
          status: "ready",
          eventCount: 2,
          selected: true,
          label: "Playtest notes",
          events: [
            {
              feedbackEventId: "feedback-batch-event-1",
              eventKind: "comment",
              summary: "The route note remains visible before refinement.",
            },
          ],
        },
      ],
      individualEvents: [
        {
          feedbackEventId: "feedback-event-1",
          feedbackBatchId: "feedback-individual-1",
          eventKind: "result_edit",
          summary: "The route needs one exact result revision.",
          selected: true,
        },
      ],
      selectedFeedbackEventIds: ["feedback-event-1"],
      selectedFeedbackBatchIds: ["feedback-batch-1"],
    },
    qaCallouts: [
      {
        id: "qa-low-confidence",
        contested: false,
        confidence: 0.36,
        note: "The character voice may not match this route's context.",
      },
      {
        id: "qa-contested",
        contested: true,
        confidence: 0.91,
        note: "Two QA passes disagree about terminology.",
      },
    ],
    onPlay: vi.fn(),
    onRefine: vi.fn(),
    ...overrides,
  };
}

describe("PatchIterationPanel", () => {
  it("selects durable feedback and optional scope/wiki inputs while keeping QA informational", () => {
    const props = panelProps();
    render(<PatchIterationPanel {...props} />);

    const panel = screen.getByRole("heading", { name: "Patch iteration" }).closest("section");
    expect(panel).not.toBeNull();
    const scoped = within(panel as HTMLElement);

    const lineage = scoped.getByRole("list", { name: "Patch version lineage" });
    expect(within(lineage).getAllByRole("listitem")).toHaveLength(2);
    const v2 = lineage.querySelector('[data-patch-version-id="patch-v2"]');
    expect(v2).toHaveAttribute("data-parent-patch-version-id", "patch-v1");
    expect(v2).toHaveAttribute("data-active", "true");
    expect(
      within(lineage).getAllByRole("link", { name: "Open patch artifact" })[0],
    ).toHaveAttribute("href", "/patches/patch-v1/download");

    const feedback = scoped.getByLabelText("Feedback batches");
    expect(feedback).toHaveTextContent("Playtest notes (2 events)");
    expect(feedback).toHaveTextContent("ready");
    expect(feedback).toHaveTextContent(
      "comment: The route note remains visible before refinement.",
    );
    expect(scoped.getByText(/3 events attached to this version/i)).toBeInTheDocument();
    const individual = scoped.getByLabelText("Individual feedback events");
    expect(individual).toHaveTextContent("result_edit: The route needs one exact result revision.");

    const callouts = scoped.getByLabelText("Informational QA callouts");
    expect(callouts).toHaveTextContent("low confidence");
    expect(callouts).toHaveTextContent("contested");
    expect(callouts.closest("section")).toHaveAttribute("data-gates-actions", "false");

    const play = scoped.getByRole("button", { name: "Play this patch" });
    const refine = scoped.getByRole("button", { name: "Refine selected feedback" });
    expect(play).toBeEnabled();
    expect(refine).toBeEnabled();

    fireEvent.click(play);
    fireEvent.click(scoped.getByLabelText("Select feedback batch Playtest notes"));
    fireEvent.click(scoped.getByText("Optional scope and wiki inputs"));
    fireEvent.change(scoped.getByLabelText("Additional bridge-unit IDs (comma-separated)"), {
      target: { value: "bridge-unit-v2-3" },
    });
    fireEvent.change(scoped.getByLabelText("Target bodies JSON (unit ID → target text)"), {
      target: { value: '{"bridge-unit-v2-3":"A newly broadened target."}' },
    });
    fireEvent.change(scoped.getByLabelText("Explicit wiki heads JSON (optional)"), {
      target: {
        value: '[{"contextArtifactId":"wiki-artifact-1","contextEntryVersionId":"wiki-version-1"}]',
      },
    });
    fireEvent.click(refine);
    expect(props.onPlay).toHaveBeenCalledWith("patch-v2");
    expect(props.onRefine).toHaveBeenCalledWith({
      basePatchVersionId: "patch-v2",
      feedbackEventIds: ["feedback-event-1"],
      feedbackBatchIds: [],
      scopeUnitIds: ["bridge-unit-v2-1", "bridge-unit-v2-2", "bridge-unit-v2-3"],
      targetBodiesByUnit: { "bridge-unit-v2-3": "A newly broadened target." },
      wikiHeads: [
        { contextArtifactId: "wiki-artifact-1", contextEntryVersionId: "wiki-version-1" },
      ],
    });
  });
});
