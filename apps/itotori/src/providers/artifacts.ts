import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderRunArtifact, ProviderRunArtifactRecorder } from "./types.js";

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

function safePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}
