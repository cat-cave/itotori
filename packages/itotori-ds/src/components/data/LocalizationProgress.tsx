import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface LocalizationStage {
  /** Stage key (e.g. "translated", "qa", "revised", "proven"). */
  key: string;
  /** Human label (sentence case). */
  label: string;
  /** Unit count in this stage. */
  count: number;
  tone?: "amber" | "mint" | "cyan" | "sakura" | "neutral";
}

export interface LocalizationProgressProps {
  /** Total addressable units. */
  total: number;
  /** Stage breakouts; the segmented bar is drawn in order. */
  stages: ReadonlyArray<LocalizationStage>;
  /** Optional iteration cycle position. */
  cycle?: { current: number; of: number };
  /** Optional ETA string (already formatted; numbers exact + sourced). */
  eta?: ReactNode;
  className?: string;
}

/**
 * LocalizationProgress — the first-class localization instrument. A single
 * segmented bar over the stage breakouts (translated → qa → revised → proven),
 * plus the iteration cycle position and ETA. This is the cockpit's headline
 * metric, not a generic progress bar.
 */
export function LocalizationProgress({
  total,
  stages,
  cycle,
  eta,
  className,
}: LocalizationProgressProps): ReactNode {
  const safeTotal = total > 0 ? total : 1;
  const proven = stages.filter((s) => s.key === "proven").reduce((sum, s) => sum + s.count, 0);
  const provenPct = Math.round((proven / safeTotal) * 1000) / 10;
  return (
    <div className={cx("itotori-locprog", className)}>
      <div className="itotori-locprog__head">
        <div className="itotori-locprog__headline">
          <span className="itotori-locprog__proven">{provenPct}%</span>
          <span className="itotori-locprog__proven-label">proven</span>
        </div>
        <div className="itotori-locprog__meta">
          {cycle && (
            <span className="itotori-locprog__cycle">
              cycle <code>{cycle.current}</code>/<code>{cycle.of}</code>
            </span>
          )}
          {eta && <span className="itotori-locprog__eta">{eta}</span>}
        </div>
      </div>
      <div
        className="itotori-locprog__bar"
        role="img"
        aria-label={`${proven} of ${total} units proven`}
      >
        {stages.map((stage) => {
          const pct = (stage.count / safeTotal) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={stage.key}
              className={cx(
                "itotori-locprog__seg",
                `itotori-locprog__seg--${stage.tone ?? "neutral"}`,
              )}
              style={{ width: `${pct}%` }}
              data-stage={stage.key}
              title={`${stage.label}: ${stage.count}`}
            />
          );
        })}
      </div>
      <ul className="itotori-locprog__legend">
        {stages.map((stage) => (
          <li key={stage.key} className="itotori-locprog__legend-item">
            <span
              className={cx(
                "itotori-locprog__dot",
                `itotori-locprog__seg--${stage.tone ?? "neutral"}`,
              )}
              aria-hidden="true"
            />
            <span className="itotori-locprog__legend-label">{stage.label}</span>
            <code className="itotori-locprog__legend-count">{stage.count}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
