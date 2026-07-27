/** Manual feedback / unit-bound flag port.
 *
 * Play flags enter the canonical ManualFeedbackImport intake and are bound to a
 * real bridge unit. The same port lists notes for a unit so the wiki and review
 * surfaces retrieve what was submitted against that identity.
 */

import type { UnitBoundFeedbackPort } from "./play/unit-feedback.js";

export type ManualFeedbackImportPort = UnitBoundFeedbackPort;

export type {
  ListUnitFeedbackQuery,
  UnitFeedbackImportResult,
  UnitFeedbackNote,
} from "./play/unit-feedback.js";
