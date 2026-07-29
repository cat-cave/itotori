import type { AnyNode, Position } from "./dashboard-types.js";

export interface DashboardLayout {
  basePos: Record<string, Position>;
  colOf: Record<string, number>;
  height: number;
  width: number;
}

export function buildDashboardLayout(
  nodes: AnyNode[],
  byId: Record<string, AnyNode>,
  priorityRank: Record<string, number>,
  targetRank: Record<string, number>,
  required: <T>(value: T | undefined, label: string) => T,
): DashboardLayout {
  const nodeWidth = 150;
  const columnX = 212;
  const rowY = 30;
  const padding = 40;
  const depth: Record<string, number> = {};
  const colOf: Record<string, number> = {};
  const nodeFor = (id: string): AnyNode => required(byId[id], `node ${id}`);

  function dependencyDepth(id: string, seen: Record<string, number>): number {
    if (depth[id] !== undefined) return depth[id];
    if (seen[id]) return 0;
    seen[id] = 1;
    const node = byId[id];
    if (!node) return 0;
    const dependencies = (node.dependsOn || []).filter(function (dependency) {
      return byId[dependency];
    });
    const value = dependencies.length
      ? Math.max.apply(
          null,
          dependencies.map(function (dependency) {
            return dependencyDepth(dependency, seen);
          }),
        ) + 1
      : 0;
    depth[id] = value;
    return value;
  }

  nodes.forEach(function (node) {
    dependencyDepth(node.id, {});
    colOf[node.id] = required(depth[node.id], `depth ${node.id}`);
  });
  const columns: Record<number, string[]> = {};
  nodes.forEach(function (node) {
    const nodeDepth = required(depth[node.id], `depth ${node.id}`);
    (columns[nodeDepth] = columns[nodeDepth] || []).push(node.id);
  });
  const maxColumn = Math.max.apply(null, Object.keys(columns).map(Number));
  const row: Record<string, number> = {};
  for (let columnNumber = 0; columnNumber <= maxColumn; columnNumber++) {
    if (!columns[columnNumber]) continue;
    const column = required(columns[columnNumber], `column ${columnNumber}`);
    column.sort(function (a, b) {
      const left = nodeFor(a);
      const right = nodeFor(b);
      return (
        (priorityRank[left.priority] ?? 9) - (priorityRank[right.priority] ?? 9) ||
        (targetRank[left.target] ?? 9) - (targetRank[right.target] ?? 9) ||
        a.localeCompare(b)
      );
    });
    column.forEach(function (id, index) {
      row[id] = index;
    });
  }
  const breadthCenter: Record<string, number> = {};
  function sweep(useDependencies: boolean): void {
    for (let columnNumber = 0; columnNumber <= maxColumn; columnNumber++) {
      const column = columns[columnNumber];
      if (!column) continue;
      column.forEach(function (id) {
        const node = nodeFor(id);
        const neighbors = (useDependencies ? node.dependsOn || [] : node.dependents).filter(
          function (neighbor) {
            return byId[neighbor];
          },
        );
        breadthCenter[id] = neighbors.length
          ? neighbors.reduce(function (sum, neighbor) {
              return sum + required(row[neighbor], `row ${neighbor}`);
            }, 0) / neighbors.length
          : required(row[id], `row ${id}`);
      });
      column
        .slice()
        .sort(function (a, b) {
          return (breadthCenter[a] ?? 0) - (breadthCenter[b] ?? 0);
        })
        .forEach(function (id, index) {
          row[id] = index;
        });
      column.sort(function (a, b) {
        return required(row[a], `row ${a}`) - required(row[b], `row ${b}`);
      });
    }
  }
  for (let sweepNumber = 0; sweepNumber < 4; sweepNumber++) {
    sweep(true);
    sweep(false);
  }
  let maxRows = 0;
  for (let columnNumber = 0; columnNumber <= maxColumn; columnNumber++) {
    const column = columns[columnNumber];
    if (column) maxRows = Math.max(maxRows, column.length);
  }
  const basePos: Record<string, Position> = {};
  for (let columnNumber = 0; columnNumber <= maxColumn; columnNumber++) {
    const column = columns[columnNumber];
    if (!column) continue;
    const offset = (maxRows - column.length) / 2;
    column.forEach(function (id, index) {
      basePos[id] = { x: padding + columnNumber * columnX, y: padding + (offset + index) * rowY };
    });
  }
  return {
    basePos,
    colOf,
    height: padding * 2 + maxRows * rowY,
    width: padding * 2 + (maxColumn + 1) * columnX,
  };
}
