import { provenanceBannerClassName } from "../provenance-status.js";
import type { DashboardData, EnrichedNode, Provenance } from "./client-types.js";
declare const DATA: DashboardData;
type AnyNode = EnrichedNode & Record<string, unknown>;
(function (): void {
  const nodes = DATA.nodes as AnyNode[];
  const byId: Record<string, AnyNode> = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const PRANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const TRANK: Record<string, number> = { baseline: 0, alpha: 1, continuous: 2 };
  const SCOLOR: Record<string, string> = {
    complete: "#3ee08f",
    in_progress: "#b89bff",
    planned: "#7782b0",
    blocked: "#ff5d73",
    cancelled: "#6b7088",
  };
  function statusColor(n: AnyNode): string {
    return n.ready ? "#ffc24a" : SCOLOR[n.status] || "#7782b0";
  }
  function statusLabel(n: AnyNode): string {
    return n.ready ? "ready" : n.status;
  }
  function esc(s: unknown): string {
    const str = String(s == null ? "" : s);
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function el(id: string): HTMLElement;
  function el<T extends Element>(id: string, expected: abstract new () => T): T;
  function el(id: string, expected?: abstract new () => Element): Element {
    const element = document.getElementById(id);
    if (element === null || !(element instanceof (expected ?? HTMLElement))) {
      throw new Error(`dashboard template element ${id} is missing or has the wrong type`);
    }
    return element;
  }
  function required<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`dashboard ${label} is missing`);
    return value;
  }
  function nodeFor(id: string): AnyNode {
    return required(byId[id], `node ${id}`);
  }
  function filterSet(facet: string): Set<string> {
    if (facet === "status" || facet === "priority" || facet === "target") return state[facet];
    if (facet === "projects") return state.project;
    if (facet === "parallelGroup") return state.group;
    throw new Error(`dashboard filter ${facet} is unknown`);
  }
  function uniq(key: string): Record<string, number> {
    const m: Record<string, number> = {};
    nodes.forEach(function (n) {
      const v = (n as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        v.forEach(function (x) {
          m[x as string] = (m[x as string] || 0) + 1;
        });
      } else {
        m[v as string] = (m[v as string] || 0) + 1;
      }
    });
    return m;
  }
  function clamp(v: number, a: number, b: number): number {
    return Math.max(a, Math.min(b, v));
  }
  interface State {
    q: string;
    status: Set<string>;
    priority: Set<string>;
    target: Set<string>;
    project: Set<string>;
    group: Set<string>;
    issuesOnly: boolean;
    readyOnly: boolean;
    sort: string;
    sel: string | null;
  }
  const state: State = {
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
  el("s_nodes").textContent = String(nodes.length);
  el("s_edges").textContent = String(DATA.edgeCount);
  el("s_ready").textContent = String(
    nodes.filter(function (n) {
      return n.ready;
    }).length,
  );
  const vb = el("s_valid");
  if (DATA.errorCount > 0) {
    vb.className = "badwarn err";
    vb.textContent =
      "⚠ " + DATA.errorCount + " issue" + (DATA.errorCount === 1 ? "" : "s");
    vb.onclick = openIssues;
  } else {
    vb.className = "badwarn ok";
    vb.textContent = "✓ clean";
  }
  function relativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (isNaN(then)) return "unknown time";
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 45) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }
  function renderProvenance(): void {
    const pv = el("provbanner");
    if (!pv) return;
    const p: Provenance = DATA.provenance;
    const sha = p.headShortSha || "unknown";
    const when = relativeTime(p.generatedAt);
    const behind = (p.commitsBehind || 0) > 0;
    if (!p.originMainKnown) {
      pv.className = provenanceBannerClassName(p);
      pv.textContent =
        "⚠ " +
        sha +
        " · generated " +
        when +
        " — staleness unverifiable: origin/main unknown locally — run git fetch";
      return;
    }
    if (behind || p.dirty) {
      pv.className = provenanceBannerClassName(p);
      const parts: string[] = [];
      if (behind) {
        parts.push(
          "⚠ " +
            p.commitsBehind +
            " commit" +
            (p.commitsBehind === 1 ? "" : "s") +
            " behind origin/main (as of last fetch)",
        );
      }
      if (p.dirty) parts.push("⚠ working tree dirty");
      parts.push("re-run: just dev roadmap-dashboard");
      pv.textContent = sha + " · " + parts.join(" — ");
      return;
    }
    pv.className = provenanceBannerClassName(p);
    pv.textContent = "✓ " + sha + " · generated " + when;
  }
  renderProvenance();
  function pillset(
    host: HTMLElement,
    key: string,
    order: Record<string, number> | null,
    colors: Record<string, string> | null,
  ): void {
    const c = uniq(key);
    const keys = Object.keys(c);
    if (order)
      keys.sort(function (a, b) {
        return (order[a] == null ? 9 : order[a]) - (order[b] == null ? 9 : order[b]);
      });
    else keys.sort();
    host.innerHTML = keys
      .map(function (k) {
        const sw =
          colors && colors[k]
            ? '<span class="sw" style="background:' + colors[k] + '"></span>'
            : "";
        return (
          '<span class="pl" data-facet="' +
          key +
          '" data-v="' +
          esc(k) +
          '">' +
          sw +
          esc(k) +
          "</span>"
        );
      })
      .join("");
    Array.prototype.forEach.call(host.querySelectorAll(".pl"), function (p: HTMLElement) {
      p.onclick = function () {
        const facet = p.dataset.facet;
        const v = p.dataset.v;
        if (facet === undefined || v === undefined)
          throw new Error("dashboard filter is incomplete");
        const s = filterSet(facet);
        if (s.has(v)) s.delete(v);
        else s.add(v);
        p.classList.toggle("on");
        apply(true);
      };
    });
  }
  function ddmenu(host: HTMLElement, key: string): void {
    const c = uniq(key);
    const keys = Object.keys(c).sort();
    host.innerHTML = keys
      .map(function (k) {
        return (
          '<label class="chk"><input type="checkbox" data-facet="' +
          key +
          '" value="' +
          esc(k) +
          '">' +
          esc(k) +
          '<span class="ct">' +
          c[k] +
          "</span></label>"
        );
      })
      .join("");
    Array.prototype.forEach.call(host.querySelectorAll("input"), function (cb: HTMLInputElement) {
      cb.onchange = function () {
        const facet = cb.dataset.facet;
        if (facet === undefined) throw new Error("dashboard filter is incomplete");
        const s = filterSet(facet);
        if (cb.checked) s.add(cb.value);
        else s.delete(cb.value);
        apply(true);
      };
    });
  }
  const statusColors: Record<string, string> = {
    complete: "#3ee08f",
    in_progress: "#b89bff",
    planned: "#7782b0",
    blocked: "#ff5d73",
    cancelled: "#6b7088",
  };
  const prColors: Record<string, string> = {
    P0: "#ff5d73",
    P1: "#ffa53d",
    P2: "#5fb2ff",
    P3: "#9aa0c4",
  };
  pillset(el("p_status"), "status", null, statusColors);
  pillset(el("p_priority"), "priority", PRANK, prColors);
  pillset(el("p_target"), "target", TRANK, null);
  ddmenu(el("m_project"), "projects");
  ddmenu(el("m_group"), "parallelGroup");
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
    (["status", "priority", "target", "project", "group"] as const).forEach(function (k) {
      state[k] = new Set<string>();
    });
    state.issuesOnly = false;
    state.readyOnly = false;
    query.value = "";
    readyToggle.checked = false;
    issuesToggle.checked = false;
    Array.prototype.forEach.call(document.querySelectorAll(".pl.on"), function (p: HTMLElement) {
      p.classList.remove("on");
    });
    Array.prototype.forEach.call(
      document.querySelectorAll(".ddmenu input"),
      function (c: HTMLInputElement) {
        c.checked = false;
      },
    );
    apply(true);
  };
  function anyFilter(): boolean {
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
  function passes(n: AnyNode): boolean {
    if (state.readyOnly && !n.ready) return false;
    if (state.issuesOnly && !n.issues.length) return false;
    if (state.status.size && !state.status.has(n.status)) return false;
    if (state.priority.size && !state.priority.has(n.priority)) return false;
    if (state.target.size && !state.target.has(n.target)) return false;
    if (state.group.size && !state.group.has(n.parallelGroup)) return false;
    if (
      state.project.size &&
      !(n.projects || []).some(function (p) {
        return state.project.has(p);
      })
    )
      return false;
    if (state.q) {
      const hay = (
        n.id +
        " " +
        n.title +
        " " +
        (n.summary || "") +
        " " +
        (n.deliverables || []).join(" ") +
        " " +
        (n.acceptanceCriteria || []).join(" ")
      ).toLowerCase();
      if (hay.indexOf(state.q) < 0) return false;
    }
    return true;
  }
  const NODE_W = 150;
  const NODE_H = 22;
  const COLX = 212;
  const ROWY = 30;
  const PAD = 40;
  const basePos: Record<string, { x: number; y: number }> = {};
  let layW = 0;
  let layH = 0;
  const colOf: Record<string, number> = {};
  function layout(): void {
    const depth: Record<string, number> = {};
    function dep(id: string, seen: Record<string, number>): number {
      if (depth[id] != null) return depth[id];
      if (seen[id]) return 0;
      seen[id] = 1;
      const n = byId[id];
      if (!n) return 0;
      const ds = (n.dependsOn || []).filter(function (x) {
        return byId[x];
      });
      const v = ds.length
        ? Math.max.apply(
            null,
            ds.map(function (x) {
              return dep(x, seen);
            }),
          ) + 1
        : 0;
      depth[id] = v;
      return v;
    }
    nodes.forEach(function (n) {
      dep(n.id, {});
      colOf[n.id] = required(depth[n.id], `depth ${n.id}`);
    });
    const cols: Record<number, string[]> = {};
    nodes.forEach(function (n) {
      const depthForNode = required(depth[n.id], `depth ${n.id}`);
      (cols[depthForNode] = cols[depthForNode] || []).push(n.id);
    });
    const maxC = Math.max.apply(null, Object.keys(cols).map(Number));
    const row: Record<string, number> = {};
    for (let c = 0; c <= maxC; c++) {
      if (!cols[c]) continue;
      const col = required(cols[c], `column ${c}`);
      col.sort(function (a, b) {
        const A = nodeFor(a);
        const B = nodeFor(b);
        return (
          (PRANK[A.priority] ?? 9) - (PRANK[B.priority] ?? 9) ||
          (TRANK[A.target] ?? 9) - (TRANK[B.target] ?? 9) ||
          a.localeCompare(b)
        );
      });
      col.forEach(function (id, i) {
        row[id] = i;
      });
    }
    function sweep(useDeps: boolean): void {
      for (let c = 0; c <= maxC; c++) {
        const col = cols[c];
        if (!col) continue;
        col.forEach(function (id) {
          const node = nodeFor(id);
          let nb = useDeps ? node.dependsOn || [] : node.dependents;
          nb = nb.filter(function (x) {
            return byId[x];
          });
          if (nb.length) {
            let s = 0;
            nb.forEach(function (x) {
              s += required(row[x], `row ${x}`);
            });
            (byId[id] as Record<string, unknown>)._bc = s / nb.length;
          } else (byId[id] as Record<string, unknown>)._bc = required(row[id], `row ${id}`);
        });
        col
          .slice()
          .sort(function (a, b) {
            return (
              ((nodeFor(a) as Record<string, number>)._bc ?? 0) -
              ((nodeFor(b) as Record<string, number>)._bc ?? 0)
            );
          })
          .forEach(function (id, i) {
            row[id] = i;
          });
        col.sort(function (a, b) {
          return required(row[a], `row ${a}`) - required(row[b], `row ${b}`);
        });
      }
    }
    for (let s = 0; s < 4; s++) {
      sweep(true);
      sweep(false);
    }
    let maxRows = 0;
    for (let c2 = 0; c2 <= maxC; c2++) {
      const col = cols[c2];
      if (col) maxRows = Math.max(maxRows, col.length);
    }
    for (let c3 = 0; c3 <= maxC; c3++) {
      const col = cols[c3];
      if (!col) continue;
      const off = (maxRows - col.length) / 2;
      col.forEach(function (id, i) {
        basePos[id] = { x: PAD + c3 * COLX, y: PAD + (off + i) * ROWY };
      });
    }
    layW = PAD * 2 + (maxC + 1) * COLX;
    layH = PAD * 2 + maxRows * ROWY;
  }
  const nodeEls: Record<string, SVGGElement> = {};
  const curPos: Record<string, { x: number; y: number }> = {};
  const edgeEls: Array<{ el: SVGPathElement; f: string; t: string }> = [];
  let movedIds: Record<string, number> = {};
  function edgeD(f: string, t: string): string {
    const a = curPos[f];
    const b = curPos[t];
    if (!a || !b) return "";
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2;
  }
  function renderGraph(): void {
    let s = "";
    nodes.forEach(function (n) {
      const position = required(basePos[n.id], `position ${n.id}`);
      curPos[n.id] = { x: position.x, y: position.y };
    });
    nodes.forEach(function (n) {
      (n.dependsOn || []).forEach(function (d) {
        if (!curPos[d]) return;
        s +=
          '<path class="edge" data-f="' +
          esc(d) +
          '" data-t="' +
          esc(n.id) +
          '" d="' +
          edgeD(d, n.id) +
          '"/>';
      });
    });
    nodes.forEach(function (n) {
      const p = required(curPos[n.id], `position ${n.id}`);
      const col = statusColor(n);
      s +=
        '<g class="ndg" data-id="' +
        esc(n.id) +
        '" transform="translate(' +
        p.x +
        "," +
        p.y +
        ')">' +
        '<rect class="bx" x="0" y="0" width="' +
        NODE_W +
        '" height="' +
        NODE_H +
        '" rx="6" fill="rgba(12,15,30,.92)" stroke="' +
        col +
        '" stroke-width="1.3"/>' +
        '<rect x="0" y="0" width="4" height="' +
        NODE_H +
        '" rx="2" fill="' +
        col +
        '"/>' +
        '<text class="ntext" x="11" y="' +
        (NODE_H / 2 + 1) +
        '" fill="#d4d9f5">' +
        esc(n.id) +
        (n.issues.length ? "  ⚠" : "") +
        "</text>" +
        "</g>";
    });
    el("vp").innerHTML = s;
    el("vp", SVGGElement)
      .querySelectorAll<SVGGElement>(".ndg")
      .forEach(function (g) {
        const id = g.dataset.id;
        if (id === undefined) throw new Error("dashboard graph node has no id");
        nodeEls[id] = g;
        g.addEventListener("mouseenter", function (e) {
          showTip(id, e as MouseEvent);
        });
        g.addEventListener("mousemove", function (e) {
          moveTip(e as MouseEvent);
        });
        g.addEventListener("mouseleave", hideTip);
        g.addEventListener("click", function (e) {
          e.stopPropagation();
          if (!dragMoved) select(id);
        });
      });
    el("vp", SVGGElement)
      .querySelectorAll<SVGPathElement>(".edge")
      .forEach(function (path) {
        const from = path.dataset.f;
        const to = path.dataset.t;
        if (from === undefined || to === undefined)
          throw new Error("dashboard edge has no endpoint");
        edgeEls.push({ el: path, f: from, t: to });
      });
  }
  function setPos(id: string, x: number, y: number): void {
    const position = required(curPos[id], `position ${id}`);
    position.x = x;
    position.y = y;
    required(nodeEls[id], `element ${id}`).setAttribute(
      "transform",
      "translate(" + x + "," + y + ")",
    );
  }
  function ancestors(id: string): Set<string> {
    const out = new Set<string>();
    const st = [id];
    while (st.length) {
      const x = st.pop();
      if (x === undefined) continue;
      (nodeFor(x).dependsOn || []).forEach(function (d) {
        if (byId[d] && !out.has(d)) {
          out.add(d);
          st.push(d);
        }
      });
    }
    return out;
  }
  function descendants(id: string): Set<string> {
    const out = new Set<string>();
    const st = [id];
    while (st.length) {
      const x = st.pop();
      if (x === undefined) continue;
      (nodeFor(x).dependents || []).forEach(function (d) {
        if (byId[d] && !out.has(d)) {
          out.add(d);
          st.push(d);
        }
      });
    }
    return out;
  }
  let curAnc: Set<string> | null = null;
  let curDesc: Set<string> | null = null;
  function lineageSet(): Set<string> {
    const l = new Set<string>(curAnc as Set<string>);
    (curDesc as Set<string>).forEach(function (x) {
      l.add(x);
    });
    l.add(state.sel as string);
    return l;
  }
  function styleGraph(): void {
    if (state.sel) {
      const lin = lineageSet();
      nodes.forEach(function (n) {
        const g = required(nodeEls[n.id], `element ${n.id}`);
        g.classList.toggle("dim", !lin.has(n.id));
        g.classList.toggle("sel", n.id === state.sel);
      });
      edgeEls.forEach(function (e) {
        const up =
          (e.t === state.sel || (curAnc as Set<string>).has(e.t)) &&
          (e.f === state.sel || (curAnc as Set<string>).has(e.f));
        const down =
          (e.f === state.sel || (curDesc as Set<string>).has(e.f)) &&
          (e.t === state.sel || (curDesc as Set<string>).has(e.t));
        e.el.classList.toggle("lit", down);
        e.el.classList.toggle("litUp", up && !down);
        e.el.style.opacity = up || down ? "1" : ".1";
      });
    } else {
      const af = anyFilter();
      nodes.forEach(function (n) {
        const g = required(nodeEls[n.id], `element ${n.id}`);
        g.classList.remove("sel");
        g.classList.toggle("dim", af && !passes(n));
      });
      edgeEls.forEach(function (e) {
        e.el.classList.remove("lit", "litUp");
        e.el.style.opacity = !af || (passes(nodeFor(e.f)) && passes(nodeFor(e.t))) ? "1" : ".1";
      });
    }
  }
  function ease(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  let viewRaf = 0;
  let nodeRaf = 0;
  function tween(
    dur: number,
    step: (p: number) => void,
    done: (() => void) | null,
    setRaf: (r: number) => void,
  ): void {
    const t0 = performance.now();
    (function fr(now: number) {
      const t = Math.min(1, (now - t0) / dur);
      step(ease(t));
      if (t < 1) setRaf(requestAnimationFrame(fr));
      else if (done) done();
    })(performance.now());
  }
  function animateNodes(
    targets: Record<string, { x: number; y: number }>,
    dur: number,
    done?: () => void,
  ): void {
    const ids = Object.keys(targets);
    if (!ids.length) {
      if (done) done();
      return;
    }
    const starts: Record<string, { x: number; y: number }> = {};
    ids.forEach(function (id) {
      const position = required(curPos[id], `position ${id}`);
      starts[id] = { x: position.x, y: position.y };
    });
    const incident = edgeEls.filter(function (e) {
      return targets[e.f] || targets[e.t];
    });
    cancelAnimationFrame(nodeRaf);
    tween(
      dur,
      function (p) {
        ids.forEach(function (id) {
          const start = required(starts[id], `start ${id}`);
          const target = required(targets[id], `target ${id}`);
          setPos(id, start.x + (target.x - start.x) * p, start.y + (target.y - start.y) * p);
        });
        incident.forEach(function (e) {
          e.el.setAttribute("d", edgeD(e.f, e.t));
        });
      },
      done ?? null,
      function (r) {
        nodeRaf = r;
      },
    );
  }
  const svg = el("svg", SVGSVGElement), vp = el("vp", SVGGElement);
  const view = { k: 1, tx: 0, ty: 0 };
  function applyView(): void {
    vp.setAttribute(
      "transform",
      "translate(" + view.tx + "," + view.ty + ") scale(" + view.k + ")",
    );
  }
  function vw(): number {
    return svg.clientWidth;
  }
  function vh(): number {
    return svg.clientHeight;
  }
  function availW(): number {
    return vw() - (state.sel ? 440 : 0);
  }
  function animateView(to: { k: number; tx: number; ty: number }, dur: number): void {
    const f = { k: view.k, tx: view.tx, ty: view.ty };
    cancelAnimationFrame(viewRaf);
    if (!dur) {
      view.k = to.k;
      view.tx = to.tx;
      view.ty = to.ty;
      applyView();
      return;
    }
    tween(
      dur,
      function (p) {
        view.k = f.k + (to.k - f.k) * p;
        view.tx = f.tx + (to.tx - f.tx) * p;
        view.ty = f.ty + (to.ty - f.ty) * p;
        applyView();
      },
      null,
      function (r) {
        viewRaf = r;
      },
    );
  }
  function frameBox(
    minx: number,
    miny: number,
    maxx: number,
    maxy: number,
    dur: number,
    leftBias: boolean,
  ): void {
    const bw = Math.max(maxx - minx, 40);
    const bh = Math.max(maxy - miny, 40);
    const pad = 64;
    const aw = availW();
    const k = clamp(Math.min(aw / (bw + pad * 2), vh() / (bh + pad * 2)), 0.08, 1.5);
    const cx = minx + bw / 2;
    const cy = miny + bh / 2;
    const tx = (leftBias ? aw / 2 : availW() / 2) - cx * k;
    const ty = vh() / 2 - cy * k;
    animateView({ k: k, tx: tx, ty: ty }, dur);
  }
  function frameIds(
    ids: string[],
    src: Record<string, { x: number; y: number }>,
    dur: number,
  ): void {
    if (!ids.length) {
      return fit(dur);
    }
    let minx = 1e9;
    let miny = 1e9;
    let maxx = -1e9;
    let maxy = -1e9;
    ids.forEach(function (id) {
      const p = src[id];
      if (!p) return;
      minx = Math.min(minx, p.x);
      miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x + NODE_W);
      maxy = Math.max(maxy, p.y + NODE_H);
    });
    frameBox(minx, miny, maxx, maxy, dur, true);
  }
  function fit(dur: number): void {
    frameBox(PAD, PAD, layW - PAD, layH - PAD, dur, false);
  }
  function zoomAt(cx: number, cy: number, factor: number): void {
    const nk = clamp(view.k * factor, 0.08, 3);
    view.tx = cx - (cx - view.tx) * (nk / view.k);
    view.ty = cy - (cy - view.ty) * (nk / view.k);
    view.k = nk;
    applyView();
  }
  svg.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false },
  );
  let dragging = false;
  let dragMoved = false;
  let sx = 0;
  let sy = 0;
  let otx = 0;
  let oty = 0;
  svg.addEventListener("mousedown", function (e) {
    dragging = true;
    dragMoved = false;
    sx = e.clientX;
    sy = e.clientY;
    otx = view.tx;
    oty = view.ty;
    svg.classList.add("grabbing");
  });
  window.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
    view.tx = otx + dx;
    view.ty = oty + dy;
    applyView();
  });
  window.addEventListener("mouseup", function () {
    dragging = false;
    svg.classList.remove("grabbing");
  });
  svg.addEventListener("click", function (e) {
    if ((e.target === svg || e.target === vp) && !dragMoved && state.sel) unfocus();
  });
  el("fit").onclick = function () {
    if (state.sel) unfocus();
    else fit(420);
  };
  el("zin").onclick = function () {
    zoomAt(vw() / 2, vh() / 2, 1.2);
  };
  el("zout").onclick = function () {
    zoomAt(vw() / 2, vh() / 2, 1 / 1.2);
  };
  function compactTargets(lin: Set<string>): Record<string, { x: number; y: number }> {
    const cols: Record<number, string[]> = {};
    lin.forEach(function (id) {
      const column = required(colOf[id], `column ${id}`);
      (cols[column] = cols[column] || []).push(id);
    });
    const selectedId = state.sel;
    if (selectedId === null) throw new Error("dashboard has no selected node");
    const centerY = required(basePos[selectedId], `position ${selectedId}`).y + NODE_H / 2;
    const targets: Record<string, { x: number; y: number }> = {};
    Object.keys(cols).forEach(function (c) {
      const arr = required(cols[Number(c)], `column ${c}`).sort(function (a, b) {
        return required(basePos[a], `position ${a}`).y - required(basePos[b], `position ${b}`).y;
      });
      const startY = centerY - ((arr.length - 1) / 2) * ROWY - NODE_H / 2;
      arr.forEach(function (id, i) {
        targets[id] = { x: required(basePos[id], `position ${id}`).x, y: startY + i * ROWY };
      });
    });
    return targets;
  }
  function sortNodes(arr: AnyNode[]): AnyNode[] {
    const s = state.sort;
    return arr.slice().sort(function (a, b) {
      if (s === "id") return a.id.localeCompare(b.id);
      if (s === "deps")
        return b.dependents.length - a.dependents.length || a.id.localeCompare(b.id);
      if (s === "blocked")
        return b.blockedBy.length - a.blockedBy.length || a.id.localeCompare(b.id);
      if (s === "status")
        return String(a.status).localeCompare(String(b.status)) || a.id.localeCompare(b.id);
      return (
        (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9) ||
        (TRANK[a.target] ?? 9) - (TRANK[b.target] ?? 9) ||
        String(a.parallelGroup).localeCompare(String(b.parallelGroup)) ||
        a.id.localeCompare(b.id)
      );
    });
  }
  function renderList(): void {
    const matching = nodes.filter(passes);
    const arr = sortNodes(state.sel ? nodes : matching);
    el("lh_count").textContent = matching.length + " / " + nodes.length;
    if (!arr.length) {
      el("rows").innerHTML = '<div class="empty">No nodes match.</div>';
      return;
    }
    const lin = state.sel ? lineageSet() : null;
    el("rows").innerHTML = arr
      .map(function (n) {
        const sel = n.id === state.sel ? " sel" : "";
        const dim = (state.sel ? !(lin as Set<string>).has(n.id) : anyFilter() && !passes(n))
          ? " dim"
          : "";
        return (
          '<div class="row' +
          sel +
          dim +
          '" data-id="' +
          esc(n.id) +
          '"><span class="id">' +
          esc(n.id) +
          "</span>" +
          '<span class="pr ' +
          n.priority +
          '">' +
          n.priority +
          "</span>" +
          '<span class="sdot" title="' +
          statusLabel(n) +
          '" style="background:' +
          statusColor(n) +
          '"></span>' +
          '<span class="tt">' +
          esc(n.title) +
          "</span>" +
          (n.issues.length ? '<span class="warn">⚠</span>' : "") +
          "</div>"
        );
      })
      .join("");
    Array.prototype.forEach.call(el("rows").querySelectorAll(".row"), function (r: HTMLElement) {
      r.onclick = function () {
        select(r.dataset.id as string);
      };
    });
  }
  let frameTimer = 0 as unknown as ReturnType<typeof setTimeout>;
  function apply(reframe: boolean): void {
    if (state.sel) {
      unfocus(true);
    }
    renderList();
    styleGraph();
    if (reframe) {
      clearTimeout(frameTimer);
      frameTimer = setTimeout(function () {
        if (anyFilter()) {
          const ids = nodes.filter(passes).map(function (n) {
            return n.id;
          });
          frameIds(ids, basePos, 460);
        } else fit(460);
      }, 240);
    }
  }
  function linkChip(id: string): string {
    const n = byId[id];
    if (!n) return '<span class="lk" style="opacity:.6">' + esc(id) + " (missing)</span>";
    return (
      '<span class="lk" data-go="' +
      esc(id) +
      '"><span class="sdot" style="background:' +
      statusColor(n) +
      '"></span>' +
      esc(id) +
      "</span>"
    );
  }
  function detailHtml(n: AnyNode): string {
    function ul(a: string[] | undefined): string {
      return a && a.length
        ? '<ul class="cl">' +
            a
              .map(function (x) {
                return "<li>" + esc(x) + "</li>";
              })
              .join("") +
            "</ul>"
        : '<div class="summary" style="color:var(--muted)">none</div>';
    }
    const ver =
      (n.verification || [])
        .map(function (v) {
          return (
            '<div class="verline"><span class="vt">' +
            esc(v.type) +
            ":</span> " +
            esc(v.value) +
            "</div>"
          );
        })
        .join("") || '<div class="summary" style="color:var(--muted)">none</div>';
    const blk = n.blockedBy.length
      ? '<div class="sub">Blocked by (incomplete deps)</div><div class="linkchips">' +
        n.blockedBy.map(linkChip).join("") +
        "</div>"
      : "";
    const iss = n.issues.length
      ? '<div class="sub">Validation issues</div><div class="issues">' +
        n.issues
          .map(function (i) {
            return '<div class="it">⚠ ' + esc(i) + "</div>";
          })
          .join("") +
        "</div>"
      : "";
    return (
      '<div class="did">' +
      esc(n.id) +
      "</div><h2>" +
      esc(n.title) +
      "</h2>" +
      '<div class="chips"><span class="chip"><b>' +
      statusLabel(n) +
      '</b></span><span class="chip">priority <b>' +
      esc(n.priority) +
      '</b></span><span class="chip">target <b>' +
      esc(n.target) +
      '</b></span><span class="chip">group <b>' +
      esc(n.parallelGroup) +
      "</b></span></div>" +
      '<div class="lineage"><span><b>' +
      (curAnc as Set<string>).size +
      "</b> upstream</span><span><b>" +
      (curDesc as Set<string>).size +
      "</b> downstream</span><span><b>" +
      n.dependents.length +
      "</b> direct dependents</span></div>" +
      '<div class="sub">Summary</div><div class="summary">' +
      esc(n.summary || "—") +
      "</div>" +
      '<div class="sub">Deliverables</div>' +
      ul(n.deliverables) +
      '<div class="sub">Acceptance criteria</div>' +
      ul(n.acceptanceCriteria) +
      '<div class="sub">Verification</div>' +
      ver +
      '<div class="sub">Audit focus</div>' +
      ul(n.auditFocus) +
      '<div class="sub">Depends on (' +
      (n.dependsOn || []).length +
      ')</div><div class="linkchips">' +
      ((n.dependsOn || []).map(linkChip).join("") ||
        '<span class="summary" style="color:var(--muted)">none — root</span>') +
      "</div>" +
      '<div class="sub">Dependents (' +
      n.dependents.length +
      ')</div><div class="linkchips">' +
      (n.dependents.map(linkChip).join("") ||
        '<span class="summary" style="color:var(--muted)">none — leaf</span>') +
      "</div>" +
      blk +
      iss
    );
  }
  function openDetail(n: AnyNode): void {
    el("dscroll").innerHTML =
      detailHtml(n) +
      '<div class="copybar"><textarea class="notes" id="notes" placeholder="Optional: what is off / the change you want…"></textarea>' +
      '<div class="cbtns"><button class="cbtn main" id="copyfull">Copy for agent</button><button class="cbtn alt" id="copyid">Copy id</button></div></div>';
    el("detail").classList.add("open");
    Array.prototype.forEach.call(
      el("dscroll").querySelectorAll("[data-go]"),
      function (g: HTMLElement) {
        g.onclick = function () {
          select(g.getAttribute("data-go") as string);
        };
      },
    );
    el("copyid").onclick = function () {
      copy(n.id, "Copied " + n.id);
    };
    el("copyfull").onclick = function () {
      copy(
        agentBlock(n, (el("notes") as HTMLTextAreaElement).value),
        "Copied agent block for " + n.id,
      );
    };
    el("dscroll").scrollTop = 0;
  }
  function select(id: string): void {
    const n = byId[id];
    if (!n) return;
    state.sel = id;
    curAnc = ancestors(id);
    curDesc = descendants(id);
    el("ghint").style.opacity = "0";
    const lin = lineageSet();
    lin.forEach(function (lid) {
      if (nodeEls[lid]) el("vp").appendChild(nodeEls[lid]);
    });
    const targets = compactTargets(lin);
    Object.keys(movedIds).forEach(function (mid) {
      if (!targets[mid]) {
        const position = required(basePos[mid], `position ${mid}`);
        targets[mid] = { x: position.x, y: position.y };
      }
    });
    movedIds = {};
    Object.keys(targets).forEach(function (t) {
      if (required(targets[t], `target ${t}`).y !== required(basePos[t], `position ${t}`).y)
        movedIds[t] = 1;
    });
    styleGraph();
    renderList();
    openDetail(n);
    animateNodes(targets, 360);
    frameIds(Array.from(lin), targets, 460);
  }
  function unfocus(silent?: boolean): void {
    if (!state.sel) {
      if (!silent) fit(420);
      return;
    }
    const targets: Record<string, { x: number; y: number }> = {};
    Object.keys(movedIds).forEach(function (mid) {
      const position = required(basePos[mid], `position ${mid}`);
      targets[mid] = { x: position.x, y: position.y };
    });
    movedIds = {};
    state.sel = null;
    curAnc = null;
    curDesc = null;
    el("detail").classList.remove("open");
    el("ghint").style.opacity = "1";
    animateNodes(targets, 320);
    styleGraph();
    renderList();
    if (!silent) fit(440);
  }
  el("dclose").onclick = function () {
    unfocus();
  };
  el("unfocus").onclick = function () {
    unfocus();
  };
  function showTip(id: string, e: MouseEvent): void {
    const n = byId[id];
    if (n === undefined) return;
    el("gtip").innerHTML =
      '<div class="gi">' +
      esc(n.id) +
      " · " +
      statusLabel(n) +
      " · " +
      esc(n.priority) +
      "</div>" +
      esc(n.title);
    el("gtip").style.display = "block";
    moveTip(e);
  }
  function moveTip(e: MouseEvent): void {
    const r = el("graphwrap").getBoundingClientRect();
    const t = el("gtip");
    let x = e.clientX - r.left + 14;
    const y = e.clientY - r.top + 14;
    if (x + 290 > r.width) x = e.clientX - r.left - 290;
    t.style.left = x + "px";
    t.style.top = y + "px";
  }
  function hideTip(): void {
    el("gtip").style.display = "none";
  }
  function agentBlock(n: AnyNode, note: string): string {
    function list(label: string, a: string[] | undefined): string {
      if (!a || !a.length) return label + ":\n- (none)\n";
      return (
        label +
        ":\n" +
        a
          .map(function (x) {
            return "- " + x;
          })
          .join("\n") +
        "\n"
      );
    }
    const deps = (n.dependsOn || []).map(function (id) {
      const dn = byId[id];
      return id + (dn ? " (" + dn.status + ")" : " (missing)");
    });
    const ver =
      (n.verification || [])
        .map(function (v) {
          return "- " + v.type + ": " + v.value;
        })
        .join("\n") || "- (none)";
    let out =
      "Spec node " +
      n.id +
      " — " +
      n.title +
      "\nSource: roadmap/spec-dag.json\n" +
      "Status: " +
      n.status +
      (n.ready ? " (ready)" : "") +
      " | Priority: " +
      n.priority +
      " | Target: " +
      n.target +
      " | Group: " +
      n.parallelGroup +
      "\n" +
      "Projects: " +
      ((n.projects || []).join(", ") || "—") +
      "\n\nSummary: " +
      (n.summary || "—") +
      "\n\n" +
      list("Deliverables", n.deliverables) +
      "\n" +
      list("Acceptance criteria", n.acceptanceCriteria) +
      "\n" +
      "Verification:\n" +
      ver +
      "\n\n" +
      list("Audit focus", n.auditFocus) +
      "\n" +
      "Depends on: " +
      (deps.join(", ") || "none") +
      "\nDependents: " +
      (n.dependents.join(", ") || "none") +
      "\n";
    if (n.blockedBy.length) out += "Blocked by (incomplete): " + n.blockedBy.join(", ") + "\n";
    if (n.issues.length)
      out +=
        "\nValidation issues flagged by the repo validator:\n" +
        n.issues
          .map(function (i) {
            return "- " + i;
          })
          .join("\n") +
        "\n";
    if (note && note.trim()) out += "\nWhat is off / requested change:\n" + note.trim() + "\n";
    return out;
  }
  function copy(text: string, msg: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast(msg);
        },
        function () {
          fb(text, msg);
        },
      );
    } else fb(text, msg);
  }
  function fb(text: string, msg: string): void {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(msg);
    } catch {
      toast("Copy failed");
    }
    document.body.removeChild(ta);
  }
  let tt: ReturnType<typeof setTimeout>;
  function toast(msg: string): void {
    const t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(tt);
    tt = setTimeout(function () {
      t.classList.remove("show");
    }, 1600);
  }
  function openIssues(): void {
    const body = el("modalbody");
    const perNode = nodes.filter(function (n) {
      return n.issues.length;
    });
    let html = "<h3>Validation issues (" + DATA.errorCount + ")</h3>";
    if (DATA.globalIssues.length)
      html +=
        '<div class="sub">Graph-level</div>' +
        DATA.globalIssues
          .map(function (i) {
            return '<div class="gi">⚠ ' + esc(i) + "</div>";
          })
          .join("");
    if (perNode.length)
      html +=
        '<div class="sub">By node</div>' +
        perNode
          .map(function (n) {
            return (
              '<div class="gi" style="cursor:pointer" data-go="' +
              esc(n.id) +
              '"><b style="color:#fff">' +
              esc(n.id) +
              "</b> — " +
              esc(n.issues.join(" · ")) +
              "</div>"
            );
          })
          .join("");
    if (!DATA.globalIssues.length && !perNode.length)
      html += '<div class="gi" style="color:var(--done)">No issues. The DAG validates clean.</div>';
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll("[data-go]"), function (g: HTMLElement) {
      g.onclick = function () {
        closeModal();
        select(g.getAttribute("data-go") as string);
      };
    });
    el("modal").classList.add("show");
  }
  function closeModal(): void {
    el("modal").classList.remove("show");
  }
  el("modalclose").onclick = closeModal;
  el("modal").onclick = function (e) {
    if (e.target === el("modal")) closeModal();
  };
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== el("q")) {
      e.preventDefault();
      el("q").focus();
    }
    if (e.key === "Escape") {
      if (el("modal").classList.contains("show")) closeModal();
      else if (state.sel) unfocus();
    }
    if (e.key === "f" && document.activeElement !== el("q")) {
      if (state.sel) unfocus();
      else fit(420);
    }
  });
  layout();
  renderGraph();
  renderList();
  styleGraph();
  fit(0);
  setTimeout(function () {
    fit(0);
  }, 40);
})();
