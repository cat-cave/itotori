// P2 Line Editor — a bounded author-thread continuation, not a fresh localizer
// fork. This module exports only the role's typed scope, call, and deterministic
// patch guards; it owns neither provider selection nor workflow/QA scheduling.
export {
  AUTHOR_CONTINUATION_MODE,
  deriveEditScope,
  EditScopeError,
  type EditFailureCode,
  type EditScope,
} from "./scope.js";
export {
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  assertRepairPatchMatchesScope,
  assertTargetEncodable,
  FinalizeError,
  mergePatch,
  type FinalizeFailureCode,
} from "./finalize.js";
export {
  assertCertifiedP2Route,
  buildEditCall,
  dispatchEditCall,
  type BuildEditCallInput,
  type EditCall,
  type EditorRuntimeBase,
} from "./call.js";
export { editLine, EditError, type EditLineInput, type LineEditOutcome } from "./editor.js";
