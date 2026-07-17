// The kept `patch play` command's SOLE path into the new pipeline's runtime
// launcher.
//
// It parses the exact patch-version id (+ an optional launch descriptor) into a
// `PlayRequest` and drives it through the composition-root `runPlaySession`, which
// loads the hash-bound play surface and launches Utsushi's real replay runtime. It
// never touches the legacy `PatchIterationService.play` journal reservation/
// finalizer path the old handler dragged in. The play substrate (surface loader +
// runtime launcher) is injected so this module's own import closure reaches only
// the play entrypoint + its launcher port.

import { runPlaySession, type PlayEntrypointDeps, type PlayRequest } from "../composition/index.js";
import { optionalFlag, optionalJsonObjectFlag } from "./flags.js";

/** The minimal JSON store the play command writes its launch receipt to. */
export interface PlayCommandIo {
  writeJson(path: string, value: unknown): void;
}

/** The injected play substrate — the surface loader + runtime launcher enter
 * through this ONE seam. Production binds the clean surface loader + real launcher;
 * a proof binds doubles. */
export interface PlayCommandDeps {
  readonly io: PlayCommandIo;
  resolvePlayDeps(): PlayEntrypointDeps | Promise<PlayEntrypointDeps>;
  log?(message: string): void;
}

/** The patch-version id: `--patch-version <id>` or the third positional argument
 * (`itotori patch play <version>`). */
function requiredPatchVersionId(args: readonly string[]): string {
  const flag = optionalFlag(args, "--patch-version");
  if (flag !== undefined) return flag;
  const positional = args[2];
  if (positional === undefined || positional.length === 0 || positional.startsWith("--")) {
    throw new Error("itotori patch play requires <patch-version> or --patch-version <id>");
  }
  return positional;
}

/** Parse `itotori patch play <version> [--launch-json <object>]` into a request. */
export function parsePlayRequest(args: readonly string[]): PlayRequest {
  const patchVersionId = requiredPatchVersionId(args);
  const launchDescriptor = optionalJsonObjectFlag(args, "--launch-json");
  return {
    patchVersionId,
    ...(launchDescriptor === undefined ? {} : { launchDescriptor }),
  };
}

/** Drive one `itotori patch play` invocation through the new runtime launcher. */
export async function runPlayCommand(
  args: readonly string[],
  deps: PlayCommandDeps,
): Promise<void> {
  const request = parsePlayRequest(args);
  const playDeps = await deps.resolvePlayDeps();
  const receipt = await runPlaySession(playDeps, request);

  const outputPath = optionalFlag(args, "--output");
  if (outputPath !== undefined) {
    deps.io.writeJson(outputPath, receipt);
    return;
  }
  (deps.log ?? ((message: string) => process.stdout.write(`${message}\n`)))(
    JSON.stringify(receipt, null, 2),
  );
}
