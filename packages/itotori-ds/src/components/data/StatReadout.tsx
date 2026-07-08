import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface StatReadoutProps {
  /** Pixel-label caption for the metric. */
  label: ReactNode;
  /** The value, already formatted (numbers exact + sourced). */
  value: ReactNode;
  /** Optional unit / suffix (e.g. "USD", "units"). */
  unit?: ReactNode;
  /** Optional sourced delta, e.g. "+0.15". */
  delta?: ReactNode;
  deltaTone?: "ok" | "critical" | "neutral";
  /** Optional sparkline series (drawn as an inline SVG polyline). */
  series?: ReadonlyArray<number>;
  /** Render the value in mono (for machine tokens / micros-USD). */
  mono?: boolean;
  className?: string;
}

const SPARK_W = 72;
const SPARK_H = 20;

function sparkPoints(series: ReadonlyArray<number>): string {
  if (series.length === 0) return "";
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = series.length > 1 ? SPARK_W / (series.length - 1) : 0;
  return series
    .map((v, i) => {
      const x = Math.round(i * step * 10) / 10;
      const y = Math.round((SPARK_H - ((v - min) / span) * SPARK_H) * 10) / 10;
      return `${x},${y}`;
    })
    .join(" ");
}

/**
 * StatReadout — a single metric with an optional sparkline. The evidence-dense
 * primitive for the cockpit's number rows: exact value, sourced delta, trend.
 */
export function StatReadout({
  label,
  value,
  unit,
  delta,
  deltaTone = "neutral",
  series,
  mono = false,
  className,
}: StatReadoutProps): ReactNode {
  return (
    <div className={cx("itotori-stat", className)}>
      <div className="itotori-stat__label">{label}</div>
      <div className="itotori-stat__row">
        <span className={cx("itotori-stat__value", mono && "itotori-stat__value--mono")}>
          {value}
          {unit && <span className="itotori-stat__unit"> {unit}</span>}
        </span>
        {delta != null && (
          <span className={cx("itotori-stat__delta", `itotori-stat__delta--${deltaTone}`)}>
            {delta}
          </span>
        )}
      </div>
      {series && series.length > 0 && (
        <svg
          className="itotori-stat__spark"
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          width={SPARK_W}
          height={SPARK_H}
          role="img"
          aria-label="trend"
          preserveAspectRatio="none"
        >
          <polyline points={sparkPoints(series)} fill="none" strokeWidth="1.5" />
        </svg>
      )}
    </div>
  );
}
