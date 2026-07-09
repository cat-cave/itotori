// shell-redaction-toggle — the GLOBAL redaction governor.
//
// A shell-level React context that governs ALL frame/screenshot rendering
// across the SPA. Per [[feedback_redaction_is_a_toggle]] the redaction rule
// is a TOGGLE, default-on for sensitive frames:
//   - DEFAULT-ON: a sensitive frame renders BLURRED;
//   - canReveal (the revealSensitive capability, CAP-GATED) unblurs a frame
//     for PRIVATE viewing only;
//   - shareRedaction (share/export mode) FORCES the blur back on regardless
//     of canReveal — an exported frame can never leak a sensitive
//     full-fidelity render.
//
// The governor is the single source of truth for the two booleans the ds
// `RedactionFrame` consumes (`canReveal` + `shareRedaction`). Frame
// renderers in the app read them through `useRedactionGovernor()` (or the
// `<RedactedFrame>` helper) and forward them to `<RedactionFrame>`; the ds
// component stays a PURE, framework-agnostic consumer of props (the rule
// lives in `shouldRedactFrame`).
//
// `revealSensitive` (the capability) is the cap gate. The downstream
// `fnd-caps-context` node will lift this onto a real caps context; until it
// lands, the shell (and tests) pass `revealSensitive` explicitly — the SAME
// pattern `ReviewerDetailScreen.canDecide` uses for the decide-action cap.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { RedactionFrame, type RedactionFrameProps } from "@itotori/ds";

export interface RedactionGovernorValue {
  /** Whether the viewer holds the revealSensitive capability (the cap gate). */
  revealSensitive: boolean;
  /**
   * Whether the viewer is authorized to reveal sensitive frames for PRIVATE
   * viewing. True ONLY when `revealSensitive` is held AND the toggle is ON
   * AND the shell is NOT in share/export mode. Forward straight to
   * `RedactionFrame.canReveal`.
   */
  canReveal: boolean;
  /**
   * Whether the shell is in share/export mode. FORCES redaction regardless
   * of `canReveal`. Forward straight to `RedactionFrame.shareRedaction`.
   */
  shareRedaction: boolean;
  /** Whether the private-reveal toggle is currently ON (viewer intent). */
  revealToggledOn: boolean;
  /** Flip the private-reveal toggle. Cap-gated no-op without revealSensitive. */
  toggleReveal: () => void;
  /** Enter/leave share/export mode (forces redaction while on). */
  setShareRedaction: (on: boolean) => void;
}

const RedactionGovernorContext = createContext<RedactionGovernorValue | null>(null);

export interface RedactionGovernorProps {
  /** Whether the viewer holds the revealSensitive capability. Default false. */
  revealSensitive?: boolean;
  /** Initial share/export mode. Default false. */
  defaultShareRedaction?: boolean;
  children: ReactNode;
}

export function RedactionGovernor({
  revealSensitive = false,
  defaultShareRedaction = false,
  children,
}: RedactionGovernorProps): ReactNode {
  const [revealToggledOn, setRevealToggledOn] = useState(false);
  const [shareRedaction, setShareRedaction] = useState(defaultShareRedaction);
  // canReveal is the AND of: cap held, toggle ON, NOT share mode.
  // shareRedaction ALWAYS wins — even with the cap + toggle on, an exported
  // frame stays redacted. This mirrors the pure rule in `shouldRedactFrame`
  // so the governor and the ds component can never disagree.
  const canReveal = revealSensitive && revealToggledOn && !shareRedaction;
  const toggleReveal = useCallback(() => {
    // Cap-gated: without revealSensitive the toggle is a no-op (the control
    // is disabled too, so this also guards against programmatic flips).
    if (!revealSensitive) {
      return;
    }
    setRevealToggledOn((on) => !on);
  }, [revealSensitive]);
  const value = useMemo<RedactionGovernorValue>(
    () => ({
      revealSensitive,
      canReveal,
      shareRedaction,
      revealToggledOn,
      toggleReveal,
      setShareRedaction,
    }),
    [revealSensitive, canReveal, shareRedaction, revealToggledOn, toggleReveal],
  );
  return (
    <RedactionGovernorContext.Provider value={value}>{children}</RedactionGovernorContext.Provider>
  );
}

export function useRedactionGovernor(): RedactionGovernorValue {
  const value = useContext(RedactionGovernorContext);
  if (value === null) {
    throw new Error("useRedactionGovernor must be used inside a <RedactionGovernor>");
  }
  return value;
}

export function RedactionGovernorBoundary({ children }: { children: ReactNode }): ReactNode {
  const value = useContext(RedactionGovernorContext);
  if (value !== null) {
    return children;
  }
  return <RedactionGovernor>{children}</RedactionGovernor>;
}

// ---------------------------------------------------------------------------
// RedactionToggle — the cap-gated shell control that flips the private reveal.
// DISABLED (not hidden) without the revealSensitive capability so an
// unauthorized viewer SEES the control is gated, not that it silently does
// nothing. Locked in share/export mode: shareRedaction forces redaction, so
// the private toggle has no effect there.
// ---------------------------------------------------------------------------

export function RedactionToggle(): ReactNode {
  const { revealSensitive, revealToggledOn, toggleReveal, shareRedaction } = useRedactionGovernor();
  const disabled = !revealSensitive || shareRedaction;
  return (
    <label
      className="itotori-redaction-toggle"
      data-redaction-toggle="reveal"
      data-reveal-capable={revealSensitive ? "true" : "false"}
      data-share-redaction={shareRedaction ? "true" : "false"}
      data-reveal-on={revealToggledOn ? "true" : "false"}
    >
      <input
        type="checkbox"
        checked={revealToggledOn}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label="Reveal sensitive frames"
        onChange={() => toggleReveal()}
      />
      <span className="itotori-redaction-toggle__copy">
        {shareRedaction
          ? "Redaction locked (share mode)"
          : revealSensitive
            ? "Reveal sensitive frames"
            : "Reveal sensitive frames (requires revealSensitive)"}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// RedactedFrame — the shell-level frame surface. Reads the governor and
// forwards `canReveal` + `shareRedaction` to the ds `<RedactionFrame>`. Any
// screen that drops a sensitive frame in renders under the governor for free;
// the ds component stays a pure consumer of props (no React context coupling).
// ---------------------------------------------------------------------------

export type RedactedFrameProps = Omit<RedactionFrameProps, "canReveal" | "shareRedaction">;

export function RedactedFrame({ children, ...rest }: RedactedFrameProps): ReactNode {
  const { canReveal, shareRedaction } = useRedactionGovernor();
  return (
    <RedactionFrame canReveal={canReveal} shareRedaction={shareRedaction} {...rest}>
      {children}
    </RedactionFrame>
  );
}
