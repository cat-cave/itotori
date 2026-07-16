// A3 Scene Analyst — the self-contained role module.
//
// The `analyst` casting that reads each COMPLETE scene and serially folds the
// prior accepted story-so-far into a cited scene-summary and an updated
// story-so-far, in the SOURCE LANGUAGE, dispatching deepseek-v4-flash through the
// sole ZDR boundary. It consumes the roster (RB-040), the read-tool fact
// snapshot (RB-024), and claim validation (RB-031) READ-ONLY, imports nothing
// from the legacy agents tree, and owns a private barrel a sibling role never
// edits.

export {
  A3RoleError,
  A3_ROLE_ID,
  A3_SCENE_SUMMARY_KIND,
  A3_STORY_SO_FAR_KIND,
  type A3ClaimDraft,
  type A3Context,
  type A3FailureCode,
  type A3ModelCaller,
  type A3SceneNarrative,
  type A3SceneRequest,
  type CompleteScene,
  type StorySoFarState,
} from "./types.js";
export { a3Caller, assertCompleteSceneUnits, readCompleteScene } from "./scene.js";
export { assembleSceneSummary, assembleStorySoFar } from "./assemble.js";
export { foldRoute, type A3RouteResult, type A3SceneResult } from "./fold.js";
export { buildA3CallSpec, dispatchA3, dispatchingA3Caller } from "./dispatch.js";
