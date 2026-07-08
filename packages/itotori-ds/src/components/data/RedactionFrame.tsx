import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface RedactionDecision {
  /** Whether the underlying frame is sensitive (adult / copyrighted / private). */
  sensitive: boolean;
  /**
   * Whether the viewer is AUTHORIZED to reveal the sensitive frame locally
   * (cap-gated, e.g. the owner with `revealSensitive`). Default false.
   */
  canReveal: boolean;
  /**
   * Whether the frame is being rendered in SHARE / EXPORT mode. Default false.
   * Share mode ALWAYS forces redaction — even with canReveal — so an exported
   * screenshot can never leak a sensitive full-fidelity frame.
   */
  shareRedaction: boolean;
}

const DEFAULT_DECISION: RedactionDecision = {
  sensitive: false,
  canReveal: false,
  shareRedaction: false,
};

/**
 * The pure redaction rule. A sensitive frame is redacted unless the viewer
 * has `canReveal` AND we are NOT in share/export mode. `shareRedaction`
 * ALWAYS wins — the brief ([[feedback_redaction_is_a_toggle]]) is explicit:
 * redaction is a TOGGLE default-on for committed/shared frames; cap-gated
 * reveal is the ONLY way to unblur locally, and even then share/export mode
 * forces the blur back on.
 *
 * Non-sensitive frames are never redacted (the toggle only governs sensitive
 * content).
 */
export function shouldRedactFrame(decision: Partial<RedactionDecision> = {}): boolean {
  const { sensitive, canReveal, shareRedaction } = { ...DEFAULT_DECISION, ...decision };
  if (!sensitive) return false;
  return !canReveal || shareRedaction;
}

export interface RedactionFrameProps {
  /** Whether the frame is sensitive. Default false. */
  sensitive?: boolean;
  /**
   * Whether the viewer has the cap-gated authority to reveal the sensitive
   * frame locally. Default false.
   */
  canReveal?: boolean;
  /**
   * Whether the frame is being rendered in share / export mode. Default false.
   * Forces redaction regardless of `canReveal`.
   */
  shareRedaction?: boolean;
  /** The frame content (img, video, render slot, anything). */
  children: ReactNode;
  /**
   * Label for the redaction overlay (the small pixel pill at the bottom). The
   * default reads "sensitive — redacted" in tracked-uppercase pixel; pass a
   * `ReactNode` to override (e.g. "share mode — always redacted").
   */
  label?: ReactNode;
  className?: string;
}

/**
 * RedactionFrame — the frame / screenshot surface with a redaction toggle.
 * A sensitive frame renders BLURRED by default (redaction overlay + scrim);
 * it is unblurred ONLY when `canReveal=true` AND `shareRedaction=false`;
 * `shareRedaction=true` forces the blur regardless of `canReveal`.
 *
 * Pure rule lives in {@link shouldRedactFrame} so the same logic is callable
 * by the shell-redaction-toggle node and any backend validator. The component
 * is the visual surface; the rule is the spec.
 *
 * Used by the Play surface (captured-frame filmstrip) and any sensitive
 * screenshot surface (Review, runtime evidence). The component does NOT wire
 * the toggle state — `shell-redaction-toggle` owns that; this component only
 * consumes the two boolean inputs and renders accordingly.
 */
export function RedactionFrame({
  sensitive = false,
  canReveal = false,
  shareRedaction = false,
  children,
  label = "sensitive — redacted",
  className,
}: RedactionFrameProps): ReactNode {
  const redacted = shouldRedactFrame({ sensitive, canReveal, shareRedaction });
  if (!redacted) {
    return (
      <div
        className={cx("itotori-redaction-frame", className)}
        data-redacted="false"
        data-share-redaction={shareRedaction ? "true" : "false"}
      >
        <div className="itotori-redaction-frame__media">{children}</div>
      </div>
    );
  }
  return (
    <div
      className={cx("itotori-redaction-frame", "itotori-redacted", className)}
      data-redacted="true"
      data-share-redaction={shareRedaction ? "true" : "false"}
    >
      <div className="itotori-redaction-frame__media">{children}</div>
      <div className="itotori-redaction-frame__overlay" aria-hidden="true" />
      <span className="itotori-redaction-frame__label">{label}</span>
    </div>
  );
}
