import type {
  AssetDecisionRecord,
  AssetLocalizationDecisionAssetKind,
  AssetLocalizationDecisionPolicy,
} from "@itotori/db";
import { assetLocalizationDecisionAssetKindList } from "@itotori/db";

/**
 * The dashboard route handled by this module:
 *   - /projects/:projectId/locale-branches/:localeBranchId/asset-decisions
 *   - /projects/:projectId/locale-branches/:localeBranchId/asset-decisions/batch
 *
 * The pathname patterns are deliberately stable so the SPA bootstrap
 * (apps/itotori/src/main.ts) can dispatch to {@link renderAssetDecisionsRoute}.
 */
export const assetDecisionsRoutePathRegex =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/asset-decisions(\/batch)?$/u;

export type AssetDecisionsRouteParams = {
  projectId: string;
  localeBranchId: string;
  view: "policy" | "batch";
};

export type AssetDecisionsViewData = {
  params: AssetDecisionsRouteParams;
  decisions: AssetDecisionRecord[];
  candidateAssets: CandidateAsset[];
};

export type CandidateAsset = {
  assetRef: { kind: string; ref: string };
  assetKind: AssetLocalizationDecisionAssetKind;
  displayLabel?: string;
};

export function parseAssetDecisionsRoute(pathname: string): AssetDecisionsRouteParams | null {
  const match = assetDecisionsRoutePathRegex.exec(pathname);
  if (match === null) {
    return null;
  }
  const projectId = match[1];
  const localeBranchId = match[2];
  if (projectId === undefined || localeBranchId === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(projectId),
    localeBranchId: decodeURIComponent(localeBranchId),
    view: match[3] === "/batch" ? "batch" : "policy",
  };
}

export function renderAssetDecisionsView(data: AssetDecisionsViewData): string {
  if (data.params.view === "batch") {
    return renderBatchView(data);
  }
  return renderPolicyView(data);
}

function renderPolicyView(data: AssetDecisionsViewData): string {
  const { params, decisions } = data;
  if (decisions.length === 0) {
    return renderShell(
      params,
      "policy",
      `
        <section class="state-panel" aria-label="No asset decisions recorded">
          <h2>No decisions recorded yet</h2>
          <p>
            No asset-localization decisions have been recorded for
            <code>${escapeHtml(params.localeBranchId)}</code>. Use the
            <a href="${escapeHtml(batchPath(params))}">candidate-assets batch view</a>
            to inspect the assets that do not yet have a recorded decision.
          </p>
        </section>
      `,
    );
  }
  const groups = groupByKind(decisions);
  const sections = Array.from(groups.entries())
    .map(
      ([assetKind, group]) => `
        <section class="decision-kind-section" aria-label="${escapeHtml(assetKindLabel(assetKind))}">
          <h3>${escapeHtml(assetKindLabel(assetKind))} (${group.length})</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Policy</th>
                <th scope="col">Rationale</th>
                <th scope="col">Decided by</th>
                <th scope="col">Decided at</th>
              </tr>
            </thead>
            <tbody>
              ${group.map(renderDecisionRow).join("")}
            </tbody>
          </table>
        </section>
      `,
    )
    .join("");
  return renderShell(params, "policy", sections);
}

function renderDecisionRow(record: AssetDecisionRecord): string {
  return `
    <tr data-decision-id="${escapeHtml(record.decisionId)}">
      <td><code>${escapeHtml(record.assetRef.ref)}</code></td>
      <td>${policyBadge(record.decisionPolicy)}</td>
      <td>${escapeHtml(record.decisionRationale ?? "—")}</td>
      <td>${escapeHtml(record.decidedByUserId ?? "(unknown)")}</td>
      <td><time datetime="${record.decidedAt.toISOString()}">${escapeHtml(record.decidedAt.toISOString())}</time></td>
    </tr>
  `;
}

