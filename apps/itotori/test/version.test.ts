import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import {
  runItotoriCliCommand,
  type ItotoriCliDependencies,
  type ItotoriCliServices,
} from "../src/cli-handlers.js";

describe("itotori --version", () => {
  it("prints the real product semver to stdout (not 0.0.0)", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["--version"], noOpDependencies());
    } finally {
      writes.restore();
    }
    expect(writes.chunks).toEqual([`itotori ${ITOTORI_PRODUCT_VERSION}\n`]);
  });

  it("-v is an alias for --version", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["-v"], noOpDependencies());
    } finally {
      writes.restore();
    }
    expect(writes.chunks).toEqual([`itotori ${ITOTORI_PRODUCT_VERSION}\n`]);
  });

  it("short-circuits before any service / database wiring", async () => {
    const dependencies = noOpDependencies();
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["--version"], dependencies);
    } finally {
      writes.restore();
    }
    expect(dependencies.migrateDatabase).not.toHaveBeenCalled();
    expect(dependencies.withServices).not.toHaveBeenCalled();
  });

  it("pins a stamped real semver (regression-fails on a 0.0.0 rollback)", () => {
    expect(ITOTORI_PRODUCT_VERSION).not.toBe("0.0.0");
    // Major.Minor.Patch, optionally with a SemVer pre-release / build suffix.
    expect(ITOTORI_PRODUCT_VERSION).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  });
});

function noOpDependencies(): ItotoriCliDependencies {
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn() },
    migrateDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async (callback: (services: ItotoriCliServices) => Promise<unknown>) =>
      callback({} as ItotoriCliServices),
    ),
  };
}

/**
 * Capture process.stdout.write by direct property swap. `vi.spyOn` on
 * `process.stdout.write` does not reliably intercept writes issued from a
 * separately-transformed module (the real write leaks to the console), so the
 * capture swaps the own `write` property directly and restores it in `finally`.
 */
function captureStdout(): { chunks: string[]; restore(): void } {
  const chunks: string[] = [];
  const stream = process.stdout;
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    chunks,
    restore() {
      stream.write = original;
    },
  };
}
