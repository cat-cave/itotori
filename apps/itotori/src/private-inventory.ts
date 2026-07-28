// Local, private corpus inventory loader. The same inventory/v1 table is
// parsed by corpus-registry for Rust consumers; this small reader gives the
// Node-only app and Playwright harnesses the identical identity lookup.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type InventoryRow = Readonly<{ id: string; engine: string; variant: string; root: string }>;

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
      const root = field("root");
      return id && engine && variant && root ? [{ id, engine, variant, root }] : [];
    });
}

/** Resolve one engine/title row from the private inventory without an env alias. */
export function resolvePrivateCorpus(
  engine: string,
  ordinal: number,
  variant: string,
): string | undefined {
  const path = inventoryPath();
  if (!existsSync(path)) return undefined;
  const id = `corpus-${engine}-${ordinal}-${variant}`;
  return rows(readFileSync(path, "utf8")).find(
    (row) => row.id === id && row.engine === `engine-${engine}`,
  )?.root;
}
