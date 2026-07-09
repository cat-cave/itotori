// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_SEVERITIES,
  AnnotationComposer,
} from "../src/components/game/AnnotationComposer.js";
import { ScenePlayer } from "../src/components/game/ScenePlayer.js";

describe("game / AnnotationComposer", () => {
  it("exposes the closed severity ramp as selectable chips", () => {
    render(<AnnotationComposer onSubmit={vi.fn()} />);
    for (const severity of ANNOTATION_SEVERITIES) {
      expect(screen.getByRole("radio", { name: severity })).toBeInTheDocument();
    }
    const form = document.querySelector('[data-component="annotation-composer"]');
    expect(form?.getAttribute("data-severity")).toBe("warning");
  });

  it("submits note + severity + category", async () => {
    const onSubmit = vi.fn();
    render(<AnnotationComposer onSubmit={onSubmit} defaultCategory="tone" />);
    await userEvent.click(screen.getByRole("radio", { name: "critical" }));
    await userEvent.type(screen.getByPlaceholderText(/What's wrong/i), "Line overflows.");
    await userEvent.click(screen.getByRole("button", { name: /Send to review/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      note: "Line overflows.",
      severity: "critical",
      category: "tone",
    });
  });

  it("disables submit when capability is denied", async () => {
    const onSubmit = vi.fn();
    render(
      <AnnotationComposer onSubmit={onSubmit} disabled disabledReason="missing feedback.import" />,
    );
    const submit = screen.getByRole("button", { name: /Send to review/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/What's wrong/i), "should not send");
    // Disabled form controls still accept type in some a11y paths; the submit
    // gate is the durable refusal.
    expect(submit).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses an empty note", async () => {
    const onSubmit = vi.fn();
    render(<AnnotationComposer onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: /Send to review/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("game / ScenePlayer", () => {
  it("renders the game-agnostic player chrome with status and BiText", () => {
    render(
      <ScenePlayer
        unitId="bridge-unit:scene-07-line-014"
        mode="review"
        status="captured"
        sourceLocale="ja-JP"
        targetLocale="en-US"
        sourceText="原文"
        translationText="Draft line"
        speaker="speaker:main"
      />,
    );
    expect(screen.getByRole("region", { name: "Scene player" })).toHaveAttribute(
      "data-mode",
      "review",
    );
    expect(screen.getByText("bridge-unit:scene-07-line-014")).toBeInTheDocument();
    expect(screen.getByText("captured")).toBeInTheDocument();
    expect(screen.getByText("原文")).toBeInTheDocument();
    expect(screen.getByText("Draft line")).toBeInTheDocument();
  });

  it("exposes previous and next controls without inventing behavior", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(<ScenePlayer unitId="unit:1" onPrevious={onPrevious} onNext={onNext} />);
    await userEvent.click(screen.getByRole("button", { name: "Previous scene" }));
    await userEvent.click(screen.getByRole("button", { name: "Next scene" }));
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("keeps controls disabled when the host has no navigation handler", () => {
    render(<ScenePlayer unitId="unit:1" />);
    expect(screen.getByRole("button", { name: "Previous scene" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next scene" })).toBeDisabled();
  });
});
