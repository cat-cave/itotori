import type { DashboardData } from "./client-types.js";
import type { AnyNode } from "./dashboard-types.js";

interface ElementLookup {
  (id: string): HTMLElement;
  <T extends Element>(id: string, expected: abstract new () => T): T;
}

export function createDetailController(input: {
  byId: Record<string, AnyNode>;
  data: DashboardData;
  el: ElementLookup;
  esc: (value: unknown) => string;
  getLineageCounts: () => { ancestors: number; descendants: number };
  nodes: AnyNode[];
  select: (id: string) => void;
  statusColor: (node: AnyNode) => string;
  statusLabel: (node: AnyNode) => string;
}): { openDetail: (node: AnyNode) => void; openIssues: () => void } {
  function linkChip(id: string): string {
    const node = input.byId[id];
    if (!node) return '<span class="lk" style="opacity:.6">' + input.esc(id) + " (missing)</span>";
    return (
      '<span class="lk" data-go="' +
      input.esc(id) +
      '"><span class="sdot" style="background:' +
      input.statusColor(node) +
      '"></span>' +
      input.esc(id) +
      "</span>"
    );
  }
  function list(values: string[] | undefined): string {
    return values && values.length
      ? '<ul class="cl">' +
          values
            .map(function (value) {
              return "<li>" + input.esc(value) + "</li>";
            })
            .join("") +
          "</ul>"
      : '<div class="summary" style="color:var(--muted)">none</div>';
  }
  function detailHtml(node: AnyNode): string {
    const lineage = input.getLineageCounts();
    const verification =
      (node.verification || [])
        .map(function (entry) {
          return (
            '<div class="verline"><span class="vt">' +
            input.esc(entry.type) +
            ":</span> " +
            input.esc(entry.value) +
            "</div>"
          );
        })
        .join("") || '<div class="summary" style="color:var(--muted)">none</div>';
    const blocked = node.blockedBy.length
      ? '<div class="sub">Blocked by (incomplete deps)</div><div class="linkchips">' +
        node.blockedBy.map(linkChip).join("") +
        "</div>"
      : "";
    const issues = node.issues.length
      ? '<div class="sub">Validation issues</div><div class="issues">' +
        node.issues
          .map(function (issue) {
            return '<div class="it">⚠ ' + input.esc(issue) + "</div>";
          })
          .join("") +
        "</div>"
      : "";
    return (
      '<div class="did">' +
      input.esc(node.id) +
      "</div><h2>" +
      input.esc(node.title) +
      "</h2>" +
      '<div class="chips"><span class="chip"><b>' +
      input.statusLabel(node) +
      '</b></span><span class="chip">priority <b>' +
      input.esc(node.priority) +
      '</b></span><span class="chip">target <b>' +
      input.esc(node.target) +
      '</b></span><span class="chip">group <b>' +
      input.esc(node.parallelGroup) +
      "</b></span></div>" +
      '<div class="lineage"><span><b>' +
      lineage.ancestors +
      "</b> upstream</span><span><b>" +
      lineage.descendants +
      "</b> downstream</span><span><b>" +
      node.dependents.length +
      "</b> direct dependents</span></div>" +
      '<div class="sub">Summary</div><div class="summary">' +
      input.esc(node.summary || "—") +
      "</div>" +
      '<div class="sub">Deliverables</div>' +
      list(node.deliverables) +
      '<div class="sub">Acceptance criteria</div>' +
      list(node.acceptanceCriteria) +
      '<div class="sub">Verification</div>' +
      verification +
      '<div class="sub">Audit focus</div>' +
      list(node.auditFocus) +
      '<div class="sub">Depends on (' +
      (node.dependsOn || []).length +
      ')</div><div class="linkchips">' +
      ((node.dependsOn || []).map(linkChip).join("") ||
        '<span class="summary" style="color:var(--muted)">none — root</span>') +
      "</div>" +
      '<div class="sub">Dependents (' +
      node.dependents.length +
      ')</div><div class="linkchips">' +
      (node.dependents.map(linkChip).join("") ||
        '<span class="summary" style="color:var(--muted)">none — leaf</span>') +
      "</div>" +
      blocked +
      issues
    );
  }
  function agentBlock(node: AnyNode, note: string): string {
    function listed(label: string, values: string[] | undefined): string {
      if (!values || !values.length) return label + ":\n- (none)\n";
      return (
        label +
        ":\n" +
        values
          .map(function (value) {
            return "- " + value;
          })
          .join("\n") +
        "\n"
      );
    }
    const dependencies = (node.dependsOn || []).map(function (id) {
      const dependency = input.byId[id];
      return id + (dependency ? " (" + dependency.status + ")" : " (missing)");
    });
    const verification =
      (node.verification || [])
        .map(function (entry) {
          return "- " + entry.type + ": " + entry.value;
        })
        .join("\n") || "- (none)";
    let output =
      "Spec node " +
      node.id +
      " — " +
      node.title +
      "\nSource: roadmap/spec-dag.json\nStatus: " +
      node.status +
      (node.ready ? " (ready)" : "") +
      " | Priority: " +
      node.priority +
      " | Target: " +
      node.target +
      " | Group: " +
      node.parallelGroup +
      "\nProjects: " +
      ((node.projects || []).join(", ") || "—") +
      "\n\nSummary: " +
      (node.summary || "—") +
      "\n\n" +
      listed("Deliverables", node.deliverables) +
      "\n" +
      listed("Acceptance criteria", node.acceptanceCriteria) +
      "\nVerification:\n" +
      verification +
      "\n\n" +
      listed("Audit focus", node.auditFocus) +
      "\nDepends on: " +
      (dependencies.join(", ") || "none") +
      "\nDependents: " +
      (node.dependents.join(", ") || "none") +
      "\n";
    if (node.blockedBy.length)
      output += "Blocked by (incomplete): " + node.blockedBy.join(", ") + "\n";
    if (node.issues.length)
      output +=
        "\nValidation issues flagged by the repo validator:\n" +
        node.issues
          .map(function (issue) {
            return "- " + issue;
          })
          .join("\n") +
        "\n";
    if (note && note.trim()) output += "\nWhat is off / requested change:\n" + note.trim() + "\n";
    return output;
  }
  let toastTimer: ReturnType<typeof setTimeout>;
  function toast(message: string): void {
    const toastElement = input.el("toast");
    toastElement.textContent = message;
    toastElement.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastElement.classList.remove("show");
    }, 1600);
  }
  function fallbackCopy(text: string, message: string): void {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      toast(message);
    } catch {
      toast("Copy failed");
    }
    document.body.removeChild(textarea);
  }
  function copy(text: string, message: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast(message);
        },
        function () {
          fallbackCopy(text, message);
        },
      );
    } else fallbackCopy(text, message);
  }
  function bindNavigation(host: HTMLElement): void {
    host.querySelectorAll<HTMLElement>("[data-go]").forEach(function (element) {
      const id = element.dataset.go;
      if (id === undefined) throw new Error("dashboard link has no node id");
      element.onclick = function () {
        input.select(id);
      };
    });
  }
  function openDetail(node: AnyNode): void {
    input.el("dscroll").innerHTML =
      detailHtml(node) +
      '<div class="copybar"><textarea class="notes" id="notes" placeholder="Optional: what is off / the change you want…"></textarea><div class="cbtns"><button class="cbtn main" id="copyfull">Copy for agent</button><button class="cbtn alt" id="copyid">Copy id</button></div></div>';
    input.el("detail").classList.add("open");
    bindNavigation(input.el("dscroll"));
    input.el("copyid").onclick = function () {
      copy(node.id, "Copied " + node.id);
    };
    input.el("copyfull").onclick = function () {
      const notes = input.el("notes", HTMLTextAreaElement);
      copy(agentBlock(node, notes.value), "Copied agent block for " + node.id);
    };
    input.el("dscroll").scrollTop = 0;
  }
  function closeModal(): void {
    input.el("modal").classList.remove("show");
  }
  function openIssues(): void {
    const body = input.el("modalbody");
    const nodesWithIssues = input.nodes.filter(function (node) {
      return node.issues.length;
    });
    let markup = "<h3>Validation issues (" + input.data.errorCount + ")</h3>";
    if (input.data.globalIssues.length)
      markup +=
        '<div class="sub">Graph-level</div>' +
        input.data.globalIssues
          .map(function (issue) {
            return '<div class="gi">⚠ ' + input.esc(issue) + "</div>";
          })
          .join("");
    if (nodesWithIssues.length)
      markup +=
        '<div class="sub">By node</div>' +
        nodesWithIssues
          .map(function (node) {
            return (
              '<div class="gi" style="cursor:pointer" data-go="' +
              input.esc(node.id) +
              '"><b style="color:#fff">' +
              input.esc(node.id) +
              "</b> — " +
              input.esc(node.issues.join(" · ")) +
              "</div>"
            );
          })
          .join("");
    if (!input.data.globalIssues.length && !nodesWithIssues.length)
      markup +=
        '<div class="gi" style="color:var(--done)">No issues. The DAG validates clean.</div>';
    body.innerHTML = markup;
    body.querySelectorAll<HTMLElement>("[data-go]").forEach(function (element) {
      const id = element.dataset.go;
      if (id === undefined) throw new Error("dashboard issue link has no node id");
      element.onclick = function () {
        closeModal();
        input.select(id);
      };
    });
    input.el("modal").classList.add("show");
  }
  input.el("modalclose").onclick = closeModal;
  input.el("modal").onclick = function (event) {
    if (event.target === input.el("modal")) closeModal();
  };
  return { openDetail, openIssues };
}
