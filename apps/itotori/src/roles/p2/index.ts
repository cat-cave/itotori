// The P2 Line Editor role — a self-contained module. It consumes the roster
// manifest read-only (the P2 line-editor specialist) and dispatches through the
// single ZDR boundary; it owns no shared roster registry.
export {
  deriveEditScope,
  ScopeError,
  type CurrentUnit,
  type EditScope,
  type ImplicatedSource,
  type ScopedDefect,
  type ScopeFailureCode,
} from "./scope.js";
export {
  buildEditCall,
  dispatchEditCall,
  type BuildEditCallInput,
  type EditCall,
  type EditorRuntimeBase,
} from "./call.js";
export {
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  assertRepairPatchMatchesScope,
  assertSjisPreserved,
  mergePatch,
  FinalizeError,
  type FinalizeFailureCode,
} from "./finalize.js";
export { editLine, EditError, type EditLineInput, type LineEdit } from "./editor.js";
