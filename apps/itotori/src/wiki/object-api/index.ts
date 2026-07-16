// The wiki object read/write API barrel. Local to the wiki object surface: the
// typed list / show / history / edit / feedback / apply endpoints over the
// WikiObject substrate, with the strict forged-assertion write guard.

export {
  ForgedWikiAssertionError,
  guardWriteAssertion,
  type ForgedDimension,
  type WikiWriteAssertion,
} from "./guards.js";
export {
  parseRecord,
  toHistory,
  toView,
  type ParsedWikiRecord,
  type WikiBadges,
  type WikiCitationView,
  type WikiHistoryEntry,
  type WikiObjectView,
  type WikiRenderingView,
  type WikiRouteScope,
  type WikiSourceObjectView,
} from "./read-model.js";
export {
  WikiObjectApiError,
  WikiObjectApiService,
  type WikiApplyReceipt,
  type WikiDependentView,
  type WikiHeadReceipt,
  type WikiListResult,
  type WikiObjectApiDeps,
  type WikiObjectSelector,
  type WikiShowResult,
  type WikiWriteReceipt,
} from "./service.js";
