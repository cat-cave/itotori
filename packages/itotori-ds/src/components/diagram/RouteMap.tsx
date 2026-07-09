// RouteMap — the Play route/choice tree diagram.
//
// Renders nodes (routes/scenes) + edges (choices) with per-node localization
// coverage state. Uses diagram tokens (`--ito-diagram-*`); never raw color
// literals. Nodes carry col/row layout positions, a closed coverage vocabulary,
// and an optional issues count — the product surface owns the state; this
// component only paints it.

import type { ReactNode } from "react";
import { cx } from "../../cx.js";
import { Badge } from "../core/Badge.js";

/**
 * Coverage state painted on each node. Includes both the route-choice map
 * statuses (`fresh` / `stale`) and the play-mark-validated workflow states
 * (`needs_check` / `flagged` / `validated`) so one diagram component serves
 * both the read-model tree and the mark-validated surface.
 */
export type RouteMapCoverageState =
  | "fresh"
  | "stale"
  | "needs_check"
  | "flagged"
  | "validated";

export type RouteMapNode = {
  id: string;
  label: string;
  /** Column in the tree layout (0-based, left -> right). */
  col: number;
  /** Row in the tree layout (0-based, top -> bottom within a column). */
  row: number;
  /** Product status for the Badge (closed lowercase vocabulary). */
  state: string;
  /** Coverage state driving the node chrome + data-coverage attribute. */
  coverage: RouteMapCoverageState;
  /** Durable scene coverage when different from route freshness. */
  sceneCoverageState?: Extract<RouteMapCoverageState, "needs_check" | "flagged" | "validated">;
  /** Open issue count (e.g. stale citations); 0 when clean. */
  issues: number;
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
  /** Currently selected node id (active border). */
  activeId?: string | null;
  onSelect?: (nodeId: string) => void;
  className?: string;
  /** Accessible name for the diagram region. */
  label?: string;
  emptyLabel?: string;
};

/**
 * Map coverage state -> Badge status / tone. `validated` / `fresh` are mint
 * "ok"; `flagged` is coral "critical"; the rest are neutral.
 */
function coverageBadgeProps(coverage: RouteMapCoverageState): {
  status: string;
  tone: "neutral" | "ok" | "critical";
} {
  switch (coverage) {
    case "validated":
      return { status: "validated", tone: "ok" };
    case "fresh":
      return { status: "fresh", tone: "ok" };
    case "flagged":
      return { status: "flagged", tone: "critical" };
    case "stale":
      return { status: "stale", tone: "neutral" };
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
  emptyLabel = "No routes on this map yet.",
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

  // Group nodes by col so the tree paints left-to-right columns of routes.
  const maxCol = nodes.reduce((max, node) => Math.max(max, node.col), 0);
  const columns: RouteMapNode[][] = Array.from({ length: maxCol + 1 }, () => []);
  for (const node of [...nodes].sort((a, b) => a.row - b.row || a.id.localeCompare(b.id))) {
    const col = columns[node.col] ?? columns[0]!;
    col.push(node);
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
      <div className="itotori-route-map__grid" data-cols={maxCol + 1}>
        {columns.map((colNodes, colIndex) => (
          <ul
            key={`col-${colIndex}`}
            className="itotori-route-map__col"
            data-col={colIndex}
            aria-label={`Route column ${colIndex + 1}`}
          >
            {colNodes.map((node) => {
              const badge = coverageBadgeProps(node.coverage);
              const sceneBadge =
                node.sceneCoverageState !== undefined
                  ? coverageBadgeProps(node.sceneCoverageState)
                  : null;
              const isActive = activeId === node.id;
              const interactive = onSelect !== undefined;
              return (
                <li
                  key={node.id}
                  className="itotori-route-map__node-wrap"
                  data-col={node.col}
                  data-row={node.row}
                >
                  <button
                    type="button"
                    className={cx(
                      "itotori-route-map__node",
                      isActive && "itotori-route-map__node--active",
                      node.issues > 0 && "itotori-route-map__node--issues",
                    )}
                    data-route-id={node.id}
                    data-scene-id={node.id}
                    data-coverage={node.coverage}
                    data-scene-coverage={node.sceneCoverageState}
                    data-state={node.state}
                    data-issues={node.issues}
                    data-active={isActive ? "true" : "false"}
                    disabled={!interactive}
                    onClick={() => {
                      onSelect?.(node.id);
                    }}
                  >
                    <span className="itotori-route-map__node-label">{node.label}</span>
                    <Badge status={badge.status} tone={badge.tone}>
                      {node.coverage}
                    </Badge>
                    {sceneBadge !== null && node.sceneCoverageState !== undefined && (
                      <Badge status={sceneBadge.status} tone={sceneBadge.tone}>
                        {node.sceneCoverageState}
                      </Badge>
                    )}
                    {node.issues > 0 && (
                      <span
                        className="itotori-route-map__node-issues"
                        data-issues-count={node.issues}
                      >
                        {node.issues} issue{node.issues === 1 ? "" : "s"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
      </div>
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
                -&gt;
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
