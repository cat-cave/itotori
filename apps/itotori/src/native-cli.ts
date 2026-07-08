import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type NativeCliName = "kaifuu-cli" | "utsushi-cli";

export type NativeCliProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type NativeCliInvocation = {
  command: string;
  prefixArgs: string[];
};

export type NativeCliRunProcess = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => NativeCliProcessResult;

export type NativeCliRunner = {
  env?: NodeJS.ProcessEnv;
  runProcess?: NativeCliRunProcess;
};

const BIN_CONFIG = {
  "kaifuu-cli": {
    envVar: "ITOTORI_KAIFUU_BIN",
    cargoPackage: "kaifuu-cli",
  },
  "utsushi-cli": {
    envVar: "ITOTORI_UTSUSHI_BIN",
    cargoPackage: "utsushi-cli",
  },
} as const satisfies Record<NativeCliName, { envVar: string; cargoPackage: string }>;

/**
 * Resolve a native Rust CLI in the same order as the native-deps doctor:
 * explicit env pin, bundled libexec, dev/build target dirs, repo target,
 * then PATH. A dev checkout with no built binary falls back to `cargo run`.
 */
export function resolveNativeCli(
  bin: NativeCliName,
  env: NodeJS.ProcessEnv = process.env,
): NativeCliInvocation {
  const config = BIN_CONFIG[bin];
  const explicit = env[config.envVar];
  if (explicit !== undefined && explicit.length > 0 && isExecutableFile(explicit)) {
    return { command: explicit, prefixArgs: [] };
  }

  const candidates: string[] = [];
  if (env.ITOTORI_LIBEXEC_DIR !== undefined && env.ITOTORI_LIBEXEC_DIR.length > 0) {
    candidates.push(join(env.ITOTORI_LIBEXEC_DIR, bin));
    candidates.push(join(env.ITOTORI_LIBEXEC_DIR, `${bin}.exe`));
  }
  const targetDirs: string[] = [];
  if (env.CARGO_TARGET_DIR !== undefined && env.CARGO_TARGET_DIR.length > 0) {
    targetDirs.push(env.CARGO_TARGET_DIR);
  }
  targetDirs.push(join(process.cwd(), "target"));
  for (const dir of targetDirs) {
    candidates.push(join(dir, "release", bin));
    candidates.push(join(dir, "debug", bin));
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  const onPath = resolveOnPath(bin, env);
  if (onPath !== undefined) {
    return { command: onPath, prefixArgs: [] };
  }

  return { command: "cargo", prefixArgs: ["run", "-p", config.cargoPackage, "--quiet", "--"] };
}

export function runNativeCli(
  bin: NativeCliName,
  args: string[],
  options: NativeCliRunner = {},
): NativeCliProcessResult & { command: string; args: string[] } {
  const env = options.env ?? process.env;
  const { command, prefixArgs } = resolveNativeCli(bin, env);
  const fullArgs = [...prefixArgs, ...args];
  const runProcess = options.runProcess ?? defaultRunProcess;
  const result = runProcess(command, fullArgs, env);
  return { command, args: fullArgs, ...result };
}

function defaultRunProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): NativeCliProcessResult {
  const res = spawnSync(command, args, {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error !== undefined) {
    throw new Error(`native CLI could not be spawned (${command}): ${res.error.message}`);
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveOnPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH;
  if (pathValue === undefined || pathValue.length === 0) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}
