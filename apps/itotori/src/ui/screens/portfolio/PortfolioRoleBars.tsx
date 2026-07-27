// Per-role progress bars for one project's portfolio card / drill-down.
//
// Renders `progress.roleCounts` — one labelled composition bar per role, in
// volume order. Roles are opaque wire keys: nothing here knows the role
// vocabulary, and nothing here knows the engine.

import type { ReactNode } from "react";
import type { ProjectRunProgressStatusCounts } from "@itotori/db";
import { portfolioRoleRows, type PortfolioRoleRow } from "./portfolio-role-model.js";
import "./portfolio.css";

/**
 * Per-role composition bars. Renders nothing when the payload carries no role
 * records (never a fabricated zero row).
 */
export function PortfolioRoleBars({
  roleCounts,
  variant = "card",
}: {
  roleCounts: Readonly<Record<string, ProjectRunProgressStatusCounts>>;
  /** `card` = compact strip on a portfolio card; `detail` = drill-down block. */
  variant?: "card" | "detail";
}): ReactNode {
  const rows = portfolioRoleRows(roleCounts);
  if (rows.length === 0) {
    return null;
  }
  return (
    <div
      className="itotori-portfolio-roles"
      data-portfolio-roles={rows.length}
      data-portfolio-roles-variant={variant}
    >
      <span className="itotori-portfolio-roles__label">
        Roles <code className="itotori-portfolio-roles__count">{rows.length}</code>
      </span>
      <ul className="itotori-portfolio-roles__list" aria-label="Per-role unit progress">
        {rows.map((row) => (
          <PortfolioRoleBar key={row.role} row={row} />
        ))}
      </ul>
    </div>
  );
}

function PortfolioRoleBar({ row }: { row: PortfolioRoleRow }): ReactNode {
  return (
    <li
      className="itotori-portfolio-roles__row"
      data-portfolio-role={row.role}
      data-portfolio-role-total={row.total}
      data-portfolio-role-proven={row.provenPercent}
    >
      <span className="itotori-portfolio-roles__name">{row.role}</span>
      <div
        className="itotori-portfolio-roles__bar"
        role="img"
        aria-label={`${row.role}: ${row.proven} of ${row.total} unit-roles proven`}
      >
        {row.stages.map((stage) => {
          const pct = (stage.count / row.total) * 100;
          if (pct <= 0) {
            return null;
          }
          return (
            <div
              key={stage.key}
              className={`itotori-portfolio-stage-mix__seg itotori-portfolio-stage-mix__seg--${stage.tone ?? "neutral"}`}
              style={{ width: `${pct}%` }}
              data-stage={stage.key}
              title={`${row.role} ${stage.label}: ${stage.count}`}
            />
          );
        })}
      </div>
      <span className="itotori-portfolio-roles__counts">
        {row.proven}/{row.total}
      </span>
    </li>
  );
}
