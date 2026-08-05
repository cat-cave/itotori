// Public façade for the engine-discriminated extract adapter registry.

import { EXTRACT_CAPABILITIES } from "./extract-adapter-capabilities.js";
import {
  realliveExtractAdapter,
  rpgMakerExtractAdapter,
  siglusExtractAdapter,
  softpalExtractAdapter,
} from "./extract-adapters.js";
import type {
  AnyExtractAdapter,
  ExtractAdapter,
  ExtractApiPayload,
  ExtractCapability,
  ExtractEngineId,
  ExtractSource,
} from "./extract-adapter-types.js";

export { REALLIVE_SCENE_ID_MAX } from "./extract-adapter-types.js";
export type {
  AnyExtractAdapter,
  ExtractAdapter,
  ExtractApiPayload,
  ExtractCapability,
  ExtractEngineId,
  ExtractFormConstraint,
  ExtractFormField,
  ExtractMode,
  ExtractModeCapability,
  ExtractProcessArgs,
  ExtractSource,
  KaifuuEngine,
  KaifuuExtractArgs,
  KaifuuProcessResult,
  KaifuuRealliveExtractArgs,
  KaifuuRpgMakerExtractArgs,
  KaifuuSiglusExtractArgs,
  KaifuuSoftpalExtractArgs,
  RealliveExtractSource,
  RpgMakerExtractSource,
  SiglusExtractSource,
  SoftpalExtractSource,
} from "./extract-adapter-types.js";
export type { ExtractModeForEngine, ExtractOutcome } from "./extract-adapter-capabilities.js";

function defineExtractAdapter<E extends ExtractEngineId>(
  adapter: ExtractAdapter<E>,
): AnyExtractAdapter {
  return adapter as unknown as AnyExtractAdapter;
}

const EXTRACT_ADAPTERS: Readonly<Record<ExtractEngineId, AnyExtractAdapter>> = {
  reallive: defineExtractAdapter(realliveExtractAdapter),
  softpal: defineExtractAdapter(softpalExtractAdapter),
  "rpg-maker": defineExtractAdapter(rpgMakerExtractAdapter),
  siglus: defineExtractAdapter(siglusExtractAdapter),
};

export function registeredExtractEngines(): ExtractEngineId[] {
  return Object.keys(EXTRACT_ADAPTERS) as ExtractEngineId[];
}

export function isRegisteredExtractEngine(engine: string): engine is ExtractEngineId {
  return Object.prototype.hasOwnProperty.call(EXTRACT_ADAPTERS, engine);
}

export function extractCapabilities(): ExtractCapability[] {
  return registeredExtractEngines().map((engine) => EXTRACT_CAPABILITIES[engine]);
}

export function parseExtractApiRequest(body: unknown): ExtractSource {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ApiProjectDecodeExtractRequest must be an object");
  }
  const input = body as ExtractApiPayload;
  if (typeof input.engine !== "string") {
    throw new Error("ApiProjectDecodeExtractRequest.engine is required");
  }
  return resolveExtractAdapter(input.engine).parseApi(input);
}

export function isExtractModeForEngine(engine: string, mode: string): boolean {
  return resolveExtractAdapter(engine).capability.modes.some((option) => option.id === mode);
}

export function resolveExtractAdapter(engine: string): AnyExtractAdapter {
  if (!isRegisteredExtractEngine(engine)) {
    throw new Error(
      `extract refused: --engine '${engine}' is not a registered extract adapter (registered: ${registeredExtractEngines().join(", ")})`,
    );
  }
  return EXTRACT_ADAPTERS[engine];
}
