import type { AnyNode, DashboardState } from "./dashboard-types.js";

export function filterSet(state: DashboardState, facet: string): Set<string> {
  if (facet === "status" || facet === "priority" || facet === "target") return state[facet];
  if (facet === "projects") return state.project;
  if (facet === "parallelGroup") return state.group;
  throw new Error(`dashboard filter ${facet} is unknown`);
}

export function uniqueNodeValues(nodes: AnyNode[], key: string): Record<string, number> {
  const values: Record<string, number> = {};
  nodes.forEach(function (node) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach(function (entry) {
        const stringEntry = String(entry);
        values[stringEntry] = (values[stringEntry] || 0) + 1;
      });
    } else {
      const stringValue = String(value);
      values[stringValue] = (values[stringValue] || 0) + 1;
    }
  });
  return values;
}

export function hasActiveFilter(state: DashboardState): boolean {
  return !!(
    state.q ||
    state.status.size ||
    state.priority.size ||
    state.target.size ||
    state.project.size ||
    state.group.size ||
    state.readyOnly ||
    state.issuesOnly
  );
}

export function nodePassesFilters(state: DashboardState, node: AnyNode): boolean {
  if (state.readyOnly && !node.ready) return false;
  if (state.issuesOnly && !node.issues.length) return false;
  if (state.status.size && !state.status.has(node.status)) return false;
  if (state.priority.size && !state.priority.has(node.priority)) return false;
  if (state.target.size && !state.target.has(node.target)) return false;
  if (state.group.size && !state.group.has(node.parallelGroup)) return false;
  if (
    state.project.size &&
    !(node.projects || []).some(function (project) {
      return state.project.has(project);
    })
  )
    return false;
  if (state.q) {
    const haystack = (
      node.id +
      " " +
      node.title +
      " " +
      (node.summary || "") +
      " " +
      (node.deliverables || []).join(" ") +
      " " +
      (node.acceptanceCriteria || []).join(" ")
    ).toLowerCase();
    if (haystack.indexOf(state.q) < 0) return false;
  }
  return true;
}

export function renderNodeList(input: {
  anyFilter: () => boolean;
  esc: (value: unknown) => string;
  getLineage: () => Set<string>;
  nodePasses: (node: AnyNode) => boolean;
  nodes: AnyNode[];
  priorityRank: Record<string, number>;
  select: (id: string) => void;
  state: DashboardState;
  statusColor: (node: AnyNode) => string;
  statusLabel: (node: AnyNode) => string;
  targetRank: Record<string, number>;
  el: (id: string) => HTMLElement;
}): void {
  const matching = input.nodes.filter(input.nodePasses);
  const rows = (input.state.sel ? input.nodes : matching).slice().sort(function (left, right) {
    if (input.state.sort === "id") return left.id.localeCompare(right.id);
    if (input.state.sort === "deps")
      return right.dependents.length - left.dependents.length || left.id.localeCompare(right.id);
    if (input.state.sort === "blocked")
      return right.blockedBy.length - left.blockedBy.length || left.id.localeCompare(right.id);
    if (input.state.sort === "status")
      return (
        String(left.status).localeCompare(String(right.status)) || left.id.localeCompare(right.id)
      );
    return (
      (input.priorityRank[left.priority] ?? 9) - (input.priorityRank[right.priority] ?? 9) ||
      (input.targetRank[left.target] ?? 9) - (input.targetRank[right.target] ?? 9) ||
      String(left.parallelGroup).localeCompare(String(right.parallelGroup)) ||
      left.id.localeCompare(right.id)
    );
  });
  input.el("lh_count").textContent = matching.length + " / " + input.nodes.length;
  if (!rows.length) {
    input.el("rows").innerHTML = '<div class="empty">No nodes match.</div>';
    return;
  }
  const lineage = input.state.sel ? input.getLineage() : null;
  input.el("rows").innerHTML = rows
    .map(function (node) {
      const selected = node.id === input.state.sel ? " sel" : "";
      const dimmed = (
        input.state.sel ? !lineage?.has(node.id) : input.anyFilter() && !input.nodePasses(node)
      )
        ? " dim"
        : "";
      return (
        '<div class="row' +
        selected +
        dimmed +
        '" data-id="' +
        input.esc(node.id) +
        '"><span class="id">' +
        input.esc(node.id) +
        "</span>" +
        '<span class="pr ' +
        node.priority +
        '">' +
        node.priority +
        "</span>" +
        '<span class="sdot" title="' +
        input.statusLabel(node) +
        '" style="background:' +
        input.statusColor(node) +
        '"></span>' +
        '<span class="tt">' +
        input.esc(node.title) +
        "</span>" +
        (node.issues.length ? '<span class="warn">⚠</span>' : "") +
        "</div>"
      );
    })
    .join("");
  input
    .el("rows")
    .querySelectorAll<HTMLElement>(".row")
    .forEach(function (row) {
      const id = row.dataset.id;
      if (id === undefined) throw new Error("dashboard list row has no node id");
      row.onclick = function () {
        input.select(id);
      };
    });
}
