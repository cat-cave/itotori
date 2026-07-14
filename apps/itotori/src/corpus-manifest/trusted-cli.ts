// Source-built native CLI boundary for private-corpus validation.
//
// The corpus validator must not accept a resolver-selected or PATH-selected
// executable: its evidence is only meaningful when it was produced from this
// checkout's locked Rust workspace. This module keeps that provenance check
// small and reusable for every registered corpus.

import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  defaultRepoRoot,
  spawnNativeCliProcess,
  type NativeSpawnResult,
} from "../native-bin/cli-bin-resolver.js";

const NATIVE_PROBE_BYTES = 4_096;

const MACH_O_THIN_MAGICS = new Map<number, { headerBytes: number; littleEndian: boolean }>([
  [0xfeedface, { headerBytes: 28, littleEndian: false }], // MH_MAGIC
  [0xfeedfacf, { headerBytes: 32, littleEndian: false }], // MH_MAGIC_64
  [0xcefaedfe, { headerBytes: 28, littleEndian: true }], // MH_CIGAM
  [0xcffaedfe, { headerBytes: 32, littleEndian: true }], // MH_CIGAM_64
]);

const MACH_O_FAT_MAGICS = new Map<number, { archBytes: number; littleEndian: boolean }>([
  [0xcafebabe, { archBytes: 20, littleEndian: false }], // FAT_MAGIC
  [0xcafebabf, { archBytes: 32, littleEndian: false }], // FAT_MAGIC_64
  [0xbebafeca, { archBytes: 20, littleEndian: true }], // FAT_CIGAM
  [0xbfbafeca, { archBytes: 32, littleEndian: true }], // FAT_CIGAM_64
]);

export type SourceCliBuildInput = {
  env: NodeJS.ProcessEnv;
  /** A new directory owned by the caller's temporary corpus-validation run. */
  targetRoot: string;
};

export type SourceCliBuildDependencies = {
  /** Test seam; production discovers the checked-out repository root. */
  repoRoot?: string | undefined;
  /** Test seam; production uses the shared, environment-scrubbing spawn boundary. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => NativeSpawnResult;
};

/**
 * Build Kaifuu and Utsushi through this checkout's offline Nix development
 * shell, then return an environment pinned to the resulting native binaries.
 *
 * `--target-dir` points inside a newly-created caller-owned temporary root.
 * Therefore a successful build cannot reuse a pre-existing binary from PATH,
 * CARGO_TARGET_DIR, a libexec bundle, or the repository target directory.
 */
export function buildSourceCliEnvironment(
  { env, targetRoot }: SourceCliBuildInput,
  dependencies: SourceCliBuildDependencies = {},
): NodeJS.ProcessEnv {
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot();
  if (repoRoot === undefined) {
    throw new Error(
      "private corpus validation requires a source checkout with Cargo.toml and flake.nix",
    );
  }
  if (existsSync(targetRoot)) {
    throw new Error("private corpus validation source-build target must be newly owned");
  }
  mkdirSync(targetRoot);
  const canonicalTargetRoot = realpathSync(targetRoot);

  const runProcess = dependencies.runProcess ?? spawnNativeCliProcess;
  const build = runProcess(
    "nix",
    [
      "develop",
      repoRoot,
      "--offline",
      "--command",
      "cargo",
      "build",
      "--locked",
      "--manifest-path",
      join(repoRoot, "Cargo.toml"),
      "--target-dir",
      targetRoot,
      "--package",
      "kaifuu-cli",
      "--package",
      "utsushi-cli",
    ],
    env,
  );
  if (build.error !== undefined || build.status !== 0) {
    throw new Error("private corpus validation could not build trusted native CLIs");
  }

  const kaifuuBin = join(canonicalTargetRoot, "debug", "kaifuu-cli");
  const utsushiBin = join(canonicalTargetRoot, "debug", "utsushi-cli");
  assertNativeBinary(kaifuuBin, "kaifuu-cli", canonicalTargetRoot);
  assertNativeBinary(utsushiBin, "utsushi-cli", canonicalTargetRoot);

  return {
    ...env,
    ITOTORI_KAIFUU_BIN: kaifuuBin,
    ITOTORI_UTSUSHI_BIN: utsushiBin,
  };
}

/**
 * Reject scripts, symbolic links, truncated magic-byte fakes, and other
 * executable lookalikes at the source-build seam. When `trustedRoot` is
 * supplied, every path component must remain inside the newly-owned target.
 */
export function assertNativeBinary(path: string, label: string, trustedRoot?: string): void {
  let file: ReturnType<typeof lstatSync>;
  try {
    accessSync(path, constants.X_OK);
    file = lstatSync(path);
  } catch {
    throw new Error(`private corpus validation could not locate trusted built ${label}`);
  }
  if (!file.isFile()) {
    throw new Error(`private corpus validation trusted ${label} path is not a regular executable`);
  }
  if (trustedRoot !== undefined) {
    assertOwnedBuildPath(path, trustedRoot, label);
  }
  if (!hasStructurallyPlausibleNativeHeader(path, file.size)) {
    throw new Error(`private corpus validation trusted ${label} is not a native binary`);
  }
}

function assertOwnedBuildPath(path: string, trustedRoot: string, label: string): void {
  const relativePath = relative(trustedRoot, path);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`private corpus validation trusted ${label} escaped its source-build target`);
  }

  let cursor = trustedRoot;
  for (const segment of relativePath.split(sep)) {
    cursor = join(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`private corpus validation trusted ${label} path contains a symbolic link`);
    }
  }

  const canonicalPath = realpathSync(path);
  const canonicalRelativePath = relative(trustedRoot, canonicalPath);
  if (
    canonicalRelativePath.length === 0 ||
    canonicalRelativePath === ".." ||
    canonicalRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelativePath)
  ) {
    throw new Error(`private corpus validation trusted ${label} escaped its source-build target`);
  }
}

