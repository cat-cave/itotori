// Localization target policy — public surface + default registrations.
//
// Importing this module registers the built-in policies so a caller can resolve
// them by policy id or adapter id. Each engine/adapter appears ONLY as a
// registered policy; the shared gate path never branches on an engine identity.

import { registerLocalizationTargetPolicy } from "./registry.js";
import { realliveSjisPolicy } from "./reallive-sjis.js";
import { siglusUtf16Policy } from "./siglus-utf16.js";
import { utf8JsonPolicy } from "./utf8-json.js";

registerLocalizationTargetPolicy(realliveSjisPolicy);
registerLocalizationTargetPolicy(siglusUtf16Policy);
registerLocalizationTargetPolicy(utf8JsonPolicy);

export type {
  EncodingViolation,
  LocalizationTargetPolicy,
  LocalizationTargetPolicyId,
  PolicyBoxLimits,
  RuntimeEvidenceChannel,
  TargetCodec,
} from "./types.js";

export {
  LocalizationTargetPolicyError,
  listLocalizationTargetPolicies,
  registerLocalizationTargetPolicy,
  resolveLocalizationTargetPolicy,
  resolveTargetPolicyForAdapter,
} from "./registry.js";

export {
  REALLIVE_SJIS_ADAPTER_ID,
  REALLIVE_SJIS_POLICY_ID,
  firstNonSjisCodePoint,
  realliveSjisPolicy,
  sjisByteLength,
} from "./reallive-sjis.js";

export { UTF8_JSON_ADAPTER_ID, UTF8_JSON_POLICY_ID, utf8JsonPolicy } from "./utf8-json.js";

export {
  SIGLUS_UTF16_ADAPTER_ID,
  SIGLUS_UTF16_POLICY_ID,
  siglusUtf16Policy,
} from "./siglus-utf16.js";
