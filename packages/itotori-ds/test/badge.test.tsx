import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../src/components/core/Badge.js";
import { STATUS_VOCABULARY, statusTone } from "../src/status.js";

describe("core / Badge", () => {
  it("renders the status string as its label by default", () => {
    render(<Badge status="proven" />);
    expect(screen.getByText("proven")).toBeInTheDocument();
  });

  it("derives the tone from the status (mint/ok for evidence states)", () => {
    render(<Badge status="proven" />);
    const badge = screen.getByText("proven");
    expect(badge).toHaveAttribute("data-tone", "ok");
    expect(badge).toHaveClass("itotori-badge--ok");
  });

  it("derives critical tone for failure/rejection/blocker states", () => {
    render(<Badge status="failed" />);
    expect(screen.getByText("failed")).toHaveAttribute("data-tone", "critical");
  });

  it("keeps unknown/neutral statuses neutral", () => {
    render(<Badge status="pending" />);
    expect(screen.getByText("pending")).toHaveAttribute("data-tone", "neutral");
  });

  it("maps every status in the closed vocabulary to a valid tone", () => {
    for (const status of STATUS_VOCABULARY) {
      expect(["neutral", "ok", "critical"]).toContain(statusTone(status));
    }
  });

  it("supports explicit privacy posture tone without changing status derivation", () => {
    render(
      <Badge status="zdr" tone="privacy">
        zdr=true
      </Badge>,
    );
    const badge = screen.getByText("zdr=true");
    expect(badge).toHaveAttribute("data-tone", "privacy");
    expect(badge).toHaveClass("itotori-badge--privacy");
    expect(statusTone("zdr")).toBe("neutral");
  });
});
