// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { assetLocalizationDecisionAssetKindValues } from "@itotori/db";
import {
  parseAssetDecisionsRoute,
  renderAssetDecisionsView,
  type AssetDecisionsRouteParams,
  type AssetDecisionsViewData,
  type CandidateAsset,
} from "../src/asset-decisions/dashboard-view.js";
import {
  keepOriginalFixture,
  skipFixture,
  swapWithReplacementFixture,
  translateTextFixture,
} from "../src/asset-decisions/decision-fixtures.js";

const policyParams: AssetDecisionsRouteParams = {
  projectId: "project-fixture",
  localeBranchId: "locale-fixture",
  view: "policy",
};

const batchParams: AssetDecisionsRouteParams = {
  ...policyParams,
  view: "batch",
};

function renderInto(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("parseAssetDecisionsRoute", () => {
  it("recognizes the asset-decisions policy route", () => {
    const params = parseAssetDecisionsRoute(
      "/projects/project-1/locale-branches/locale-1/asset-decisions",
    );
    expect(params).toEqual({
      projectId: "project-1",
      localeBranchId: "locale-1",
      view: "policy",
    });
  });

  it("recognizes the asset-decisions batch route", () => {
    const params = parseAssetDecisionsRoute(
      "/projects/project-1/locale-branches/locale-1/asset-decisions/batch",
    );
    expect(params).toEqual({
      projectId: "project-1",
      localeBranchId: "locale-1",
      view: "batch",
    });
  });

  it("returns null for unrelated routes", () => {
    expect(parseAssetDecisionsRoute("/api/projects")).toBeNull();
    expect(parseAssetDecisionsRoute("/removed-surface")).toBeNull();
  });
});

describe("renderAssetDecisionsView — policy view", () => {
  it("renders the friendly empty state when no decisions exist", () => {
    const view = renderAssetDecisionsView({
      params: policyParams,
      decisions: [],
      candidateAssets: [],
    });
    const root = renderInto(view);
    expect(root.querySelector('[data-state="asset-decisions"]')).not.toBeNull();
    expect(root.textContent).toContain("No decisions recorded yet");
    const candidateLink = root.querySelector('a[href*="/asset-decisions/batch"]');
    expect(candidateLink).not.toBeNull();
  });

  it("groups active decisions by asset kind in a read-only table", () => {
    const decisions = [
      translateTextFixture({
        decisionId: "asset-decision-1",
        assetRef: { kind: "bridgeAssetRef", ref: "asset.json#sign-a" },
      }),
      swapWithReplacementFixture({
        decisionId: "asset-decision-2",
        assetRef: { kind: "bridgeAssetRef", ref: "asset.json#font-a" },
      }),
      skipFixture({
        decisionId: "asset-decision-3",
        assetRef: { kind: "bridgeAssetRef", ref: "asset.json#vid-a" },
      }),
    ];
    const data: AssetDecisionsViewData = {
      params: policyParams,
      decisions,
      candidateAssets: [],
    };
    const root = renderInto(renderAssetDecisionsView(data));

    expect(root.textContent).toContain("Image with text");
    expect(root.textContent).toContain("Font");
    expect(root.textContent).toContain("Video");

    const rows = root.querySelectorAll("tr[data-decision-id]");
    expect(rows).toHaveLength(3);
    expect(root.querySelectorAll("form")).toHaveLength(0);
    expect(root.querySelectorAll("button")).toHaveLength(0);
    expect(root.querySelectorAll("select")).toHaveLength(0);
  });

  it("includes decision rationale and the policy badge in each row", () => {
    const data: AssetDecisionsViewData = {
      params: policyParams,
      decisions: [
        keepOriginalFixture({
          decisionId: "asset-decision-keep",
          decisionRationale: "Logo must be preserved.",
        }),
      ],
      candidateAssets: [],
    };
    const root = renderInto(renderAssetDecisionsView(data));
    expect(root.textContent).toContain("Logo must be preserved.");
    expect(root.querySelector(".badge")).not.toBeNull();
    expect(root.textContent).toContain("Keep original");
  });
});

describe("renderAssetDecisionsView — batch view", () => {
  it("renders the empty state when no candidates remain", () => {
    const view = renderAssetDecisionsView({
      params: batchParams,
      decisions: [],
      candidateAssets: [],
    });
    const root = renderInto(view);
    expect(root.textContent).toContain("No undecided candidate assets");
  });

  it("groups candidate assets by kind in a read-only inventory", () => {
    const candidates: CandidateAsset[] = [
      {
        assetRef: { kind: "bridgeAssetRef", ref: "asset.json#sign-1" },
        assetKind: assetLocalizationDecisionAssetKindValues.imageWithText,
        displayLabel: "Sign 1",
      },
      {
        assetRef: { kind: "bridgeAssetRef", ref: "asset.json#sign-2" },
        assetKind: assetLocalizationDecisionAssetKindValues.imageWithText,
      },
      {
        assetRef: { kind: "bridgeAssetRef", ref: "asset.json#font-x" },
        assetKind: assetLocalizationDecisionAssetKindValues.font,
      },
    ];
    const data: AssetDecisionsViewData = {
      params: batchParams,
      decisions: [],
      candidateAssets: candidates,
    };
    const root = renderInto(renderAssetDecisionsView(data));

    expect(root.textContent).toContain("Sign 1");
    expect(root.textContent).toContain("asset.json#sign-2");
    expect(root.querySelectorAll("form")).toHaveLength(0);
    expect(root.querySelectorAll("button")).toHaveLength(0);
    expect(root.querySelectorAll("input")).toHaveLength(0);
    expect(root.querySelectorAll("select")).toHaveLength(0);
  });
});
