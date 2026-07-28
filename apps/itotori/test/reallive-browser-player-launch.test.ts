import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realliveBrowserPlayerLaunch } from "../src/play/reallive-browser-player-launch.js";

describe("RealLive browser-player inventory launch", () => {
  it("does not create a launch when the private inventory has no selected corpus", () => {
    expect(realliveBrowserPlayerLaunch(undefined)).toBeUndefined();
  });

  it("derives every player input from the selected inventory root", () => {
    const root = "/private/reallive-corpus";

    expect(realliveBrowserPlayerLaunch(root)).toEqual({
      seenPath: join(root, "REALLIVEDATA", "Seen.txt"),
      gameexePath: join(root, "REALLIVEDATA", "Gameexe.ini"),
      g00Dir: join(root, "REALLIVEDATA", "G00"),
      artifactRoot: join(tmpdir(), "itotori-browser-player-e2e"),
      scene: 1,
    });
  });
});
