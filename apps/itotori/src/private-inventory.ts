// Local, private corpus inventory loader. The same inventory/v1 table is
// parsed by corpus-registry for Rust consumers; this small reader gives the
// Node-only app and Playwright harnesses the identical identity lookup.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { readRegisteredProjectEnv } from "./env/registry.js";

type InventoryRow = Readonly<{ id: string; engine: string; variant: string; relativePath: string }>;

function inventoryPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "itotori",
    "inventory.toml",
  );
}

function rows(text: string): InventoryRow[] {
  return text
    .split(/^\[\[corpus\]\]$/mu)
    .slice(1)
    .flatMap((section) => {
      const field = (name: string) =>
        new RegExp(`^${name}\\s*=\\s*"([^"]+)"\\s*$`, "mu").exec(section)?.[1];
      const id = field("id");
      const engine = field("engine");
      const variant = field("variant");
      const relativePath = field("relative_path");
      return id && engine && variant && relativePath
        ? [{ id, engine, variant, relativePath }]
        : [];
    });
}

/** Resolve one user-selected library beneath the one operator-owned media mount. */
export function resolvePrivateCorpus(
  engine: string,
  ordinal: number,
  variant: string,
): string | undefined {
  const path = inventoryPath();
  if (!existsSync(path)) return undefined;
  const id = `corpus-${engine}-${ordinal}-${variant}`;
  const row = rows(readFileSync(path, "utf8")).find(
    (candidate) => candidate.id === id && candidate.engine === `engine-${engine}`,
  );
  if (row === undefined || isAbsolute(row.relativePath) || row.relativePath.split("/").includes("..")) {
    return undefined;
  }
  const mediaRoot = readRegisteredProjectEnv(process.env, "ITOTORI_VAULT_ROOT");
  if (mediaRoot === undefined) return undefined;
  return resolve(mediaRoot, row.relativePath);
}
