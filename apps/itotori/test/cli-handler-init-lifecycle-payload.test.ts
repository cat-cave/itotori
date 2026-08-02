import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstalledPackagePayloadPath } from "../src/cli-handler-init.js";
import { initializeHostLifecycle } from "../src/install-lifecycle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("managed host package payload discovery", () => {
  it("retains the full npm package root rather than the thin bin launcher", () => {
    const packageRoot = temporaryPackageRoot();
    const bundle = join(packageRoot, "dist", "cli.js");
    const payload = resolveInstalledPackagePayloadPath(pathToFileURL(bundle).href);

    expect(payload).toBe(realpathSync(packageRoot));
    expect(payload).not.toBe(realpathSync(join(packageRoot, "bin", "itotori.js")));
  });

  it("copies the complete installed package behind the active current release", () => {
    const packageRoot = temporaryPackageRoot();
    const bundle = join(packageRoot, "dist", "cli.js");
    const stateRoot = join(packageRoot, "host-state");
    const lifecycle = initializeHostLifecycle({
      stateRoot,
      releaseVersion: "1.0.0",
      releasePayloadPath: resolveInstalledPackagePayloadPath(pathToFileURL(bundle).href),
      installedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(lifecycle.activePayloadPath).toBe(join(stateRoot, "current"));
    expect(readFileSync(join(lifecycle.activePayloadPath, "bin", "itotori.js"), "utf8")).toBe(
      "export {};\n",
    );
    expect(readFileSync(join(lifecycle.activePayloadPath, "dist", "cli.js"), "utf8")).toBe(
      "export {};\n",
    );
    expect(existsSync(join(lifecycle.activePayloadPath, "migrations", "0001.sql"))).toBe(true);
  });

  it("requires the complete installable package layout", () => {
    const root = mkdtempSync(join(tmpdir(), "itotori-incomplete-package-"));
    roots.push(root);
    const bundle = join(root, "dist", "cli.js");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(bundle, "export {};\n");

    expect(() => resolveInstalledPackagePayloadPath(pathToFileURL(bundle).href)).toThrow(
      "complete installed package payload",
    );
  });
});

function temporaryPackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-installed-package-"));
  roots.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"itotori"}\n');
  writeFileSync(join(root, "bin", "itotori.js"), "export {};\n");
  writeFileSync(join(root, "dist", "cli.js"), "export {};\n");
  writeFileSync(join(root, "migrations", "0001.sql"), "select 1;\n");
  return root;
}
