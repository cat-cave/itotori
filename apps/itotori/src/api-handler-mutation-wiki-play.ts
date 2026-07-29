import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as responses from "./api-handler-responses.js";
import * as shared from "./api-handler-shared.js";

export async function routeWikiAndPlayMutations(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriApiServices,
): Promise<contracts.ApiJsonResponse | null> {
  const wikiObjectRoute = deps.parseWikiObjectApiRoute(request.pathname);
  if (
    request.method === "POST" &&
    (wikiObjectRoute?.resource === "edit" ||
      wikiObjectRoute?.resource === "feedback" ||
      wikiObjectRoute?.resource === "apply")
  ) {
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.wikiEdit);
    const wikiService = deps.configuredServicePort(services, "wikiObjectApi");
    if (wikiService === undefined) {
      throw new Error("wiki is not configured in this API build (wikiObjectApi port missing)");
    }
    const selector = wikiObjectRoute.selector;
    const createdAt = new Date().toISOString();
    try {
      if (wikiObjectRoute.resource === "edit" || wikiObjectRoute.resource === "feedback") {
        const body = deps.parseWikiWriteRequest(request.body);
        if (wikiObjectRoute.resource === "edit") {
          const response = await deps.runApiWiki(
            {
              action: "edit",
              selector,
              candidate: body.input,
              createdAt,
              ...(body.assertion === undefined ? {} : { assertion: body.assertion }),
            },
            { resolveWikiService: () => wikiService },
          );
          if (response.action !== "edit") throw new Error("wiki.edit returned the wrong receipt");
          const current = await wikiService.show(selector);
          if (current === null)
            throw new deps.WikiObjectApiError(
              `wiki object ${selector.objectId} has no current head`,
            );
          return responses.ok(
            "wiki.edit",
            deps.wikiObjectWriteResponseBody(response.result, current.history, createdAt),
          );
        }
        const response = await deps.runApiWiki(
          {
            action: "feedback",
            selector,
            candidate: body.input,
            createdAt,
            ...(body.assertion === undefined ? {} : { assertion: body.assertion }),
          },
          { resolveWikiService: () => wikiService },
        );
        if (response.action !== "feedback")
          throw new Error("wiki.feedback returned the wrong receipt");
        const current = await wikiService.show(selector);
        if (current === null)
          throw new deps.WikiObjectApiError(`wiki object ${selector.objectId} has no current head`);
        return responses.ok(
          "wiki.feedback",
          deps.wikiObjectWriteResponseBody(response.result, current.history, createdAt),
        );
      }
      const body = deps.parseWikiApplyRequest(request.body);
      const apply = deps.configuredServicePort(services, "wikiApply");
      if (apply === undefined) {
        throw new Error("wiki apply is not configured in this API build (wikiApply port missing)");
      }
      const response = await deps.runApiWiki(
        {
          action: "apply",
          selector,
          inputIds: body.inputIds,
          runner: apply.runner,
          decodedFacts: apply.decodedFacts,
          createdAt,
          ...(body.assertion === undefined ? {} : { assertion: body.assertion }),
        },
        { resolveWikiService: () => wikiService },
      );
      if (response.action !== "apply") throw new Error("wiki.apply returned the wrong receipt");
      const shown = await wikiService.show(selector);
      if (shown === null)
        throw new deps.WikiObjectApiError(`wiki object ${selector.objectId} has no current head`);
      return responses.ok(
        "wiki.apply",
        deps.wikiObjectApplyResponseBody(response.result, shown.history, createdAt),
      );
    } catch (error) {
      if (
        error instanceof deps.ForgedWikiAssertionError ||
        error instanceof deps.WikiObjectApiError
      ) {
        throw new deps.ApiValidationError(error.message);
      }
      throw error;
    }
  }

  const targetEditRoute = deps.parsePlayTargetEditApiRoute(request.pathname);
  if (request.method === "POST" && targetEditRoute !== null) {
    const body = deps.parsePlayTargetEditRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.playTargetEdit,
    );
    const result = await services.playTesterResultRevision.editTarget({
      parentPatchVersionId: targetEditRoute.parentPatchVersionId,
      bridgeUnitId: body.bridgeUnitId,
      targetBody: body.targetBody,
    });
    return responses.ok("play.targetEdit", deps.playTargetEditResponseBody(result));
  }

  const patchIterationRoute = deps.parsePatchIterationApiRoute(request.pathname);
  if (request.method === "POST" && patchIterationRoute !== null) {
    // The kept patch-play entry point is backed by the new composition path.
    const body = deps.parsePatchIterationPlayRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.patchIterationPlay,
    );
    const playDeps = deps.configuredServicePort(services, "patchPlay");
    if (playDeps === undefined) {
      throw new Error(
        "patch play is not configured in this API build (patchPlay port missing — the new-pipeline surface loader + runtime launcher are not installed)",
      );
    }
    const receipt = await deps.runApiPlay(
      {
        patchVersionId: patchIterationRoute.patchVersionId,
        launch: body,
      },
      { resolvePlayDeps: () => playDeps },
    );
    return responses.ok("patchIteration.play", deps.patchIterationPlayReceiptResponseBody(receipt));
  }

  const flagRoute = deps.parsePlayFlagApiRoute(request.pathname);
  if (request.method === "POST" && flagRoute !== null) {
    const body = deps.parsePlayFlagAnnotationRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.flagAnnotation,
    );
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: flagRoute.projectId,
      localeBranchId: flagRoute.localeBranchId,
    });
    const actorUserId = body.actorUserId ?? "local-user";
    const [target] = await services.addressableUnits.resolveAddressableBridgeUnits(
      { userId: actorUserId },
      {
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
        bridgeUnitIds: [body.bridgeUnitId],
      },
    );
    if (target === undefined || target.state !== "resolved") {
      throw new deps.ApiValidationError(
        "play flag requires an imported bridge unit with a producer-declared scene coordinate",
      );
    }
    if (body.sceneId !== undefined && body.sceneId !== target.sceneId) {
      throw new deps.ApiValidationError("play flag scene does not match the imported bridge unit");
    }
    const importInput = deps.buildPlayFlagFeedbackInput({
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      note: body.note,
      severity: body.severity as deps.PlayFlagSeverity,
      actorUserId,
      ...(body.category === undefined ? {} : { category: body.category }),
      bridgeUnitId: body.bridgeUnitId,
      ...(body.sourceUnitKey === undefined ? {} : { sourceUnitKey: body.sourceUnitKey }),
      ...(body.sourceBundleId === undefined ? {} : { sourceBundleId: body.sourceBundleId }),
      ...(body.sourceRevisionId === undefined ? {} : { sourceRevisionId: body.sourceRevisionId }),
      sceneId: target.sceneId,
      ...(body.suggestedEdit === undefined ? {} : { suggestedEdit: body.suggestedEdit }),
      ...(body.actorDisplayName === undefined ? {} : { actorDisplayName: body.actorDisplayName }),
    });
    const result = await services.manualFeedback.importManualFeedback(importInput);
    const response: deps.ApiPlayFlagAnnotationResponse = {
      schemaVersion: "itotori.play.flag-annotation.v0",
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      feedbackReportId: result.feedbackReportId,
      feedbackEvidenceId: result.feedbackEvidenceId,
      severity: body.severity,
      category: body.category?.trim() || null,
      note: body.note.trim(),
      triageLabel: result.triageLabel,
      contextStatus: result.contextStatus,
      contextCorrectionId: result.contextCorrection.correctionId,
      duplicate: result.duplicate,
    };
    return responses.ok("play.flagAnnotation", response);
  }

  if (targetEditRoute !== null) {
    return responses.methodNotAllowed(["POST"]);
  }
  if (patchIterationRoute !== null) {
    return responses.methodNotAllowed(["POST"]);
  }

  return null;
}
