// @vitest-environment jsdom
// shell-redaction-toggle — behavior-first test for the GLOBAL redaction
// governor (spec/shell-redact).
//
// Mounts the REAL `RedactionGovernor` + the shell `RedactionToggle` control
// + the shell `RedactedFrame` surface (which forwards the governor's
// `canReveal` + `shareRedaction` to the ds `RedactionFrame`) and asserts the
// OBSERVABLE rendered behavior a viewer sees, per [[feedback_redaction_is_a_toggle]]:
//
//   1. DEFAULT-ON: a sensitive frame renders BLURRED with no reveal;
//   2. canReveal (the revealSensitive capability, cap-gated) UNBLURS the
//      frame for private viewing when the toggle is flipped on;
//   3. shareRedaction (share/export mode) FORCES the blur back on EVEN WITH
//      canReveal — an exported frame can never leak a sensitive frame;
//   4. the reveal toggle is CAP-GATED — disabled without the revealSensitive
//      capability, and flipping it then is a no-op.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered redaction state of the frame + the toggle's cap-gate are
// asserted. The pure rule (`shouldRedactFrame`) is covered independently in
// the ds test; this asserts the shell governor wires it correctly.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  RedactionGovernor,
  RedactedFrame,
  RedactionToggle,
  useRedactionGovernor,
} from "../src/ui/redaction-governor.js";

function frame(): Element | null {
  return document.querySelector(".itotori-redaction-frame");
}

// A tiny harness that exposes the governor's share/export setter to the DOM
// so a test can flip share mode at runtime (the way a real share/export
// action would) and watch the frame re-blur.
function ShareModeLatch(): JSX.Element {
  const { setShareRedaction, shareRedaction } = useRedactionGovernor();
  return (
    <button
      type="button"
      data-share-latch="true"
      data-share-on={shareRedaction ? "true" : "false"}
      onClick={() => setShareRedaction(!shareRedaction)}
    >
      Toggle share mode
    </button>
  );
}

function mount({
  revealSensitive,
  defaultShareRedaction,
}: {
  revealSensitive?: boolean;
  defaultShareRedaction?: boolean;
} = {}): {
  toggle: () => void;
  flipShare: () => void;
} {
  render(
    <RedactionGovernor
      revealSensitive={revealSensitive}
      defaultShareRedaction={defaultShareRedaction}
    >
      <RedactionToggle />
      <ShareModeLatch />
      <RedactedFrame sensitive>
        <img alt="a sensitive scene" />
      </RedactedFrame>
    </RedactionGovernor>,
  );
  return {
    toggle: () => fireEvent.click(screen.getByRole("checkbox", { name: /reveal sensitive/i })),
    flipShare: () => fireEvent.click(screen.getByRole("button", { name: /toggle share mode/i })),
  };
}

describe("shell-redaction-toggle / RedactionGovernor", () => {
  it("is DEFAULT-ON: a sensitive frame renders BLURRED with no reveal", () => {
    mount();
    expect(frame()).toHaveAttribute("data-redacted", "true");
    expect(frame()).toHaveClass("itotori-redacted");
  });

  it("canReveal (revealSensitive + toggle on) UNBLURS the sensitive frame for private viewing", () => {
    const { toggle } = mount({ revealSensitive: true });
    expect(frame()).toHaveAttribute("data-redacted", "true");
    toggle();
    expect(frame()).toHaveAttribute("data-redacted", "false");
    expect(frame()).not.toHaveClass("itotori-redacted");
  });

  it("shareRedaction FORCES the blur even when canReveal is true", () => {
    const { toggle, flipShare } = mount({ revealSensitive: true });
    // Reveal the frame for private viewing first.
    toggle();
    expect(frame()).toHaveAttribute("data-redacted", "false");
    // Enter share/export mode — the frame re-blurrs, even though the cap +
    // toggle are still on.
    flipShare();
    expect(frame()).toHaveAttribute("data-redacted", "true");
    expect(frame()).toHaveClass("itotori-redacted");
    // Leaving share mode re-reveals it (the private reveal is preserved).
    flipShare();
    expect(frame()).toHaveAttribute("data-redacted", "false");
  });

  it("the reveal toggle is CAP-GATED: disabled without revealSensitive, and flipping it is a no-op", () => {
    const { toggle } = mount({ revealSensitive: false });
    const checkbox = screen.getByRole("checkbox", { name: /reveal sensitive/i });
    expect(checkbox).toBeDisabled();
    // Flipping a disabled control is a no-op; the frame stays blurred.
    expect(() => toggle()).not.toThrow();
    expect(frame()).toHaveAttribute("data-redacted", "true");
    // The toggle exposes its cap-gate for downstream styling/audit.
    expect(document.querySelector('[data-redaction-toggle="reveal"]')).toHaveAttribute(
      "data-reveal-capable",
      "false",
    );
  });

  afterEach(() => {
    cleanup();
  });
});
