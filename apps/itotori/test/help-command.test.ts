import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import { buildHelpText, ITOTORI_HELP_TEXT } from "../src/help-text.js";

describe("itotori --help / help", () => {
  it("prints the help text to stdout on --help", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["--help"], noOpDependencies());
    } finally {
      writes.restore();
    }
    const output = writes.chunks.join("");
    expect(output).toContain("itotori");
    expect(output).toContain("USAGE:");
    expect(output).toContain("init");
    expect(output).toContain("localize-game");
    expect(output).toContain("--version");
    expect(output).toContain("--help");
  });

  it("-h is an alias for --help", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["-h"], noOpDependencies());
    } finally {
      writes.restore();
    }
    const output = writes.chunks.join("");
    expect(output).toContain("USAGE:");
  });

  it("short-circuits before any service / database wiring", async () => {
    const dependencies = noOpDependencies();
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["--help"], dependencies);
    } finally {
      writes.restore();
    }
    expect(dependencies.migrateDatabase).not.toHaveBeenCalled();
    expect(dependencies.withServices).not.toHaveBeenCalled();
  });

  it("'help' command prints the same help text as --help", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["help"], noOpDependencies());
    } finally {
      writes.restore();
    }
    const output = writes.chunks.join("");
    expect(output).toContain("USAGE:");
    expect(output).toContain("init");
  });

  it("help --all includes advanced commands not in the default help", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["help", "--all"], noOpDependencies());
    } finally {
      writes.restore();
    }
    const output = writes.chunks.join("");
    expect(output).toContain("ADVANCED:");
    expect(output).toContain("dashboard-status");
    expect(output).toContain("telemetry-summary");
  });

  it("default help omits advanced commands", () => {
    expect(ITOTORI_HELP_TEXT).not.toContain("ADVANCED:");
    expect(ITOTORI_HELP_TEXT).not.toContain("dashboard-status");
  });

  it("help text includes the product version", () => {
    expect(buildHelpText(false)).toContain(ITOTORI_PRODUCT_VERSION);
  });

  it("help text includes key user commands", () => {
    const text = buildHelpText(false);
    expect(text).toContain("init");
    expect(text).toContain("localize-game");
    expect(text).toContain("extract");
    expect(text).toContain("structure-export");
    expect(text).toContain("localize");
    expect(text).toContain("patch");
    expect(text).toContain("validate");
    expect(text).toContain("db-migrate");
    expect(text).toContain("db-reset");
    expect(text).toContain("--allow-partial-patch");
  });

  it("--help takes precedence over --version", async () => {
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(["--help", "--version"], noOpDependencies());
    } finally {
      writes.restore();
    }
    const output = writes.chunks.join("");
    expect(output).toContain("USAGE:");
    expect(output).not.toContain(`itotori ${ITOTORI_PRODUCT_VERSION}\n\n`);
  });
});

function noOpDependencies() {
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn() },
    migrateDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async (callback: (services: ItotoriCliServices) => Promise<unknown>) =>
      callback({} as ItotoriCliServices),
    ),
  };
}

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
