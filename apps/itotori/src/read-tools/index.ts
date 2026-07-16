// Strict local read-tool surface — public exports.
//
// Tool-use-over-RAG: agents read the deterministic fact snapshot through these
// typed tools rather than re-inferring structure from prose. Every tool returns
// a content-addressed { snapshotId, resultHash, page } envelope with explicit
// bounds and cursors, enforces its role allowlist / target branch / reveal
// horizon, and dispatches zero model calls.

export {
  ALL_ROLES,
  ReadToolError,
  TOOL_ROLE_ALLOWLIST,
  assertRoleAllowed,
  routeScopeVisible,
  withinHorizon,
  type ReadToolCaller,
  type ReadToolDenialCode,
} from "./access.js";

export {
  buildReadModel,
  type BuildReadModelInput,
  type ReadModel,
  type ReadModelLocalization,
} from "./model.js";

export { type CharacterProfile } from "./projection.js";

export {
  canonicalByteLength,
  paginate,
  requestHashOf,
  resultHashOf,
  type ToolResultPage,
} from "./pagination.js";

export {
  DecodeGetCharacterOccurrencesArgsSchema,
  DecodeGetNeighborsArgsSchema,
  DecodeGetRouteGraphArgsSchema,
  DecodeGetUnitsArgsSchema,
  GlossaryLookupArgsSchema,
  OutputsGetAcceptedArgsSchema,
  ReferencesSearchArgsSchema,
  type DecodeGetCharacterOccurrencesArgs,
  type DecodeGetNeighborsArgs,
  type DecodeGetRouteGraphArgs,
  type DecodeGetUnitsArgs,
  type GlossaryLookupArgs,
  type OutputsGetAcceptedArgs,
  type ReferencesSearchArgs,
} from "./args.js";

export {
  decodeGetCharacterOccurrences,
  decodeGetNeighbors,
  decodeGetRouteGraph,
  decodeGetUnits,
  glossaryLookup,
  outputsGetAccepted,
  referencesSearch,
} from "./tools.js";
