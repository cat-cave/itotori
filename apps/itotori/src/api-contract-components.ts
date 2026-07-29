import type { JsonValue } from "./api-contract-json.js";
import type { Ref, Schema } from "./api-contract-schema.js";
import { authComponentBuilders } from "./api-contract-components-auth.js";
import { baseComponentBuilders } from "./api-contract-components-base.js";
import { mutationComponentBuilders } from "./api-contract-components-mutations.js";
import { patchComponentBuilders } from "./api-contract-components-patch-iteration.js";
import { settingsComponentBuilders } from "./api-contract-components-settings.js";

export type ComponentBuilders = Readonly<Record<string, (ref: Ref) => Schema>>;

const componentBuilders: ComponentBuilders = {
  ...baseComponentBuilders,
  ...settingsComponentBuilders,
  ...authComponentBuilders,
  ...mutationComponentBuilders,
  ...patchComponentBuilders,
};

/** Materialize the component table with `$ref`s pointing at `prefix` + name. */
export function materializeComponents(prefix: string): Record<string, JsonValue> {
  const ref: Ref = (name) => ({ $ref: `${prefix}${name}` });
  const out: Record<string, JsonValue> = {};
  for (const [name, build] of Object.entries(componentBuilders)) {
    out[name] = build(ref) as JsonValue;
  }
  return out;
}
