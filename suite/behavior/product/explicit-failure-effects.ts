import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type SuccessArtifactName =
  | "missing-input-output.json"
  | "provider-localization.json"
  | "profile-patch.html"
  | "malformed-extraction.json"
  | "playback-receipt.json"
  | "patched-source.bin"
  | "published-evidence.json"
  | "admin-action.json"
  | "deadline-response.bin"
  | "cancellation-result.json"
  | "budgeted-localization.json"
  | "persisted-operation.json"
  | "restored-runtime-asset.bin"
  | "decrypted-runtime-asset.bin"
  | "prepared-source.bin"
  | "localized-output.json";

export interface OperationEffectObservation {
  readonly artifactName: SuccessArtifactName;
  readonly artifactPresent: boolean;
  readonly artifactBytes: number;
  readonly artifactNodeKind: "absent" | "file" | "other";
  readonly successCalls: number;
}

/** A success continuation can commit only through this dedicated output boundary. */
export class OperationEffectBoundary {
  readonly #artifactPath: string;
  #successCalls = 0;

  constructor(
    operationOutputRoot: string,
    readonly artifactName: SuccessArtifactName,
  ) {
    this.#artifactPath = resolve(operationOutputRoot, artifactName);
  }

  get outputPath(): string {
    return this.#artifactPath;
  }

  commit(bytes: string | Uint8Array): void {
    this.#successCalls += 1;
    writeFileSync(this.#artifactPath, bytes, { flag: "wx" });
  }

  observe(): OperationEffectObservation {
    if (!existsSync(this.#artifactPath)) {
      return {
        artifactName: this.artifactName,
        artifactPresent: false,
        artifactBytes: 0,
        artifactNodeKind: "absent",
        successCalls: this.#successCalls,
      };
    }
    const stat = lstatSync(this.#artifactPath);
    return {
      artifactName: this.artifactName,
      artifactPresent: true,
      artifactBytes: stat.isFile() ? stat.size : 0,
      artifactNodeKind: stat.isFile() ? "file" : "other",
      successCalls: this.#successCalls,
    };
  }
}
