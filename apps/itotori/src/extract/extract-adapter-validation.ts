import {
  REALLIVE_SCENE_ID_MAX,
  type ExtractApiPayload,
  type ExtractCapability,
  type ExtractFormField,
  type SiglusCipherMethod,
  SIGLUS_SUPPORTED_CIPHER_METHODS,
} from "./extract-adapter-types.js";

export function parseRealliveSceneId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > REALLIVE_SCENE_ID_MAX ||
    String(parsed) !== value
  ) {
    throw new Error(
      `extract refused: --scene '${value}' must be a u16 (0..${REALLIVE_SCENE_ID_MAX})`,
    );
  }
  return parsed;
}

export function parseRealliveSceneSet(value: string): number[] {
  const scenes = value.split(",").map(parseRealliveSceneId);
  if (scenes.length === 0 || new Set(scenes).size !== scenes.length) {
    throw new Error("extract refused: --scenes must contain one or more distinct u16 scene ids");
  }
  return scenes;
}

export function parseRealliveUnitRange(value: string): { start: number; endExclusive: number } {
  const [start, endExclusive, extra] = value.split(":");
  if (start === undefined || endExclusive === undefined || extra !== undefined) {
    throw new Error("extract refused: --unit-range must be START:END (end exclusive)");
  }
  const range = { start: Number(start), endExclusive: Number(endExclusive) };
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.endExclusive) ||
    range.start < 0 ||
    range.start >= range.endExclusive
  ) {
    throw new Error(
      "extract refused: --unit-range must have non-negative START:END with START < END",
    );
  }
  return range;
}

export function parseSiglusCipherMethod(value: string): SiglusCipherMethod {
  const method = SIGLUS_SUPPORTED_CIPHER_METHODS.find((candidate) => candidate === value);
  if (method === undefined) {
    throw new Error(
      `kaifuu.siglus.engine_profile.out_of_profile_cipher_method: '${value}' is not declared by the Siglus engine profile`,
    );
  }
  return method;
}

export function assertCapabilityPayload(
  capability: ExtractCapability,
  input: ExtractApiPayload,
): void {
  const allowed = new Set<string>(["engine"]);
  for (const field of capability.fields) allowed.add(field.key);
  for (const mode of capability.modes) {
    for (const field of mode.fields) allowed.add(field.key);
    for (const key of Object.keys(mode.fixedValues)) allowed.add(key);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new Error(
        `ApiProjectDecodeExtractRequest.${key} is not supported by the ${capability.engine} adapter`,
      );
  }
  for (const field of capability.fields) {
    if (field.required) assertApiFormField(input[field.key], field);
  }
  for (const constraint of capability.constraints) {
    const supplied = constraint.fields.filter((field) => hasApiValue(input[field]));
    if (constraint.kind === "exactly-one" && supplied.length !== 1) {
      throw new Error(`ApiProjectDecodeExtractRequest ${constraint.message}`);
    }
  }
}

function assertApiFormField(value: unknown, field: ExtractFormField): void {
  if (field.input === "text") {
    if (typeof value !== "string" || value.trim().length === 0)
      throw new Error(`ApiProjectDecodeExtractRequest.${field.key} is required`);
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    (field.min !== undefined && value < field.min) ||
    (field.max !== undefined && value > field.max)
  ) {
    throw new Error(`ApiProjectDecodeExtractRequest.${field.key} is invalid`);
  }
}

function hasApiValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function requiredApiString(input: ExtractApiPayload, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`ApiProjectDecodeExtractRequest.${field} is required`);
  return value;
}

export function optionalApiString(input: ExtractApiPayload, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`ApiProjectDecodeExtractRequest.${field} must be a non-empty string`);
  return value;
}

export function optionalApiScene(input: ExtractApiPayload, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > REALLIVE_SCENE_ID_MAX
  ) {
    throw new Error(`ApiProjectDecodeExtractRequest.${field} must be a u16 (0..65535)`);
  }
  return value;
}
