// RouteMap — the Play route/choice tree diagram.
//
// Renders nodes (scenes) + edges (choices) with per-scene localization
// coverage state. Uses diagram tokens (`--ito-diagram-*`); never raw color
// literals. Coverage is a closed vocabulary (needs_check / flagged /
// validated) painted via Badge tones — the product surface owns the state,
// this component only paints it.

import type { ReactNode } from "react";
import { cx } from "../../cx.js";
import { Badge } from "../core/Badge.js";

export type RouteMapCoverageState = "needs_check" | "flagged" | "validated";

export type RouteMapNode = {
  id: string;
  label: string;
  coverageState: RouteMapCoverageState;
};

export type RouteMapEdge = {
  fromId: string;
  toId: string;
  label?: string;
  /** Stable key for list rendering. */
  key: string;
};

export type RouteMapProps = {
  nodes: readonly RouteMapNode[];
  edges?: readonly RouteMapEdge[];
  /** Currently selected scene id (active border). */
  activeId?: string | null;
  onSelect?: (nodeId: string) => void;
  className?: string;
  /** Accessible name for the diagram region. */
  label?: string;
  emptyLabel?: string;
};

/**
 * Map coverage state → Badge status / tone. `validated` is mint "ok";
 * `flagged` is coral "critical"; `needs_check` is neutral.
 */
function coverageBadgeProps(state: RouteMapCoverageState): {
  status: string;
  tone: "neutral" | "ok" | "critical";
} {
  switch (state) {
    case "validated":
      return { status: "validated", tone: "ok" };
    case "flagged":
      return { status: "flagged", tone: "critical" };
    default:
      return { status: "needs_check", tone: "neutral" };
  }
}

export function RouteMap({
  nodes,
  edges = [],
  activeId = null,
  onSelect,
  className,
  label = "Route map",
  emptyLabel = "No scenes on this route map yet.",
}: RouteMapProps): ReactNode {
  if (nodes.length === 0) {
    return (
      <div
        className={cx("itotori-route-map", "itotori-route-map--empty", className)}
        role="region"
        aria-label={label}
        data-component="route-map"
        data-empty="true"
      >
        <p className="itotori-route-map__empty">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div
      className={cx("itotori-route-map", className)}
      role="region"
      aria-label={label}
      data-component="route-map"
      data-node-count={nodes.length}
      data-edge-count={edges.length}
    >
      <ul className="itotori-route-map__nodes">
        {nodes.map((node) => {
          const badge = coverageBadgeProps(node.coverageState);
          const isActive = activeId === node.id;
          const interactive = onSelect !== undefined;
          return (
            <li key={node.id} className="itotori-route-map__node-wrap">
              <button
                type="button"
                className={cx(
                  "itotori-route-map__node",
                  isActive && "itotori-route-map__node--active",
                )}
                data-scene-id={node.id}
                data-coverage={node.coverageState}
                data-active={isActive ? "true" : "false"}
                disabled={!interactive}
                onClick={() => {
                  onSelect?.(node.id);
                }}
              >
                <span className="itotori-route-map__node-label">{node.label}</span>
                <Badge status={badge.status} tone={badge.tone}>
                  {node.coverageState}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
      {edges.length > 0 && (
        <ul className="itotori-route-map__edges" aria-label="Route choices">
          {edges.map((edge) => (
            <li
              key={edge.key}
              className="itotori-route-map__edge"
              data-from={edge.fromId}
              data-to={edge.toId}
            >
              <span className="itotori-route-map__edge-from">{edge.fromId}</span>
              <span className="itotori-route-map__edge-arrow" aria-hidden="true">
                →
              </span>
              <span className="itotori-route-map__edge-to">{edge.toId}</span>
              {edge.label !== undefined && edge.label.length > 0 && (
                <span className="itotori-route-map__edge-label">{edge.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
