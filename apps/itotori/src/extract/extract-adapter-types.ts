import type { NativeCliProcessResult } from "../native-bin/cli-bin-resolver.js";

export type KaifuuProcessResult = NativeCliProcessResult;

export type ExtractMode = "per-scene" | "scene-set" | "unit-range" | "whole-seen" | "whole-game";

export const REALLIVE_SCENE_ID_MAX = 65_535;

export type RealliveExtractSource = {
  engine: "reallive";
  vaultCanonicalId?: string;
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  scene?: number;
  wholeSeen?: boolean;
  scenes?: readonly number[];
  unitRange?: { start: number; endExclusive: number };
  decompileReportOutputPath?: string;
};

export type SoftpalExtractSource = {
  engine: "softpal";
  gameRoot?: string;
};

export type RpgMakerExtractSource = {
  engine: "rpg-maker";
  gameDir?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  findingsOutputPath?: string;
};

export const SIGLUS_SUPPORTED_CIPHER_METHODS = ["exe_angou_xor_lzss"] as const;
export type SiglusCipherMethod = (typeof SIGLUS_SUPPORTED_CIPHER_METHODS)[number];

export type SiglusExtractSource = {
  engine: "siglus";
  vaultCanonicalId?: string;
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  cipherMethod: SiglusCipherMethod;
};

export type ExtractSource =
  | RealliveExtractSource
  | SoftpalExtractSource
  | RpgMakerExtractSource
  | SiglusExtractSource;

export type ExtractProcessArgs = {
  bundleOutputPath: string;
  env?: NodeJS.ProcessEnv;
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

export type KaifuuRealliveExtractArgs = RealliveExtractSource & ExtractProcessArgs;
export type KaifuuSoftpalExtractArgs = SoftpalExtractSource & ExtractProcessArgs;
export type KaifuuRpgMakerExtractArgs = RpgMakerExtractSource & ExtractProcessArgs;
export type KaifuuSiglusExtractArgs = SiglusExtractSource & ExtractProcessArgs;

export type KaifuuExtractArgs =
  | KaifuuRealliveExtractArgs
  | KaifuuSoftpalExtractArgs
  | KaifuuRpgMakerExtractArgs
  | KaifuuSiglusExtractArgs;

type ExtractArgsByEngine = {
  reallive: KaifuuRealliveExtractArgs;
  softpal: KaifuuSoftpalExtractArgs;
  "rpg-maker": KaifuuRpgMakerExtractArgs;
  siglus: KaifuuSiglusExtractArgs;
};

type ExtractSourceByEngine = {
  reallive: RealliveExtractSource;
  softpal: SoftpalExtractSource;
  "rpg-maker": RpgMakerExtractSource;
  siglus: SiglusExtractSource;
};

export type ExtractEngineId = keyof ExtractArgsByEngine;
export type KaifuuEngine = ExtractEngineId;

export type ExtractFormField = {
  key: string;
  label: string;
  input: "text" | "number";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
};

export type ExtractFormConstraint = {
  kind: "exactly-one";
  fields: readonly string[];
  message: string;
};

export type ExtractModeCapability = {
  id: ExtractMode;
  label: string;
  fixedValues: Readonly<Record<string, string | number | boolean>>;
  fields: readonly ExtractFormField[];
};

export type ExtractCapability = {
  engine: ExtractEngineId;
  label: string;
  summary: string;
  fields: readonly ExtractFormField[];
  constraints: readonly ExtractFormConstraint[];
  modes: readonly ExtractModeCapability[];
  supportedCipherMethods?: readonly string[];
};

export type ExtractApiPayload = Readonly<Record<string, unknown>>;

export interface ExtractAdapter<E extends ExtractEngineId> {
  readonly engine: E;
  readonly capability: ExtractCapability;
  buildArgs(args: ExtractArgsByEngine[E]): string[];
  validate(args: ExtractArgsByEngine[E], env: NodeJS.ProcessEnv): void;
  mode(args: ExtractArgsByEngine[E]): ExtractMode;
  parseCli(args: readonly string[]): ExtractSourceByEngine[E];
  parseApi(input: ExtractApiPayload): ExtractSourceByEngine[E];
}

export type AnyExtractAdapter = {
  readonly engine: ExtractEngineId;
  readonly capability: ExtractCapability;
  buildArgs(args: KaifuuExtractArgs): string[];
  validate(args: KaifuuExtractArgs, env: NodeJS.ProcessEnv): void;
  mode(args: KaifuuExtractArgs): ExtractMode;
  parseCli(args: readonly string[]): ExtractSource;
  parseApi(input: ExtractApiPayload): ExtractSource;
};