function renderBatchView(data: AssetDecisionsViewData): string {
  const { params, candidateAssets } = data;
  if (candidateAssets.length === 0) {
    return renderShell(
      params,
      "batch",
      `
        <section class="state-panel" aria-label="No candidate assets">
          <h2>No undecided candidate assets</h2>
          <p>
            Every candidate asset for
            <code>${escapeHtml(params.localeBranchId)}</code>
            already has a recorded decision. Return to the
            <a href="${escapeHtml(policyPath(params))}">policy view</a>
            to review them.
          </p>
        </section>
      `,
    );
  }
  const grouped = groupCandidatesByKind(candidateAssets);
  const sections = Array.from(grouped.entries())
    .map(
      ([assetKind, candidates]) => `
        <section class="candidate-kind-section" aria-label="${escapeHtml(assetKindLabel(assetKind))}">
          <h3>${escapeHtml(assetKindLabel(assetKind))} (${candidates.length})</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Label</th>
              </tr>
            </thead>
            <tbody>
              ${candidates
                .map(
                  (candidate) => `
                    <tr>
                      <td><code>${escapeHtml(candidate.assetRef.ref)}</code></td>
                      <td>${escapeHtml(candidate.displayLabel ?? "—")}</td>
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </section>
      `,
    )
    .join("");
  return renderShell(params, "batch", sections);
}

function renderShell(
  params: AssetDecisionsRouteParams,
  active: "policy" | "batch",
  body: string,
): string {
  return `
    ${assetDecisionsStyles()}
    <main class="itotori-shell" data-state="asset-decisions" data-view="${escapeHtml(active)}">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Asset localization decisions</p>
          <h1>${escapeHtml(params.localeBranchId)}</h1>
          <p class="subhead">Project: <code>${escapeHtml(params.projectId)}</code></p>
        </div>
        <nav class="asset-decisions-nav" aria-label="Asset decisions views">
          <a class="${active === "policy" ? "active" : ""}" href="${escapeHtml(policyPath(params))}">
            Active decisions
          </a>
          <a class="${active === "batch" ? "active" : ""}" href="${escapeHtml(batchPath(params))}">
            Candidate assets
          </a>
        </nav>
      </header>
      ${body}
    </main>
  `;
}

function policyBadge(policy: AssetLocalizationDecisionPolicy): string {
  const tone = policy === "skip" || policy === "keep_original" ? "neutral" : "translate";
  return `<span class="badge badge-${tone}">${escapeHtml(policyLabel(policy))}</span>`;
}

function policyLabel(policy: AssetLocalizationDecisionPolicy): string {
  switch (policy) {
    case "keep_original":
      return "Keep original";
    case "translate_text":
      return "Translate text";
    case "swap_with_replacement":
      return "Swap with replacement";
    case "romanize":
      return "Romanize";
    case "full_localize":
      return "Full localize";
    case "skip":
      return "Skip";
  }
}

function assetKindLabel(kind: AssetLocalizationDecisionAssetKind): string {
  switch (kind) {
    case "image_with_text":
      return "Image with text";
    case "song_title":
      return "Song title";
    case "ui_art":
      return "UI art";
    case "font":
      return "Font";
    case "video":
      return "Video";
    case "romanization":
      return "Romanization";
    case "full_localization":
      return "Full localization";
    case "do_not_translate":
      return "Do not translate";
  }
}

function groupByKind(
  decisions: AssetDecisionRecord[],
): Map<AssetLocalizationDecisionAssetKind, AssetDecisionRecord[]> {
  const buckets = new Map<AssetLocalizationDecisionAssetKind, AssetDecisionRecord[]>();
  for (const kind of assetLocalizationDecisionAssetKindList) {
    const matching = decisions.filter((record) => record.assetKind === kind);
    if (matching.length > 0) {
      buckets.set(kind, matching);
    }
  }
  return buckets;
}

function groupCandidatesByKind(
  candidates: CandidateAsset[],
): Map<AssetLocalizationDecisionAssetKind, CandidateAsset[]> {
  const buckets = new Map<AssetLocalizationDecisionAssetKind, CandidateAsset[]>();
  for (const kind of assetLocalizationDecisionAssetKindList) {
    const matching = candidates.filter((candidate) => candidate.assetKind === kind);
    if (matching.length > 0) {
      buckets.set(kind, matching);
    }
  }
  return buckets;
}

function policyPath(params: AssetDecisionsRouteParams): string {
  return `/projects/${encodeURIComponent(params.projectId)}/locale-branches/${encodeURIComponent(params.localeBranchId)}/asset-decisions`;
}

function batchPath(params: AssetDecisionsRouteParams): string {
  return `${policyPath(params)}/batch`;
}

function assetDecisionsStyles(): string {
  return `
    <style>
      .asset-decisions-nav {
        display: flex;
        gap: 12px;
      }
      .asset-decisions-nav a {
        padding: 6px 12px;
        border-radius: 999px;
        background: #eef3f7;
        color: #1f2933;
        text-decoration: none;
        font-weight: 600;
      }
      .asset-decisions-nav a.active {
        background: #2f7d68;
        color: #fff;
      }
      .decision-kind-section,
      .candidate-kind-section {
        margin-top: 24px;
      }
      .badge {
        display: inline-flex;
        max-width: 100%;
        min-height: 24px;
        align-items: center;
        border-radius: 999px;
        padding: 0 8px;
        font-size: 0.78rem;
        font-weight: 800;
      }
      .badge-neutral {
        background: #eef3f7;
        color: #26333c;
      }
      .badge-translate {
        background: #d6efe6;
        color: #1f5b48;
      }
    </style>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const _internalsForTests = {
  policyPath,
  batchPath,
};
