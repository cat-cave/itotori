import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNativeBinary,
  buildSourceCliEnvironment,
} from "../src/corpus-manifest/trusted-cli.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-corpus-cli-"));
  temporaryRoots.push(root);
  return root;
}

function writeExecutable(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
}

/** A minimal but structurally plausible ELF64 ET_DYN file for header tests. */
function validElfHeader(): Buffer {
  const bytes = Buffer.alloc(120); // ELF64 header (64) + one program header (56).
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0); // ELF, 64-bit, little-endian, v1.
  bytes.writeUInt16LE(3, 16); // ET_DYN (the usual modern PIE executable type).
  bytes.writeUInt16LE(0x3e, 18); // EM_X86_64.
  bytes.writeUInt32LE(1, 20); // ELF version.
  bytes.writeBigUInt64LE(64n, 32); // e_phoff.
  bytes.writeUInt16LE(64, 52); // e_ehsize.
  bytes.writeUInt16LE(56, 54); // e_phentsize.
  bytes.writeUInt16LE(1, 56); // e_phnum.
  bytes.writeUInt32LE(1, 64); // PT_LOAD program-header type.
  return bytes;
}

function writeNativeCliPair(targetRoot: string, bytes = validElfHeader()): void {
  writeExecutable(join(targetRoot, "debug", "kaifuu-cli"), bytes);
  writeExecutable(join(targetRoot, "debug", "utsushi-cli"), bytes);
}

describe("private corpus source-built CLI boundary", () => {
  it("recognizes the running Node executable as a real native binary", () => {
    assertNativeBinary(process.execPath, "node");
  });

  it("builds through the repository's offline Nix dev shell instead of PATH cargo", () => {
    const root = temporaryRoot();
    const repoRoot = join(root, "checkout");
    const targetRoot = join(root, "run-target");
    const fakeCargoDir = join(root, "untrusted-path");
    writeExecutable(join(fakeCargoDir, "cargo"), Buffer.from("#!/bin/sh\nexit 99\n"));
    const invocations: Array<{ command: string; args: string[] }> = [];

    const environment = buildSourceCliEnvironment(
      {
        env: { PATH: fakeCargoDir },
        targetRoot,
      },
      {
        repoRoot,
        runProcess(command, args) {
          invocations.push({ command, args });
          writeNativeCliPair(targetRoot);
          return { error: undefined, status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(invocations).toEqual([
      {
        command: "nix",
        args: [
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
      },
    ]);
    expect(environment.ITOTORI_KAIFUU_BIN).toBe(join(targetRoot, "debug", "kaifuu-cli"));
    expect(environment.ITOTORI_UTSUSHI_BIN).toBe(join(targetRoot, "debug", "utsushi-cli"));
  });

  it("rejects a shell-script lookalike after a nominal source build", () => {
    const root = temporaryRoot();
    const targetRoot = join(root, "run-target");

    expect(() =>
      buildSourceCliEnvironment(
        { env: {}, targetRoot },
        {
          repoRoot: join(root, "checkout"),
          runProcess() {
            writeNativeCliPair(targetRoot, Buffer.from("#!/bin/sh\necho replay\n"));
            return { error: undefined, status: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).toThrow(/not a native binary/iu);
  });

  it("rejects an ELF magic-only lookalike after a nominal source build", () => {
    const root = temporaryRoot();
    const targetRoot = join(root, "run-target");

    expect(() =>
      buildSourceCliEnvironment(
        { env: {}, targetRoot },
        {
          repoRoot: join(root, "checkout"),
          runProcess() {
            writeNativeCliPair(targetRoot, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
            return { error: undefined, status: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).toThrow(/not a native binary/iu);
  });

  it("rejects a source-build output that is a symlink to a planted binary", () => {
    const root = temporaryRoot();
    const targetRoot = join(root, "run-target");
    const plantedRoot = join(root, "planted");
    writeNativeCliPair(plantedRoot);

    expect(() =>
      buildSourceCliEnvironment(
        { env: {}, targetRoot },
        {
          repoRoot: join(root, "checkout"),
          runProcess() {
            const targetDebug = join(targetRoot, "debug");
            mkdirSync(targetDebug, { recursive: true });
            symlinkSync(join(plantedRoot, "debug", "kaifuu-cli"), join(targetDebug, "kaifuu-cli"));
            symlinkSync(
              join(plantedRoot, "debug", "utsushi-cli"),
              join(targetDebug, "utsushi-cli"),
            );
            return { error: undefined, status: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).toThrow(/not a regular executable/iu);
  });

  it("rejects an intermediate target directory symlink", () => {
    const root = temporaryRoot();
    const targetRoot = join(root, "run-target");
    const plantedRoot = join(root, "planted");
    writeNativeCliPair(plantedRoot);

    expect(() =>
      buildSourceCliEnvironment(
        { env: {}, targetRoot },
        {
          repoRoot: join(root, "checkout"),
          runProcess() {
            symlinkSync(join(plantedRoot, "debug"), join(targetRoot, "debug"), "dir");
            return { error: undefined, status: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).toThrow(/symbolic link/iu);
  });

  it("refuses a pre-existing target so a source build cannot reuse a planted binary", () => {
    const root = temporaryRoot();
    const targetRoot = join(root, "run-target");
    mkdirSync(targetRoot);
    let invoked = false;

    expect(() =>
      buildSourceCliEnvironment(
        { env: {}, targetRoot },
        {
          repoRoot: join(root, "checkout"),
          runProcess() {
            invoked = true;
            return { error: undefined, status: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).toThrow(/newly owned/iu);
    expect(invoked).toBe(false);
  });
});
