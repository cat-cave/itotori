import { priorityRank, targetRank } from "./spec-dag-shared.mjs";

export function findCycles(nodes, ids) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();

  for (const node of nodes) {
    visit(node, []);
  }
  return cycles;

  function visit(node, path) {
    if (visited.has(node.id)) {
      return;
    }
    if (visiting.has(node.id)) {
      cycles.push([...path, node.id]);
      return;
    }
    visiting.add(node.id);
    for (const dependency of node.dependsOn ?? []) {
      const dependencyNode = ids.get(dependency);
      if (dependencyNode) {
        visit(dependencyNode, [...path, node.id]);
      }
    }
    visiting.delete(node.id);
    visited.add(node.id);
  }
}

export function readyNodes(value) {
  const ids = new Map(value.nodes.map((node) => [node.id, node]));
  return sortNodes(
    value.nodes.filter(
      (node) =>
        node.status === "planned" &&
        node.dependsOn.every((dependency) => ids.get(dependency)?.status === "complete"),
    ),
  );
}

export function sortNodes(nodes) {
  return [...nodes].sort((left, right) => {
    const byPriority = priorityRank[left.priority] - priorityRank[right.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    const byTarget = targetRank[left.target] - targetRank[right.target];
    if (byTarget !== 0) {
      return byTarget;
    }
    const byGroup = left.parallelGroup.localeCompare(right.parallelGroup);
    if (byGroup !== 0) {
      return byGroup;
    }
    return left.id.localeCompare(right.id);
  });
}
