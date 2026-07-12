import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachProviderRunToThrownError,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
  type ProviderRunRecord,
} from "./types.js";

export class LocalProviderRunArtifactRecorder implements ProviderRunArtifactRecorder {
  constructor(private readonly baseDirectory = ".tmp/provider-runs") {}

  async recordProviderRun(artifact: ProviderRunArtifact): Promise<void> {
    const runDirectory = join(this.baseDirectory, safePathSegment(artifact.run.runId));
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "provider-run.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * Persist the provider artifact without losing the already-completed physical
 * call if local storage fails. The original error remains the thrown value;
 * the journal reads the opaque ProviderRunRecord attachment at its boundary.
 */
export async function recordProviderRunArtifact(args: {
  recorder: ProviderRunArtifactRecorder;
  artifact: ProviderRunArtifact;
  providerRun: ProviderRunRecord;
}): Promise<void> {
  try {
    await args.recorder.recordProviderRun(args.artifact);
  } catch (error) {
    throw attachProviderRunToThrownError(error, args.providerRun);
  }
}

function safePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}
