// Portfolio drill-down — the selected project's units / review / patch /
// validate detail, opened from a portfolio card or dense row.
//
// It reuses the polled `projects.list` row already on screen, so the drill-down
// advances on the SAME poll tick as the board behind it (no second read, no
// stale panel). Every destination is a route this SPA already serves.

import type { ReactNode } from "react";
import { Badge, StatReadout } from "@itotori/ds";
import type { ProjectPortfolioEntry } from "../../../api-schema.js";
import { formatMicrosUsd } from "../../format.js";
import { PortfolioRoleBars } from "./PortfolioRoleBars.js";
import {
  derivePortfolioDrilldown,
  type PortfolioDrilldownSection,
} from "./portfolio-drilldown-model.js";
import "./portfolio.css";

export function PortfolioDrilldown({
  project,
  onClose,
}: {
  project: ProjectPortfolioEntry;
  onClose: () => void;
}): ReactNode {
  const sections = derivePortfolioDrilldown(project);
  return (
    <section
      className="itotori-portfolio-drilldown"
      data-portfolio-drilldown={project.projectId}
      data-portfolio-drilldown-sections={sections.length}
      aria-label={`Drill-down for ${project.name}`}
    >
      <header className="itotori-portfolio-drilldown__header">
        <div className="itotori-portfolio-drilldown__identity">
          <h3 className="itotori-portfolio-drilldown__title">{project.name}</h3>
          <p className="itotori-portfolio-drilldown__meta">
            <span data-portfolio-engine={project.engineFamily ?? "unbound"}>
              {project.engineFamily ?? "engine unbound"}
            </span>
            <span aria-hidden="true"> · </span>
            <span>
              {project.sourceLocale} · {project.branchCount} branches
            </span>
          </p>
        </div>
        <div className="itotori-portfolio-drilldown__lamps">
          <Badge status={project.status}>{project.status}</Badge>
          <StatReadout
            label="Spend"
            value={formatMicrosUsd(project.progress.totalCostMicrosUsd)}
            mono
          />
        </div>
        <button
          type="button"
          className="itotori-portfolio-card__open"
          data-portfolio-drilldown-close={project.projectId}
          onClick={onClose}
        >
          Close
        </button>
      </header>

      <div className="itotori-portfolio-drilldown__grid">
        {sections.map((section) => (
          <PortfolioDrilldownPane key={section.key} section={section} project={project} />
        ))}
      </div>
    </section>
  );
}

function PortfolioDrilldownPane({
  section,
  project,
}: {
  section: PortfolioDrilldownSection;
  project: ProjectPortfolioEntry;
}): ReactNode {
  return (
    <article
      className="itotori-portfolio-drilldown__pane"
      data-portfolio-drilldown-section={section.key}
      data-portfolio-drilldown-links={section.links.length}
    >
      <h4 className="itotori-portfolio-drilldown__pane-title">{section.title}</h4>
      <p className="itotori-portfolio-drilldown__pane-summary">{section.summary}</p>
      <dl className="itotori-portfolio-drilldown__metrics">
        {section.metrics.map((metric) => (
          <div key={metric.key} data-portfolio-drilldown-metric={metric.key}>
            <dt>{metric.label}</dt>
            <dd className={metric.mono === true ? "itotori-portfolio-drilldown__mono" : undefined}>
              {metric.value}
            </dd>
          </div>
        ))}
      </dl>
      {section.key === "units" && (
        <PortfolioRoleBars roleCounts={project.progress.roleCounts} variant="detail" />
      )}
      {section.links.length > 0 ? (
        <ul className="itotori-portfolio-drilldown__links" aria-label={`${section.title} targets`}>
          {section.links.map((link) => (
            <li key={link.key}>
              <a href={link.href} data-portfolio-drilldown-link={section.key}>
                {link.label}
              </a>
              <span className="itotori-portfolio-drilldown__link-detail"> {link.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p
          className="itotori-portfolio-drilldown__note"
          data-portfolio-drilldown-note={section.key}
        >
          {section.emptyLinkNote}
        </p>
      )}
    </article>
  );
}
