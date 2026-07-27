// Labeled stage-composition bar — the MIX of unit stages, deliberately a
// different quantity from the proven-progress fill it sits under.

import type { ReactNode } from "react";
import type { LocalizationStage } from "@itotori/ds";

/** Labeled composition bar — stage mix, not proven progress. */
export function StageMixBar({
  stages,
  total,
}: {
  stages: readonly LocalizationStage[];
  total: number;
}): ReactNode {
  const safeTotal = total > 0 ? total : 1;
  return (
    <div className="itotori-portfolio-stage-mix" data-portfolio-stage-mix="true">
      <span className="itotori-portfolio-stage-mix__label">Stage mix</span>
      <div
        className="itotori-portfolio-stage-mix__bar"
        role="img"
        aria-label="Unit stage composition"
      >
        {stages.map((stage) => {
          const pct = (stage.count / safeTotal) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={stage.key}
              className={`itotori-portfolio-stage-mix__seg itotori-portfolio-stage-mix__seg--${stage.tone ?? "neutral"}`}
              style={{ width: `${pct}%` }}
              data-stage={stage.key}
              title={`${stage.label}: ${stage.count}`}
            />
          );
        })}
      </div>
      <ul className="itotori-portfolio-stage-mix__legend">
        {stages.map((stage) => (
          <li key={stage.key} className="itotori-portfolio-stage-mix__legend-item">
            <span
              className={`itotori-portfolio-stage-mix__dot itotori-portfolio-stage-mix__seg--${stage.tone ?? "neutral"}`}
              aria-hidden="true"
            />
            <span>{stage.label}</span>
            <code className="itotori-portfolio-stage-mix__legend-count">{stage.count}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
