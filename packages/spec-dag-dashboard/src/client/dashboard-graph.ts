import type { AnyNode, DashboardState, Position } from "./dashboard-types.js";

interface GraphController {
  animateNodes: (targets: Record<string, Position>, duration: number) => void;
  bringToFront: (ids: Set<string>) => void;
  compactTargets: (lineage: Set<string>) => Record<string, Position>;
  fit: (duration: number) => void;
  frameIds: (ids: string[], positions: Record<string, Position>, duration: number) => void;
  render: () => void;
  style: () => void;
}

interface ElementLookup {
  (id: string): HTMLElement;
  <T extends Element>(id: string, expected: abstract new () => T): T;
}

export function createGraphController(input: {
  anyFilter: () => boolean;
  basePos: Record<string, Position>;
  byId: Record<string, AnyNode>;
  colOf: Record<string, number>;
  el: ElementLookup;
  esc: (value: unknown) => string;
  getLineage: () => Set<string>;
  getSelectedAncestors: () => Set<string> | null;
  getSelectedDescendants: () => Set<string> | null;
  height: number;
  nodePasses: (node: AnyNode) => boolean;
  nodes: AnyNode[];
  required: <T>(value: T | undefined, label: string) => T;
  select: (id: string) => void;
  state: DashboardState;
  statusColor: (node: AnyNode) => string;
  statusLabel: (node: AnyNode) => string;
  unfocus: () => void;
  width: number;
}): GraphController {
  const nodeWidth = 150;
  const nodeHeight = 22;
  const rowY = 30;
  const padding = 40;
  const nodeElements: Record<string, SVGGElement> = {};
  const currentPositions: Record<string, Position> = {};
  const edges: Array<{ el: SVGPathElement; from: string; to: string }> = [];
  let dragMoved = false;
  let movedIds: Record<string, number> = {};

  function edgePath(from: string, to: string): string {
    const source = currentPositions[from];
    const target = currentPositions[to];
    if (!source || !target) return "";
    const sourceX = source.x + nodeWidth;
    const sourceY = source.y + nodeHeight / 2;
    const targetX = target.x;
    const targetY = target.y + nodeHeight / 2;
    const middleX = (sourceX + targetX) / 2;
    return `M${sourceX},${sourceY} C${middleX},${sourceY} ${middleX},${targetY} ${targetX},${targetY}`;
  }
  function render(): void {
    let markup = "";
    input.nodes.forEach(function (node) {
      const position = input.required(input.basePos[node.id], `position ${node.id}`);
      currentPositions[node.id] = { x: position.x, y: position.y };
    });
    input.nodes.forEach(function (node) {
      (node.dependsOn || []).forEach(function (dependency) {
        if (!currentPositions[dependency]) return;
        markup +=
          '<path class="edge" data-f="' +
          input.esc(dependency) +
          '" data-t="' +
          input.esc(node.id) +
          '" d="' +
          edgePath(dependency, node.id) +
          '"/>';
      });
    });
    input.nodes.forEach(function (node) {
      const position = input.required(currentPositions[node.id], `position ${node.id}`);
      const color = input.statusColor(node);
      markup +=
        '<g class="ndg" data-id="' +
        input.esc(node.id) +
        '" transform="translate(' +
        position.x +
        "," +
        position.y +
        ')">' +
        '<rect class="bx" x="0" y="0" width="' +
        nodeWidth +
        '" height="' +
        nodeHeight +
        '" rx="6" fill="rgba(12,15,30,.92)" stroke="' +
        color +
        '" stroke-width="1.3"/>' +
        '<rect x="0" y="0" width="4" height="' +
        nodeHeight +
        '" rx="2" fill="' +
        color +
        '"/>' +
        '<text class="ntext" x="11" y="' +
        (nodeHeight / 2 + 1) +
        '" fill="#d4d9f5">' +
        input.esc(node.id) +
        (node.issues.length ? "  ⚠" : "") +
        "</text></g>";
    });
    input.el("vp").innerHTML = markup;
    input
      .el("vp", SVGGElement)
      .querySelectorAll<SVGGElement>(".ndg")
      .forEach(function (group) {
        const id = group.dataset.id;
        if (id === undefined) throw new Error("dashboard graph node has no id");
        nodeElements[id] = group;
        group.addEventListener("mouseenter", function (event) {
          showTip(id, event);
        });
        group.addEventListener("mousemove", moveTip);
        group.addEventListener("mouseleave", hideTip);
        group.addEventListener("click", function (event) {
          event.stopPropagation();
          if (!dragMoved) input.select(id);
        });
      });
    input
      .el("vp", SVGGElement)
      .querySelectorAll<SVGPathElement>(".edge")
      .forEach(function (path) {
        const from = path.dataset.f;
        const to = path.dataset.t;
        if (from === undefined || to === undefined)
          throw new Error("dashboard edge has no endpoint");
        edges.push({ el: path, from, to });
      });
  }
  function bringToFront(ids: Set<string>): void {
    ids.forEach(function (id) {
      const nodeElement = nodeElements[id];
      if (nodeElement) input.el("vp").appendChild(nodeElement);
    });
  }
  function ancestorsOrEmpty(): Set<string> {
    return input.getSelectedAncestors() || new Set<string>();
  }
  function descendantsOrEmpty(): Set<string> {
    return input.getSelectedDescendants() || new Set<string>();
  }
  function style(): void {
    if (input.state.sel) {
      const lineage = input.getLineage();
      const ancestors = ancestorsOrEmpty();
      const descendants = descendantsOrEmpty();
      input.nodes.forEach(function (node) {
        const group = input.required(nodeElements[node.id], `element ${node.id}`);
        group.classList.toggle("dim", !lineage.has(node.id));
        group.classList.toggle("sel", node.id === input.state.sel);
      });
      edges.forEach(function (edge) {
        const upstream =
          (edge.to === input.state.sel || ancestors.has(edge.to)) &&
          (edge.from === input.state.sel || ancestors.has(edge.from));
        const downstream =
          (edge.from === input.state.sel || descendants.has(edge.from)) &&
          (edge.to === input.state.sel || descendants.has(edge.to));
        edge.el.classList.toggle("lit", downstream);
        edge.el.classList.toggle("litUp", upstream && !downstream);
        edge.el.style.opacity = upstream || downstream ? "1" : ".1";
      });
      return;
    }
    const activeFilter = input.anyFilter();
    input.nodes.forEach(function (node) {
      const group = input.required(nodeElements[node.id], `element ${node.id}`);
      group.classList.remove("sel");
      group.classList.toggle("dim", activeFilter && !input.nodePasses(node));
    });
    edges.forEach(function (edge) {
      edge.el.classList.remove("lit", "litUp");
      edge.el.style.opacity =
        !activeFilter ||
        (input.nodePasses(input.required(input.byId[edge.from], `node ${edge.from}`)) &&
          input.nodePasses(input.required(input.byId[edge.to], `node ${edge.to}`)))
          ? "1"
          : ".1";
    });
  }
  function setPosition(id: string, x: number, y: number): void {
    const position = input.required(currentPositions[id], `position ${id}`);
    position.x = x;
    position.y = y;
    input
      .required(nodeElements[id], `element ${id}`)
      .setAttribute("transform", `translate(${x},${y})`);
  }
  function ease(progress: number): number {
    return progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  }
  let nodeAnimation = 0;
  function animateNodes(targets: Record<string, Position>, duration: number): void {
    const ids = Object.keys(targets);
    if (!ids.length) return;
    const starts: Record<string, Position> = {};
    ids.forEach(function (id) {
      const position = input.required(currentPositions[id], `position ${id}`);
      starts[id] = { x: position.x, y: position.y };
    });
    const incidentEdges = edges.filter(function (edge) {
      return targets[edge.from] || targets[edge.to];
    });
    cancelAnimationFrame(nodeAnimation);
    const startTime = performance.now();
    function frame(now: number): void {
      const progress = Math.min(1, (now - startTime) / duration);
      ids.forEach(function (id) {
        const start = input.required(starts[id], `start ${id}`);
        const target = input.required(targets[id], `target ${id}`);
        const eased = ease(progress);
        setPosition(
          id,
          start.x + (target.x - start.x) * eased,
          start.y + (target.y - start.y) * eased,
        );
      });
      incidentEdges.forEach(function (edge) {
        edge.el.setAttribute("d", edgePath(edge.from, edge.to));
      });
      if (progress < 1) nodeAnimation = requestAnimationFrame(frame);
    }
    frame(startTime);
  }
  const svg = input.el("svg", SVGSVGElement);
  const viewport = input.el("vp", SVGGElement);
  const view = { k: 1, tx: 0, ty: 0 };
  function applyView(): void {
    viewport.setAttribute("transform", `translate(${view.tx},${view.ty}) scale(${view.k})`);
  }
  let viewAnimation = 0;
  function animateView(to: { k: number; tx: number; ty: number }, duration: number): void {
    const from = { k: view.k, tx: view.tx, ty: view.ty };
    if (!duration) {
      view.k = to.k;
      view.tx = to.tx;
      view.ty = to.ty;
      applyView();
      return;
    }
    cancelAnimationFrame(viewAnimation);
    const startTime = performance.now();
    function frame(now: number): void {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = ease(progress);
      view.k = from.k + (to.k - from.k) * eased;
      view.tx = from.tx + (to.tx - from.tx) * eased;
      view.ty = from.ty + (to.ty - from.ty) * eased;
      applyView();
      if (progress < 1) viewAnimation = requestAnimationFrame(frame);
    }
    frame(startTime);
  }
  function frameBox(
    minimumX: number,
    minimumY: number,
    maximumX: number,
    maximumY: number,
    duration: number,
    leftBias: boolean,
  ): void {
    const boxWidth = Math.max(maximumX - minimumX, 40);
    const boxHeight = Math.max(maximumY - minimumY, 40);
    const availableWidth = svg.clientWidth - (input.state.sel ? 440 : 0);
    const scale = Math.max(
      0.08,
      Math.min(
        Math.min(availableWidth / (boxWidth + 128), svg.clientHeight / (boxHeight + 128)),
        1.5,
      ),
    );
    const centerX = minimumX + boxWidth / 2;
    const centerY = minimumY + boxHeight / 2;
    animateView(
      {
        k: scale,
        tx: (leftBias ? availableWidth / 2 : availableWidth / 2) - centerX * scale,
        ty: svg.clientHeight / 2 - centerY * scale,
      },
      duration,
    );
  }
  function frameIds(ids: string[], positions: Record<string, Position>, duration: number): void {
    if (!ids.length) return fit(duration);
    let minimumX = 1e9;
    let minimumY = 1e9;
    let maximumX = -1e9;
    let maximumY = -1e9;
    ids.forEach(function (id) {
      const position = positions[id];
      if (!position) return;
      minimumX = Math.min(minimumX, position.x);
      minimumY = Math.min(minimumY, position.y);
      maximumX = Math.max(maximumX, position.x + nodeWidth);
      maximumY = Math.max(maximumY, position.y + nodeHeight);
    });
    frameBox(minimumX, minimumY, maximumX, maximumY, duration, true);
  }
  function fit(duration: number): void {
    frameBox(padding, padding, input.width - padding, input.height - padding, duration, false);
  }
  function zoomAt(centerX: number, centerY: number, factor: number): void {
    const scale = Math.max(0.08, Math.min(view.k * factor, 3));
    view.tx = centerX - (centerX - view.tx) * (scale / view.k);
    view.ty = centerY - (centerY - view.ty) * (scale / view.k);
    view.k = scale;
    applyView();
  }
  svg.addEventListener(
    "wheel",
    function (event) {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
      );
    },
    { passive: false },
  );
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originalX = 0;
  let originalY = 0;
  svg.addEventListener("mousedown", function (event) {
    dragging = true;
    dragMoved = false;
    startX = event.clientX;
    startY = event.clientY;
    originalX = view.tx;
    originalY = view.ty;
    svg.classList.add("grabbing");
  });
  window.addEventListener("mousemove", function (event) {
    if (!dragging) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) dragMoved = true;
    view.tx = originalX + deltaX;
    view.ty = originalY + deltaY;
    applyView();
  });
  window.addEventListener("mouseup", function () {
    dragging = false;
    svg.classList.remove("grabbing");
  });
  svg.addEventListener("click", function (event) {
    if ((event.target === svg || event.target === viewport) && !dragMoved && input.state.sel)
      input.unfocus();
  });
  input.el("fit").onclick = function () {
    if (input.state.sel) input.unfocus();
    else fit(420);
  };
  input.el("zin").onclick = function () {
    zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.2);
  };
  input.el("zout").onclick = function () {
    zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1 / 1.2);
  };
  function compactTargets(lineage: Set<string>): Record<string, Position> {
    const columns: Record<number, string[]> = {};
    lineage.forEach(function (id) {
      const column = input.required(input.colOf[id], `column ${id}`);
      (columns[column] = columns[column] || []).push(id);
    });
    const selectedId = input.state.sel;
    if (selectedId === null) throw new Error("dashboard has no selected node");
    const centerY =
      input.required(input.basePos[selectedId], `position ${selectedId}`).y + nodeHeight / 2;
    const targets: Record<string, Position> = {};
    Object.keys(columns).forEach(function (column) {
      const ids = input
        .required(columns[Number(column)], `column ${column}`)
        .sort(function (left, right) {
          return (
            input.required(input.basePos[left], `position ${left}`).y -
            input.required(input.basePos[right], `position ${right}`).y
          );
        });
      const startY = centerY - ((ids.length - 1) / 2) * rowY - nodeHeight / 2;
      ids.forEach(function (id, index) {
        targets[id] = {
          x: input.required(input.basePos[id], `position ${id}`).x,
          y: startY + index * rowY,
        };
      });
    });
    return targets;
  }
  function showTip(id: string, event: MouseEvent): void {
    const node = input.byId[id];
    if (node === undefined) return;
    input.el("gtip").innerHTML =
      '<div class="gi">' +
      input.esc(node.id) +
      " · " +
      input.statusLabel(node) +
      " · " +
      input.esc(node.priority) +
      "</div>" +
      input.esc(node.title);
    input.el("gtip").style.display = "block";
    moveTip(event);
  }
  function moveTip(event: MouseEvent): void {
    const rect = input.el("graphwrap").getBoundingClientRect();
    const tip = input.el("gtip");
    let x = event.clientX - rect.left + 14;
    const y = event.clientY - rect.top + 14;
    if (x + 290 > rect.width) x = event.clientX - rect.left - 290;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip(): void {
    input.el("gtip").style.display = "none";
  }
  return { animateNodes, bringToFront, compactTargets, fit, frameIds, render, style };
}
