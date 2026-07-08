import type { ReactNode } from "react";
import { cx } from "../../cx.js";
import { statusTone } from "../../status.js";

export interface BadgeProps {
  /**
   * The status string. Tone is auto-derived from it (the closed status
   * vocabulary → three tones), so callers pass the product status verbatim.
   */
  status: string;
  /** Override the auto-derived tone in the rare case a status needs it. */
  tone?: "neutral" | "ok" | "critical";
  /** Optional label; defaults to the (lowercase) status string itself. */
  children?: ReactNode;
  className?: string;
}

/**
 * Badge — the status pill. Tone (neutral / ok-mint / critical-coral) is derived
 * from the status string; the label is rendered as a tracked-uppercase pixel
 * label but the underlying value stays the lowercase status token.
 */
export function Badge({ status, tone, children, className }: BadgeProps): ReactNode {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      className={cx("itotori-badge", `itotori-badge--${resolved}`, className)}
      data-status={status}
      data-tone={resolved}
    >
      {children ?? status}
    </span>
  );
}
