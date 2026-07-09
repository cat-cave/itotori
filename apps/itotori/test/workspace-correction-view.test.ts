// ITOTORI-118 — workspace correction view + route tests.
//
// Pure-render assertions for the batched-correction UI: the preview shows
// source / draft / final + style/glossary/runtime context and only advertises
// the submit form when the actor can manage the queue. The submit itself is a
// native POST to `/api/workspace/corrections` (no SPA render path). The route
// parser maps `/workspace/corrections` to the correction-preview API target.

import { describe, expect, it } from "vitest";
import {
  parseWorkspaceRoute,
  renderWorkspaceCorrectionPreviewView,
  workspaceRouteApiTarget,
  type WorkspaceCorrectionPreviewReadModel,
} from "../src/workspace/index.js";

const managePermission = {
  actorUserId: "reviewer-1",
  canReadQueue: true,
  canManageQueue: true,
  denialReasons: [] as string[],
};

const readOnlyPermission = {
  actorUserId: "reviewer-1",
  canReadQueue: true,
  canManageQueue: false,
  denialReasons: ["user reviewer-1 is missing permission queue.manage"],
};

function previewModel(permission = managePermission): WorkspaceCorrectionPreviewReadModel {
  return {
    schemaVersion: "workspace.correction_preview.v0.1",
    generatedAt: new Date("2026-06-30T00:00:00Z"),
    permission,
    projectId: "project-1",
    localeBranchId: "branch-en",
    sourceBundleId: null,
    targetLocale: "en-US",
    units: [
      {
        reviewItemId: "review-item-1",
        localeBranchId: "branch-en",
        sourceRevisionId: "rev-1",
        bridgeUnitId: "unit-a",
        sourceUnitKey: "scene.1.line.1",
        sourceLocale: "ja-JP",
        sourceText: "源文",
        targetLocale: "en-US",
        draftText: "Draft text.",
        finalText: "Final text.",
        styleGuidePolicyVersionId: "style-v1",
        styleGuidePolicyStatus: "approved",
        glossary: [
          {
            termId: "term-1",
            sourceTerm: "勇者",
            preferredTranslation: "hero",
            status: "approved",
          },
        ],
        runtimeEvidenceLinks: [
          {
            evidenceKind: "screenshot_artifact",
            evidenceTier: "tier-2",
            runtimeTargetId: "target-1",
            observationEventIds: ["obs-1"],
            artifactHashes: ["sha256:abc"],
            providerProofRefs: [],
            summary: "Greeting frame",
          },
        ],
        screenshotArtifactHashes: ["sha256:abc"],
        diagnostics: [],
      },
    ],
    diagnostics: [],
  };
}

describe("renderWorkspaceCorrectionPreviewView", () => {
  it("shows source / draft / final + style + glossary + runtime context and a submit form", () => {
    const html = renderWorkspaceCorrectionPreviewView(previewModel());
    expect(html).toContain('data-side="source"');
    expect(html).toContain('data-side="draft"');
    expect(html).toContain('data-side="final"');
    expect(html).toContain("源文");
    expect(html).toContain("Draft text.");
    expect(html).toContain("Final text.");
    expect(html).toContain("style-v1");
    expect(html).toContain("hero");
    expect(html).toContain("sha256:abc");
    expect(html).toContain('action="/api/workspace/corrections"');
    expect(html).toContain('name="corrections[0].correctedText"');
    expect(html).toContain('name="corrections[0].reason"');
    expect(html).toContain('name="corrections[0].severity"');
    expect(html).toContain('name="corrections[0].scope.kind"');
  });

  it("hides the submit form and shows a read-only note without queue.manage", () => {
    const html = renderWorkspaceCorrectionPreviewView(previewModel(readOnlyPermission));
    expect(html).not.toContain('action="/api/workspace/corrections"');
    expect(html).toContain("correction-readonly");
    expect(html).toContain("queue.manage");
  });

  it("denies the whole view without queue.read", () => {
    const html = renderWorkspaceCorrectionPreviewView({
      ...previewModel(),
      permission: {
        actorUserId: "reviewer-1",
        canReadQueue: false,
        canManageQueue: false,
        denialReasons: ["user reviewer-1 is missing permission queue.read"],
      },
      diagnostics: [
        {
          code: "workspace_correction_read_permission_denied",
          message: "Workspace correction blocked: queue.read missing",
        },
      ],
    });
    expect(html).toContain('data-state="denied"');
  });
});

describe("parseWorkspaceRoute — corrections", () => {
  it("parses /workspace/corrections with localeBranchId + reviewItemIds into the preview API target", () => {
    const route = parseWorkspaceRoute(
      "/workspace/corrections",
      "?localeBranchId=branch-en&reviewItemIds=item-1,item-2",
    );
    expect(route).toEqual({
      kind: "corrections",
      localeBranchId: "branch-en",
      reviewItemIds: ["item-1", "item-2"],
    });
    const target = workspaceRouteApiTarget(route!);
    expect(target.routeId).toBe("workspace.correctionPreview");
    expect(target.apiPath).toContain("/api/workspace/corrections?");
    expect(target.apiPath).toContain("localeBranchId=branch-en");
    expect(target.apiPath).toContain("reviewItemIds=item-1%2Citem-2");
  });

  it("rejects /workspace/corrections without a locale branch", () => {
    expect(parseWorkspaceRoute("/workspace/corrections", "")).toBeNull();
  });
});
