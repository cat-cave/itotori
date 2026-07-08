import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface ProgressBarProps {
  /** Completed value. */
  value: number;
  /** Total; defaults to 100 (value read as a percentage). */
  max?: number;
  /** Tone of the fill (default mint — the evidence signal). */
  tone?: "mint" | "amber" | "cyan";
  /** Indeterminate/running work (animated stripe). */
  running?: boolean;
  /** Accessible label. */
  label?: string;
  /** Show a trailing "value / max" readout. */
  showValue?: boolean;
  className?: string;
}

/**
 * ProgressBar — a determinate fill (mint = the evidence signal) or an
 * indeterminate running stripe. The fill is the base primitive that
 * LocalizationProgress composes into a first-class localization instrument.
 */
export function ProgressBar({
  value,
  max = 100,
  tone = "mint",
  running = false,
  label,
  showValue = false,
  className,
}: ProgressBarProps): ReactNode {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.max(0, Math.min(value, safeMax));
  const pct = Math.round((clamped / safeMax) * 1000) / 10;
  return (
    <div className={cx("itotori-progress", className)}>
      <div
        className="itotori-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={running ? undefined : clamped}
        aria-valuemin={0}
        aria-valuemax={safeMax}
      >
        <div
          className={cx(
            "itotori-progress__fill",
            `itotori-progress__fill--${tone}`,
            running && "itotori-stripes-run",
          )}
          style={{ width: running ? "100%" : `${pct}%` }}
        />
      </div>
      {showValue && (
        <span className="itotori-progress__value">
          {clamped}
          <span className="itotori-progress__value-sep"> / </span>
          {safeMax}
        </span>
      )}
    </div>
  );
}