function hasStructurallyPlausibleNativeHeader(path: string, byteLength: number): boolean {
  const probe = Buffer.alloc(Math.min(NATIVE_PROBE_BYTES, byteLength));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const bytesRead = readSync(descriptor, probe, 0, probe.length, 0);
    if (bytesRead < 4) return false;
    if (isElfMagic(probe)) return isStructurallyPlausibleElf(probe, bytesRead, byteLength);
    if (isStructurallyPlausibleMachO(probe, bytesRead, byteLength)) return true;
    return isStructurallyPlausiblePortableExecutable(descriptor, probe, bytesRead, byteLength);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isElfMagic(probe: Buffer): boolean {
  return probe[0] === 0x7f && probe[1] === 0x45 && probe[2] === 0x4c && probe[3] === 0x46;
}

function isStructurallyPlausibleElf(probe: Buffer, bytesRead: number, byteLength: number): boolean {
  const elfClass = probe[4];
  const dataEncoding = probe[5];
  if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2)) {
    return false;
  }
  const headerBytes = elfClass === 1 ? 52 : 64;
  const programHeaderBytes = elfClass === 1 ? 32 : 56;
  if (bytesRead < headerBytes || byteLength < headerBytes || probe[6] !== 1) return false;

  const littleEndian = dataEncoding === 1;
  const readU16 = (offset: number): number =>
    littleEndian ? probe.readUInt16LE(offset) : probe.readUInt16BE(offset);
  const readU32 = (offset: number): number =>
    littleEndian ? probe.readUInt32LE(offset) : probe.readUInt32BE(offset);
  const readU64 = (offset: number): bigint =>
    littleEndian ? probe.readBigUInt64LE(offset) : probe.readBigUInt64BE(offset);
  const fileType = readU16(16);
  const machine = readU16(18);
  const version = readU32(20);
  const programHeaderOffset = elfClass === 1 ? BigInt(readU32(28)) : readU64(32);
  const headerSize = readU16(elfClass === 1 ? 40 : 52);
  const programEntrySize = readU16(elfClass === 1 ? 42 : 54);
  const programCount = readU16(elfClass === 1 ? 44 : 56);
  const programTableEnd = programHeaderOffset + BigInt(programEntrySize) * BigInt(programCount);

  return (
    (fileType === 2 || fileType === 3) &&
    machine !== 0 &&
    version === 1 &&
    headerSize === headerBytes &&
    programEntrySize === programHeaderBytes &&
    programCount > 0 &&
    programHeaderOffset >= BigInt(headerBytes) &&
    programTableEnd <= BigInt(byteLength)
  );
}

function isStructurallyPlausibleMachO(
  probe: Buffer,
  bytesRead: number,
  byteLength: number,
): boolean {
  if (bytesRead < 4) return false;
  const magic = probe.readUInt32BE(0);
  const thin = MACH_O_THIN_MAGICS.get(magic);
  if (thin !== undefined) {
    if (bytesRead < thin.headerBytes || byteLength < thin.headerBytes) return false;
    const readU32 = (offset: number): number =>
      thin.littleEndian ? probe.readUInt32LE(offset) : probe.readUInt32BE(offset);
    const cpuType = readU32(4);
    const fileType = readU32(12);
    const commandCount = readU32(16);
    const commandBytes = readU32(20);
    return (
      cpuType !== 0 &&
      fileType === 2 && // MH_EXECUTE
      commandCount > 0 &&
      commandBytes > 0 &&
      thin.headerBytes + commandBytes <= byteLength
    );
  }

  const fat = MACH_O_FAT_MAGICS.get(magic);
  if (fat === undefined || bytesRead < 8 || byteLength < 8) return false;
  const archCount = fat.littleEndian ? probe.readUInt32LE(4) : probe.readUInt32BE(4);
  return archCount > 0 && 8 + archCount * fat.archBytes <= byteLength;
}

function isStructurallyPlausiblePortableExecutable(
  descriptor: number,
  probe: Buffer,
  bytesRead: number,
  byteLength: number,
): boolean {
  if (bytesRead < 64 || probe[0] !== 0x4d || probe[1] !== 0x5a) return false;
  const peOffset = probe.readUInt32LE(0x3c);
  const fixedHeaderBytes = 26; // PE signature + COFF header + optional-header magic.
  if (peOffset > byteLength - fixedHeaderBytes) return false;
  const header = Buffer.alloc(fixedHeaderBytes);
  if (readSync(descriptor, header, 0, header.length, peOffset) !== header.length) return false;
  if (header[0] !== 0x50 || header[1] !== 0x45 || header[2] !== 0 || header[3] !== 0) return false;
  const machine = header.readUInt16LE(4);
  const sectionCount = header.readUInt16LE(6);
  const optionalHeaderBytes = header.readUInt16LE(20);
  const optionalMagic = header.readUInt16LE(24);
  return (
    machine !== 0 &&
    sectionCount > 0 &&
    optionalHeaderBytes >= 2 &&
    (optionalMagic === 0x10b || optionalMagic === 0x20b) &&
    peOffset + 24 + optionalHeaderBytes <= byteLength
  );
}
