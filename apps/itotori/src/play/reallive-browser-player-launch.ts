import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserPlayerLaunch } from "./browser-player-session.js";
import { resolvePrivateCorpus } from "../private-inventory.js";

/**
 * Resolve the single private RealLive browser-proof descriptor. No inventory
 * record means no descriptor: callers must skip the private proof rather than
 * accidentally turning relative paths into a supposedly configured launch.
 */
export function realliveBrowserPlayerLaunchFromInventory(): BrowserPlayerLaunch | undefined {
  return realliveBrowserPlayerLaunch(resolvePrivateCorpus("reallive", 1, "encrypted"));
}

/** Build the fixed browser-proof launch only from an actual corpus root. */
export function realliveBrowserPlayerLaunch(
  root: string | undefined,
): BrowserPlayerLaunch | undefined {
  if (root === undefined || root.trim() === "") return undefined;
  const data = join(root, "REALLIVEDATA");
  return {
    seenPath: join(data, "Seen.txt"),
    gameexePath: join(data, "Gameexe.ini"),
    g00Dir: join(data, "G00"),
    artifactRoot: join(tmpdir(), "itotori-browser-player-e2e"),
    scene: 1,
  };
}
