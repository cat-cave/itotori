// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_SEVERITIES,
  AnnotationComposer,
} from "../src/components/game/AnnotationComposer.js";

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
