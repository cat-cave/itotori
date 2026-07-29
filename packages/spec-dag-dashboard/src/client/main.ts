import { createDetailController } from "./dashboard-details.js";
import {
  filterSet,
  hasActiveFilter,
  nodePassesFilters,
  renderNodeList,
  uniqueNodeValues,
} from "./dashboard-filters.js";
import { createGraphController } from "./dashboard-graph.js";
import { buildDashboardLayout } from "./dashboard-layout.js";
import type { AnyNode, DashboardState } from "./dashboard-types.js";
import { provenanceBannerClassName } from "../provenance-status.js";
import type { DashboardData, Provenance } from "./client-types.js";

declare const DATA: DashboardData;

(function (): void {
  const nodes = DATA.nodes as AnyNode[];
  const byId: Record<string, AnyNode> = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const priorityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const targetRank: Record<string, number> = { baseline: 0, alpha: 1, continuous: 2 };
  const statusColors: Record<string, string> = {
    complete: "#3ee08f",
    in_progress: "#b89bff",
    planned: "#7782b0",
    blocked: "#ff5d73",
    cancelled: "#6b7088",
  };
  const priorityColors: Record<string, string> = {
    P0: "#ff5d73",
    P1: "#ffa53d",
    P2: "#5fb2ff",
    P3: "#9aa0c4",
  };
  const state: DashboardState = {
    q: "",
    status: new Set<string>(),
    priority: new Set<string>(),
    target: new Set<string>(),
    project: new Set<string>(),
    group: new Set<string>(),
    issuesOnly: false,
    readyOnly: false,
    sort: "rank",
    sel: null,
  };
  function statusColor(node: AnyNode): string {
    return node.ready ? "#ffc24a" : statusColors[node.status] || "#7782b0";
  }
  function statusLabel(node: AnyNode): string {
    return node.ready ? "ready" : node.status;
  }
  function esc(value: unknown): string {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function el(id: string): HTMLElement;
  function el<T extends Element>(id: string, expected: abstract new () => T): T;
  function el(id: string, expected?: abstract new () => Element): Element {
    const element = document.getElementById(id);
    if (element === null || !(element instanceof (expected ?? HTMLElement)))
      throw new Error(`dashboard template element ${id} is missing or has the wrong type`);
    return element;
  }
  function required<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`dashboard ${label} is missing`);
    return value;
  }
  function nodeFor(id: string): AnyNode {
    return required(byId[id], `node ${id}`);
  }
  function ancestors(id: string): Set<string> {
    const found = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined) continue;
      (nodeFor(current).dependsOn || []).forEach(function (dependency) {
        if (byId[dependency] && !found.has(dependency)) {
          found.add(dependency);
          stack.push(dependency);
        }
      });
    }
    return found;
  }
  function descendants(id: string): Set<string> {
    const found = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined) continue;
      nodeFor(current).dependents.forEach(function (dependent) {
        if (byId[dependent] && !found.has(dependent)) {
          found.add(dependent);
          stack.push(dependent);
        }
      });
    }
    return found;
  }
  let selectedAncestors: Set<string> | null = null;
  let selectedDescendants: Set<string> | null = null;
  function lineageSet(): Set<string> {
    if (state.sel === null || selectedAncestors === null || selectedDescendants === null)
      return new Set<string>();
    return new Set<string>([state.sel, ...selectedAncestors, ...selectedDescendants]);
  }
  const layout = buildDashboardLayout(nodes, byId, priorityRank, targetRank, required);
  let openDetail: (node: AnyNode) => void = function () {
    throw new Error("dashboard details are not initialized");
  };
  let openIssues: () => void = function () {
    throw new Error("dashboard details are not initialized");
  };
  let movedIds: Record<string, number> = {};
  const graph = createGraphController({
    anyFilter: function () {
      return hasActiveFilter(state);
    },
    basePos: layout.basePos,
    byId,
    colOf: layout.colOf,
    el,
    esc,
    getLineage: lineageSet,
    getSelectedAncestors: function () {
      return selectedAncestors;
    },
    getSelectedDescendants: function () {
      return selectedDescendants;
    },
    height: layout.height,
    nodePasses: function (node) {
      return nodePassesFilters(state, node);
    },
    nodes,
    required,
    select,
    state,
    statusColor,
    statusLabel,
    unfocus,
    width: layout.width,
  });
  const details = createDetailController({
    byId,
    data: DATA,
    el,
    esc,
    getLineageCounts: function () {
      return {
        ancestors: selectedAncestors?.size || 0,
        descendants: selectedDescendants?.size || 0,
      };
    },
    nodes,
    select,
    statusColor,
    statusLabel,
  });
  openDetail = details.openDetail;
  openIssues = details.openIssues;
  function renderList(): void {
    renderNodeList({
      anyFilter: function () {
        return hasActiveFilter(state);
      },
      el,
      esc,
      getLineage: lineageSet,
      nodePasses: function (node) {
        return nodePassesFilters(state, node);
      },
      nodes,
      priorityRank,
      select,
      state,
      statusColor,
      statusLabel,
      targetRank,
    });
  }
  function select(id: string): void {
    const node = byId[id];
    if (!node) return;
    state.sel = id;
    selectedAncestors = ancestors(id);
    selectedDescendants = descendants(id);
    el("ghint").style.opacity = "0";
    const lineage = lineageSet();
    graph.bringToFront(lineage);
    const targets = graph.compactTargets(lineage);
    Object.keys(movedIds).forEach(function (movedId) {
      if (!targets[movedId])
        targets[movedId] = required(layout.basePos[movedId], `position ${movedId}`);
    });
    movedIds = {};
    Object.keys(targets).forEach(function (id) {
      if (
        required(targets[id], `target ${id}`).y !== required(layout.basePos[id], `position ${id}`).y
      )
        movedIds[id] = 1;
    });
    graph.style();
    renderList();
    openDetail(node);
    graph.animateNodes(targets, 360);
    graph.frameIds(Array.from(lineage), targets, 460);
  }
  function unfocus(silent?: boolean): void {
    if (!state.sel) {
      if (!silent) graph.fit(420);
      return;
    }
    const targets: Record<string, { x: number; y: number }> = {};
    Object.keys(movedIds).forEach(function (id) {
      targets[id] = required(layout.basePos[id], `position ${id}`);
    });
    movedIds = {};
    state.sel = null;
    selectedAncestors = null;
    selectedDescendants = null;
    el("detail").classList.remove("open");
    el("ghint").style.opacity = "1";
    graph.animateNodes(targets, 320);
    graph.style();
    renderList();
    if (!silent) graph.fit(440);
  }
  function apply(reframe: boolean): void {
    if (state.sel) unfocus(true);
    renderList();
    graph.style();
    if (!reframe) return;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(function () {
      const matchingIds = nodes
        .filter(function (node) {
          return nodePassesFilters(state, node);
        })
        .map(function (node) {
          return node.id;
        });
      if (hasActiveFilter(state)) graph.frameIds(matchingIds, layout.basePos, 460);
      else graph.fit(460);
    }, 240);
  }
  let frameTimer: ReturnType<typeof setTimeout>;
  function relativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (isNaN(then)) return "unknown time";
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }
  function renderProvenance(): void {
    const banner = el("provbanner");
    const provenance: Provenance = DATA.provenance;
    const sha = provenance.headShortSha || "unknown";
    const when = relativeTime(provenance.generatedAt);
    const behind = (provenance.commitsBehind || 0) > 0;
    banner.className = provenanceBannerClassName(provenance);
    if (!provenance.originMainKnown) {
      banner.textContent =
        "⚠ " +
        sha +
        " · generated " +
        when +
        " — staleness unverifiable: origin/main unknown locally — run git fetch";
      return;
    }
    if (behind || provenance.dirty) {
      const messages: string[] = [];
      if (behind)
        messages.push(
          "⚠ " +
            provenance.commitsBehind +
            " commit" +
            (provenance.commitsBehind === 1 ? "" : "s") +
            " behind origin/main (as of last fetch)",
        );
      if (provenance.dirty) messages.push("⚠ working tree dirty");
      messages.push("re-run: just dev roadmap-dashboard");
      banner.textContent = sha + " · " + messages.join(" — ");
      return;
    }
    banner.textContent = "✓ " + sha + " · generated " + when;
  }
  function pillset(
    host: HTMLElement,
    key: string,
    order: Record<string, number> | null,
    colors: Record<string, string> | null,
  ): void {
    const counts = uniqueNodeValues(nodes, key);
    const keys = Object.keys(counts);
    if (order)
      keys.sort(function (a, b) {
        return (order[a] ?? 9) - (order[b] ?? 9);
      });
    else keys.sort();
    host.innerHTML = keys
      .map(function (keyValue) {
        const swatch =
          colors && colors[keyValue]
            ? '<span class="sw" style="background:' + colors[keyValue] + '"></span>'
            : "";
        return (
          '<span class="pl" data-facet="' +
          key +
          '" data-v="' +
          esc(keyValue) +
          '">' +
          swatch +
          esc(keyValue) +
          "</span>"
        );
      })
      .join("");
    host.querySelectorAll<HTMLElement>(".pl").forEach(function (pill) {
      pill.onclick = function () {
        const facet = pill.dataset.facet;
        const value = pill.dataset.v;
        if (facet === undefined || value === undefined)
          throw new Error("dashboard filter is incomplete");
        const values = filterSet(state, facet);
        if (values.has(value)) values.delete(value);
        else values.add(value);
        pill.classList.toggle("on");
        apply(true);
      };
    });
  }
  function dropdownMenu(host: HTMLElement, key: string): void {
    const counts = uniqueNodeValues(nodes, key);
    host.innerHTML = Object.keys(counts)
      .sort()
      .map(function (keyValue) {
        return (
          '<label class="chk"><input type="checkbox" data-facet="' +
          key +
          '" value="' +
          esc(keyValue) +
          '">' +
          esc(keyValue) +
          '<span class="ct">' +
          counts[keyValue] +
          "</span></label>"
        );
      })
      .join("");
    host.querySelectorAll<HTMLInputElement>("input").forEach(function (checkbox) {
      checkbox.onchange = function () {
        const facet = checkbox.dataset.facet;
        if (facet === undefined) throw new Error("dashboard filter is incomplete");
        const values = filterSet(state, facet);
        if (checkbox.checked) values.add(checkbox.value);
        else values.delete(checkbox.value);
        apply(true);
      };
    });
  }
  el("s_nodes").textContent = String(nodes.length);
  el("s_edges").textContent = String(DATA.edgeCount);
  el("s_ready").textContent = String(
    nodes.filter(function (node) {
      return node.ready;
    }).length,
  );
  const validationBanner = el("s_valid");
  if (DATA.errorCount > 0) {
    validationBanner.className = "badwarn err";
    validationBanner.textContent =
      "⚠ " + DATA.errorCount + " issue" + (DATA.errorCount === 1 ? "" : "s");
    validationBanner.onclick = openIssues;
  } else {
    validationBanner.className = "badwarn ok";
    validationBanner.textContent = "✓ clean";
  }
  renderProvenance();
  pillset(el("p_status"), "status", null, statusColors);
  pillset(el("p_priority"), "priority", priorityRank, priorityColors);
  pillset(el("p_target"), "target", targetRank, null);
  dropdownMenu(el("m_project"), "projects");
  dropdownMenu(el("m_group"), "parallelGroup");
  const query = el("q", HTMLInputElement);
  const readyToggle = el("t_ready", HTMLInputElement);
  const issuesToggle = el("t_issues", HTMLInputElement);
  const sortSelect = el("sort", HTMLSelectElement);
  query.oninput = function () {
    state.q = query.value.toLowerCase();
    apply(true);
  };
  readyToggle.onchange = function () {
    state.readyOnly = readyToggle.checked;
    apply(true);
  };
  issuesToggle.onchange = function () {
    state.issuesOnly = issuesToggle.checked;
    apply(true);
  };
  sortSelect.onchange = function () {
    state.sort = sortSelect.value;
    renderList();
  };
  el("clear").onclick = function () {
    state.q = "";
    (["status", "priority", "target", "project", "group"] as const).forEach(function (key) {
      state[key] = new Set<string>();
    });
    state.issuesOnly = false;
    state.readyOnly = false;
    query.value = "";
    readyToggle.checked = false;
    issuesToggle.checked = false;
    document.querySelectorAll<HTMLElement>(".pl.on").forEach(function (pill) {
      pill.classList.remove("on");
    });
    document.querySelectorAll<HTMLInputElement>(".ddmenu input").forEach(function (checkbox) {
      checkbox.checked = false;
    });
    apply(true);
  };
  el("dclose").onclick = function () {
    unfocus();
  };
  el("unfocus").onclick = function () {
    unfocus();
  };
  document.addEventListener("keydown", function (event) {
    if (event.key === "/" && document.activeElement !== query) {
      event.preventDefault();
      query.focus();
    }
    if (event.key === "Escape") {
      if (el("modal").classList.contains("show")) el("modalclose").click();
      else if (state.sel) unfocus();
    }
    if (event.key === "f" && document.activeElement !== query) {
      if (state.sel) unfocus();
      else graph.fit(420);
    }
  });
  graph.render();
  renderList();
  graph.style();
  graph.fit(0);
  setTimeout(function () {
    graph.fit(0);
  }, 40);
})();
