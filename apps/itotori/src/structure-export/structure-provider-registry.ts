// Engine-discriminated structure-export provider registry.
//
// A caller MUST select one registered provider with `--engine`; there is no
// default and the CLI handler does not know any provider's input shape.  Each
// provider owns parsing its source flags and either produces the common
// NarrativeStructure artifact or reports its declared implementation boundary.

import { optionalFlag, requiredFlag } from "../cli/flags.js";
import {
  runUtsushiStructureExport,
  type UtsushiProcessResult,
  type RunUtsushiStructureResult,
} from "./utsushi-structure-seam.js";

export type RealliveStructureSource = {
  engine: "reallive";
  gameexePath: string;
  seenPath: string;
  outputPath: string;
  bridgePath?: string;
  entryScene?: number;
  maxScenes?: number;
  env?: NodeJS.ProcessEnv;
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => UtsushiProcessResult;
  log?: (message: string) => void;
};

/** Typed forward declaration for the Softpal structure provider. */
export type SoftpalStructureSource = {
  engine: "softpal";
  gameRoot: string;
  outputPath: string;
};

/** Typed forward declaration for the Siglus structure provider. */
export type SiglusStructureSource = {
  engine: "siglus";
  scenePath: string;
  gameexePath: string;
  outputPath: string;
};

export type StructureProviderSource =
  | RealliveStructureSource
  | SoftpalStructureSource
  | SiglusStructureSource;

type StructureSourceByEngine = {
  reallive: RealliveStructureSource;
  softpal: SoftpalStructureSource;
  siglus: SiglusStructureSource;
};

export type StructureEngineId = keyof StructureSourceByEngine;

export type StructureProviderCapability = {
  engine: StructureEngineId;
  summary: string;
  implemented: boolean;
};

export type StructureProviderResult = RunUtsushiStructureResult;

export interface StructureProvider<E extends StructureEngineId> {
  readonly engine: E;
  readonly capability: StructureProviderCapability;
  parseCli(args: readonly string[]): StructureSourceByEngine[E];
  run(source: StructureSourceByEngine[E]): StructureProviderResult;
}

export type AnyStructureProvider = {
  readonly engine: StructureEngineId;
  readonly capability: StructureProviderCapability;
  parseCli(args: readonly string[]): StructureProviderSource;
  run(source: StructureProviderSource): StructureProviderResult;
};

function defineStructureProvider<E extends StructureEngineId>(
  provider: StructureProvider<E>,
): AnyStructureProvider {
  return provider as unknown as AnyStructureProvider;
}

function parsePositiveInteger(args: readonly string[], flag: string): number | undefined {
  const raw = optionalFlag(args, flag);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`structure-export refused: ${flag} '${raw}' must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(args: readonly string[], flag: string): number | undefined {
  const raw = optionalFlag(args, flag);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw) {
    throw new Error(`structure-export refused: ${flag} '${raw}' must be a non-negative integer`);
  }
  return value;
}

const realliveStructureProvider: StructureProvider<"reallive"> = {
  engine: "reallive",
  capability: {
    engine: "reallive",
    summary: "Gameexe.ini + Seen.txt narrative graph export",
    implemented: true,
  },
  parseCli(args) {
    const bridgePath = optionalFlag(args, "--bridge");
    const entryScene = parseNonNegativeInteger(args, "--entry-scene");
    const maxScenes = parsePositiveInteger(args, "--max-scenes");
    return {
      engine: "reallive",
      gameexePath: requiredFlag(args, "--gameexe"),
      seenPath: requiredFlag(args, "--seen"),
      outputPath: requiredFlag(args, "--output"),
      ...(bridgePath === undefined ? {} : { bridgePath }),
      ...(entryScene === undefined ? {} : { entryScene }),
      ...(maxScenes === undefined ? {} : { maxScenes }),
    };
  },
  run(source) {
    return runUtsushiStructureExport({
      engine: source.engine,
      gameexePath: source.gameexePath,
      seenPath: source.seenPath,
      outputPath: source.outputPath,
      ...(source.bridgePath === undefined ? {} : { bridgePath: source.bridgePath }),
      ...(source.entryScene === undefined ? {} : { entryScene: source.entryScene }),
      ...(source.maxScenes === undefined ? {} : { maxScenes: source.maxScenes }),
      ...(source.env === undefined ? {} : { env: source.env }),
      ...(source.runProcess === undefined ? {} : { runProcess: source.runProcess }),
      ...(source.log === undefined ? {} : { log: source.log }),
    });
  },
};

function unavailableProvider<E extends Exclude<StructureEngineId, "reallive">>(
  engine: E,
  summary: string,
  parseCli: (args: readonly string[]) => StructureSourceByEngine[E],
): StructureProvider<E> {
  return {
    engine,
    capability: { engine, summary, implemented: false },
    parseCli,
    run() {
      throw new Error(
        `structure-export refused: --engine '${engine}' has a registered typed provider but its native implementation is not available yet`,
      );
    },
  };
}

const softpalStructureProvider = unavailableProvider(
  "softpal",
  "Whole-game structure source rooted at SCRIPT.SRC + TEXT.DAT",
  (args) => ({
    engine: "softpal",
    gameRoot: requiredFlag(args, "--game-root"),
    outputPath: requiredFlag(args, "--output"),
  }),
);

const siglusStructureProvider = unavailableProvider(
  "siglus",
  "Scene.pck + Gameexe.dat structure source",
  (args) => ({
    engine: "siglus",
    scenePath: requiredFlag(args, "--scene"),
    gameexePath: requiredFlag(args, "--gameexe"),
    outputPath: requiredFlag(args, "--output"),
  }),
);

const STRUCTURE_PROVIDERS: Readonly<Record<StructureEngineId, AnyStructureProvider>> = {
  reallive: defineStructureProvider(realliveStructureProvider),
  softpal: defineStructureProvider(softpalStructureProvider),
  siglus: defineStructureProvider(siglusStructureProvider),
};

export function registeredStructureEngines(): StructureEngineId[] {
  return Object.keys(STRUCTURE_PROVIDERS) as StructureEngineId[];
}

export function structureProviderCapabilities(): StructureProviderCapability[] {
  return registeredStructureEngines().map((engine) => STRUCTURE_PROVIDERS[engine].capability);
}

export function isRegisteredStructureEngine(engine: string): engine is StructureEngineId {
  return Object.prototype.hasOwnProperty.call(STRUCTURE_PROVIDERS, engine);
}

export function resolveStructureProvider(engine: string): AnyStructureProvider {
  if (!isRegisteredStructureEngine(engine)) {
    throw new Error(
      `structure-export refused: --engine '${engine}' is not a registered structure provider (registered: ${registeredStructureEngines().join(", ")})`,
    );
  }
  return STRUCTURE_PROVIDERS[engine];
}

/** Run a typed source through its registered provider. */
export function runStructureProvider(source: StructureProviderSource): StructureProviderResult {
  return resolveStructureProvider(source.engine).run(source);
}
