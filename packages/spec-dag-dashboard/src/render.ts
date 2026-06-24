// Pure HTML renderer for the dashboard. The <style> block and body markup are
// copied VERBATIM from spec-dag-dashboard.reference.mjs to preserve the UX; the
// only additions are the provenance banner element (#provbanner), a small
// .provbanner CSS variant consistent with the existing .badwarn styling, and
// the alpha-gate-5 audit-findings banner + per-node finding badges.
//
// renderHtml takes the serializable data and the already-bundled client JS and
// stitches them into one self-contained document. The embedded `var DATA`
// has `<` escaped to `<` so the JSON can never close the <script> early.

import type { DashboardData } from "./types.js";

export function renderHtml(data: DashboardData, clientJs: string): string {
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const auditFindingsBannerHtml = renderAuditFindingsBanner(data);
  const auditFindingsServerOpenList = renderAuditFindingsServerHtml(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spec DAG dashboard</title>
<style>
  :root{
    --bg:#06070f;--panel:rgba(255,255,255,.04);--line:rgba(255,255,255,.10);
    --ink:#eef1ff;--muted:#8a92b8;--dim:#5b6184;
    --done:#3ee08f;--ready:#ffc24a;--prog:#b89bff;--planned:#7782b0;--blocked:#ff5d73;--cancelled:#6b7088;
    --accent:#28e0c0;--bad:#ff5d73;
    --p0:#ff5d73;--p1:#ffa53d;--p2:#5fb2ff;--p3:#9aa0c4;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--ink);
    font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  code,.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .app{display:grid;grid-template-rows:auto 1fr;height:100vh}

  .topbar{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line);
    background:rgba(8,9,18,.92);flex-wrap:wrap;z-index:30}
  .topbar h1{font-size:14px;margin:0 6px 0 0;font-weight:700}
  .topbar .sep{width:1px;height:20px;background:var(--line)}
  .search{background:#0b0e22;border:1px solid var(--line);border-radius:8px;color:var(--ink);padding:7px 10px;font-size:12.5px;width:200px}
  .search:focus{outline:none;border-color:var(--accent)}
  .pills{display:flex;gap:5px}
  .pl{font-size:11px;padding:5px 9px;border-radius:7px;border:1px solid var(--line);color:var(--muted);cursor:pointer;user-select:none;display:flex;align-items:center;gap:5px}
  .pl .sw{width:8px;height:8px;border-radius:2px}
  .pl.on{color:#fff;border-color:var(--accent);background:rgba(40,224,192,.12)}
  details.dd{position:relative} details.dd>summary{list-style:none;cursor:pointer;font-size:11px;padding:5px 9px;border:1px solid var(--line);border-radius:7px;color:var(--muted)}
  details.dd>summary::-webkit-details-marker{display:none}
  details.dd[open]>summary{color:#fff;border-color:var(--accent)}
  .ddmenu{position:absolute;top:30px;left:0;background:#0c0f22;border:1px solid var(--line);border-radius:9px;padding:8px;min-width:178px;max-height:260px;overflow:auto;z-index:40;box-shadow:0 18px 50px -20px #000}
  .chk{display:flex;align-items:center;gap:7px;font-size:12px;color:#cdd3f2;padding:3px 4px;cursor:pointer;white-space:nowrap}
  .chk input{accent-color:var(--accent)} .chk .ct{margin-left:auto;font-size:10.5px;color:var(--dim)}
  .tg{font-size:11px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:5px;user-select:none}
  .tg input{accent-color:var(--accent)}
  .clearbtn{font-size:11px;color:var(--muted);cursor:pointer;background:none;border:1px solid var(--line);border-radius:7px;padding:5px 9px}
  .spacer{flex:1}
  .stat{font-size:11.5px;color:var(--muted)} .stat b{color:var(--ink)}
  .badwarn{font-size:11.5px;font-weight:700;padding:5px 10px;border-radius:8px}
  .badwarn.ok{color:#03150d;background:var(--done)} .badwarn.err{color:#2a0608;background:var(--bad);cursor:pointer}
  .provbanner{font-size:11.5px;font-weight:600;padding:5px 10px;border-radius:8px;color:var(--muted);
    border:1px solid var(--line);font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .provbanner.ok{color:#03150d;background:var(--done);border-color:transparent}
  .provbanner.warn{color:#2a0608;background:var(--bad);border-color:transparent}
  .auditbanner{font-size:11.5px;font-weight:600;padding:5px 10px;border-radius:8px;color:var(--muted);
    border:1px solid var(--line);font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .auditbanner.ok{color:#03150d;background:var(--done);border-color:transparent}
  .auditbanner.warn{color:#2a0608;background:var(--bad);border-color:transparent}
  .auditbanner.disabled{color:var(--muted)}
  .row .findings{display:flex;gap:3px;flex:none}
  .findings .fb{font:700 9px monospace;padding:1px 5px;border-radius:4px}
  .findings .fb.P0{color:#2a0608;background:var(--p0)}
  .findings .fb.P1{color:#2a1400;background:var(--p1)}
  .findings .fb.P2{color:#04223f;background:var(--p2)}
  .findings .fb.P3{color:#15172a;background:var(--p3)}
  #audit-findings-server-fallback{display:none}

  .main{display:grid;grid-template-columns:248px 1fr;min-height:0;position:relative}
  .list{border-right:1px solid var(--line);overflow:auto;height:100%}
  .listhead{display:flex;align-items:center;gap:8px;padding:8px 13px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted);position:sticky;top:0;background:rgba(8,9,18,.95);z-index:5}
  .listhead select{background:#0b0e22;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:3px 6px;font-size:11px;margin-left:auto}
  .row{display:flex;align-items:center;gap:8px;padding:8px 13px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}
  .row:hover{background:rgba(255,255,255,.04)}
  .row.sel{background:rgba(40,224,192,.10);box-shadow:inset 3px 0 0 var(--accent)}
  .row.dim{opacity:.3}
  .row .id{font:600 11px monospace;width:112px;flex:none;color:#cdd3f2}
  .pr{font:700 9px monospace;padding:1px 5px;border-radius:4px;flex:none}
  .pr.P0{color:#2a0608;background:var(--p0)}.pr.P1{color:#2a1400;background:var(--p1)}.pr.P2{color:#04223f;background:var(--p2)}.pr.P3{color:#15172a;background:var(--p3)}
  .sdot{width:9px;height:9px;border-radius:50%;flex:none}
  .row .tt{font-size:12px;color:#dfe3fb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .row .warn{color:var(--bad);font-size:10.5px;flex:none}
  .empty{padding:36px 14px;text-align:center;color:var(--muted);font-size:12.5px}

  .graphwrap{position:relative;overflow:hidden;background:
    radial-gradient(800px 460px at 18% 0%, rgba(40,224,192,.05), transparent 60%),
    radial-gradient(700px 500px at 100% 100%, rgba(139,92,255,.06), transparent 55%), #05060d}
  #svg{width:100%;height:100%;display:block;cursor:grab}
  #svg.grabbing{cursor:grabbing}
  .ntext{font:600 9.5px monospace;pointer-events:none;dominant-baseline:middle}
  .edge{fill:none;stroke:#3a3f63;stroke-width:1}
  .edge.lit{stroke:var(--accent);stroke-width:1.7}
  .edge.litUp{stroke:#ffb65a;stroke-width:1.7}
  .ndg{transition:opacity .18s}
  .ndg.dim{opacity:.09}
  .ndg.sel rect.bx{stroke-width:2.4!important;filter:drop-shadow(0 0 7px var(--accent))}
  .gctl{position:absolute;left:12px;bottom:12px;display:flex;gap:6px;z-index:8}
  .gbtn{background:rgba(12,15,34,.9);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
  .gbtn:hover{border-color:var(--accent)}
  .glegend{position:absolute;right:14px;bottom:12px;display:flex;gap:12px;font-size:11px;color:var(--muted);background:rgba(8,9,18,.7);border:1px solid var(--line);border-radius:9px;padding:7px 11px;z-index:8}
  .glegend .sw{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:-1px}
  .ghint{position:absolute;left:12px;top:12px;font-size:11px;color:var(--dim);z-index:8;transition:opacity .3s}
  .gtip{position:absolute;pointer-events:none;background:#0d1130;border:1px solid var(--line);border-radius:7px;padding:6px 9px;font-size:11.5px;color:#dfe3fb;max-width:280px;z-index:9;display:none;box-shadow:0 12px 36px -16px #000}
  .gtip .gi{font:600 10.5px monospace;color:#9fe9da}

  .detail{position:absolute;top:0;right:0;bottom:0;width:430px;max-width:92vw;background:rgba(9,11,24,.97);
    border-left:1px solid var(--line);transform:translateX(102%);transition:transform .26s cubic-bezier(.4,.1,.2,1);
    z-index:25;display:flex;flex-direction:column;box-shadow:-30px 0 60px -30px #000}
  .detail.open{transform:translateX(0)}
  .dscroll{overflow:auto;flex:1;padding:16px 18px 8px}
  .dclose{position:absolute;top:10px;right:12px;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;z-index:2}
  .dclose:hover{color:#fff}
  .did{font:700 12px monospace;color:#cdd3f2}
  .detail h2{font-size:17px;margin:5px 0 10px;font-weight:750;line-height:1.25;padding-right:18px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
  .chip{font-size:10.5px;padding:4px 8px;border-radius:7px;border:1px solid var(--line);color:#cdd3f2}.chip b{color:#fff}
  .sub{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin:15px 0 6px}
  .summary{font-size:13px;color:#cdd3f2;line-height:1.55}
  ul.cl{margin:0;padding-left:18px;font-size:12.5px;color:#cdd3f2;line-height:1.6}
  .verline{font-family:monospace;font-size:11.5px;background:rgba(8,11,26,.7);border:1px solid var(--line);border-radius:8px;padding:6px 9px;margin:4px 0;color:#bfe9df}
  .verline .vt{color:var(--muted)}
  .linkchips{display:flex;flex-wrap:wrap;gap:6px}
  .lk{font:600 10.5px monospace;border:1px solid var(--line);border-radius:7px;padding:4px 7px;cursor:pointer;display:flex;align-items:center;gap:6px}
  .lk:hover{border-color:var(--accent)} .lk .sdot{width:7px;height:7px}
  .lineage{display:flex;gap:8px;font-size:11.5px;color:var(--muted);margin-top:4px;flex-wrap:wrap}
  .lineage b{color:var(--ink)}
  .issues{border:1px solid rgba(255,93,115,.4);background:rgba(255,93,115,.08);border-radius:10px;padding:9px 11px;margin-top:6px}
  .issues .it{font-size:11.5px;color:#ffd2d8;font-family:monospace;line-height:1.5;padding:2px 0}
  .copybar{border-top:1px solid var(--line);padding:12px 18px;background:rgba(8,9,18,.6)}
  .notes{width:100%;min-height:50px;background:#0b0e22;border:1px solid var(--line);border-radius:9px;color:var(--ink);padding:8px 10px;font-size:12px;resize:vertical;font-family:inherit}
  .notes:focus{outline:none;border-color:var(--accent)}
  .cbtns{display:flex;gap:8px;margin-top:8px}
  .cbtn{flex:1;cursor:pointer;border:none;border-radius:9px;padding:8px 11px;font-weight:700;font-size:12px}
  .cbtn.main{color:#04130f;background:linear-gradient(95deg,var(--accent),#7af0c8)}
  .cbtn.alt{background:rgba(255,255,255,.06);color:var(--ink);border:1px solid var(--line)}
  .cbtn:active{transform:translateY(1px)}

  .toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#0d1130;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:9px 15px;font-size:12.5px;opacity:0;transition:.25s;z-index:60}
  .toast.show{opacity:1}
  .modal{position:fixed;inset:0;background:rgba(3,4,10,.72);display:none;align-items:flex-start;justify-content:center;z-index:80;padding:56px 20px}
  .modal.show{display:flex}
  .modalbox{background:#0a0c1c;border:1px solid var(--line);border-radius:14px;max-width:760px;width:100%;max-height:78vh;overflow:auto;padding:18px 20px}
  .modalbox h3{margin:0 0 6px;font-size:15px}.modalbox .gi{font-family:monospace;font-size:12px;color:#ffd2d8;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06);line-height:1.5}
  .modalbox .close{float:right;cursor:pointer;color:var(--muted);font-size:18px;line-height:1}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <h1>Spec DAG</h1>
    <input class="search" id="q" placeholder="search  ( / )">
    <div class="pills" id="p_status"></div>
    <span class="sep"></span>
    <div class="pills" id="p_priority"></div>
    <span class="sep"></span>
    <div class="pills" id="p_target"></div>
    <details class="dd" id="dd_project"><summary>project</summary><div class="ddmenu" id="m_project"></div></details>
    <details class="dd" id="dd_group"><summary>group</summary><div class="ddmenu" id="m_group"></div></details>
    <label class="tg"><input type="checkbox" id="t_ready"> ready</label>
    <label class="tg"><input type="checkbox" id="t_issues"> issues</label>
    <button class="clearbtn" id="clear">clear</button>
    <span class="spacer"></span>
    ${auditFindingsBannerHtml}
    <span class="provbanner" id="provbanner"></span>
    <span class="stat">nodes <b id="s_nodes">0</b></span>
    <span class="stat">edges <b id="s_edges">0</b></span>
    <span class="stat">ready <b id="s_ready">0</b></span>
    <span class="badwarn" id="s_valid"></span>
  </div>

  <div class="main">
    <div class="list">
      <div class="listhead"><span id="lh_count"></span>
        <select id="sort">
          <option value="rank">priority → target → id</option>
          <option value="id">id</option>
          <option value="deps">most dependents</option>
          <option value="blocked">most blockers</option>
          <option value="status">status</option>
        </select>
      </div>
      <div id="rows"></div>
    </div>

    <div class="graphwrap" id="graphwrap">
      <div class="ghint" id="ghint">drag to pan · scroll to zoom · click a node to trace &amp; frame its lineage</div>
      <svg id="svg"><g id="vp"></g></svg>
      <div class="gtip" id="gtip"></div>
      <div class="gctl">
        <button class="gbtn" id="fit">fit all</button>
        <button class="gbtn" id="zin">+</button>
        <button class="gbtn" id="zout">−</button>
        <button class="gbtn" id="unfocus">clear focus</button>
      </div>
      <div class="glegend">
        <span><span class="sw" style="background:var(--done)"></span>complete</span>
        <span><span class="sw" style="background:var(--prog)"></span>in&nbsp;progress</span>
        <span><span class="sw" style="background:var(--ready)"></span>ready</span>
        <span><span class="sw" style="background:var(--planned)"></span>planned</span>
      </div>

      <div class="detail" id="detail"><span class="dclose" id="dclose">×</span><div class="dscroll" id="dscroll"></div></div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="modal" id="modal"><div class="modalbox"><span class="close" id="modalclose">×</span><div id="modalbody"></div></div></div>

${auditFindingsServerOpenList}
<script>
var DATA = ${dataJson};
</script>
<script>${clientJs}</script>
</body>
</html>`;
}

function renderAuditFindingsBanner(data: DashboardData): string {
  const status = data.auditFindingsStatus;
  if (status.kind === "loaded") {
    return `<span class="auditbanner ok" id="auditbanner">audit findings: ${status.totalOpenFindings} open / ${status.nodesWithFindings} nodes</span>`;
  }
  if (status.kind === "error") {
    const escaped = escapeHtml(status.reason);
    return `<span class="auditbanner warn" id="auditbanner">audit findings could not be loaded: ${escaped}</span>`;
  }
  if (status.kind === "disabled" && status.reason === "database_url_not_set") {
    return `<span class="auditbanner warn" id="auditbanner">DATABASE_URL not set; audit findings not rendered</span>`;
  }
  // flag_not_set: the dashboard ran in its default fixture-less mode.
  return `<span class="auditbanner disabled" id="auditbanner">audit findings: disabled (pass --with-audit-findings to enable)</span>`;
}

/**
 * Server-rendered, hidden-by-default list of every open finding per
 * node. The interactive client reads DATA for the UI; this static
 * fallback gives tests and non-JS readers a stable place to assert
 * that findings made it into the rendered HTML.
 */
function renderAuditFindingsServerHtml(data: DashboardData): string {
  const sections: string[] = [];
  for (const node of data.nodes) {
    const findings = node.findings.openFindings;
    if (findings.length === 0) continue;
    const badges = renderSeverityBadges(node.findings.counts);
    const items = findings
      .map((finding) => {
        const sev = escapeHtml(finding.severity);
        const cat = escapeHtml(finding.category);
        const sum = escapeHtml(finding.summary);
        const ref = finding.fileRef === null ? "" : ` (${escapeHtml(finding.fileRef)})`;
        return `<li data-finding-id="${escapeHtml(finding.auditFindingId)}" data-severity="${sev}"><span class="fb ${sev}">${sev}</span> <span class="cat">${cat}</span>: ${sum}${ref}</li>`;
      })
      .join("");
    sections.push(
      `<section data-node-id="${escapeHtml(node.id)}" class="node-findings">` +
        `<h3>${escapeHtml(node.id)} <span class="findings">${badges}</span></h3>` +
        `<ul>${items}</ul>` +
        `</section>`,
    );
  }
  if (sections.length === 0) {
    return `<div id="audit-findings-server-fallback" data-empty="true"></div>`;
  }
  return `<div id="audit-findings-server-fallback">${sections.join("")}</div>`;
}

function renderSeverityBadges(counts: { P0: number; P1: number; P2: number; P3: number }): string {
  const parts: string[] = [];
  for (const severity of ["P0", "P1", "P2", "P3"] as const) {
    const count = counts[severity];
    if (count > 0) {
      parts.push(
        `<span class="fb ${severity}" title="${severity} findings">${severity}:${count}</span>`,
      );
    }
  }
  return parts.join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
