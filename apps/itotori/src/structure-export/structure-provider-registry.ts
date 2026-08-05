// Uniform native structure-export provider.
//
// This compatibility-named module intentionally contains no format-specific
// parser or execution branch. Every caller supplies the same source-root,
// bridge, output, and optional declared adapter-config envelope to Utsushi.

import {
  runUtsushiStructureExport,
  type RunUtsushiStructureResult,
  type UtsushiProcessResult,
  type UtsushiStructureAdapterConfig,
} from "./utsushi-structure-seam.js";

/** One source-format-neutral structure-export request. */
export type StructureProviderSource = {
  readonly engine: string;
  readonly gameRoot: string;
  readonly bridgePath: string;
  readonly outputPath: string;
  readonly adapterConfig?: UtsushiStructureAdapterConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly runProcess?: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => UtsushiProcessResult;
  readonly log?: (message: string) => void;
};

export type StructureProviderResult = {
  readonly execution: "native-process";
  readonly process: RunUtsushiStructureResult;
};

/**
 * Run the selected native format adapter through the single uniform structure
 * argv. Utsushi owns source-format resolution and validation after this seam.
 */
export function runStructureProvider(source: StructureProviderSource): StructureProviderResult {
  return {
    execution: "native-process",
    process: runUtsushiStructureExport(source),
  };
}
