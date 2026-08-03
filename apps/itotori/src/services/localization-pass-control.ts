export type LocalizationPassControlAction = "pause" | "resume";

/** A caller-requested pause is distinct from a failed localization operation. */
export class LocalizationPassPausedError extends Error {
  constructor(readonly journalRunId: string) {
    super(`localization pass ${journalRunId} was paused by the operator`);
    this.name = "LocalizationPassPausedError";
  }
}

/** Safe, discriminated feedback for an impossible lifecycle control request. */
export class LocalizationPassControlError extends Error {
  constructor(
    readonly reason:
      | "pause_requires_running"
      | "resume_requires_paused"
      | "run_not_found"
      | "configuration_missing"
      | "configuration_changed"
      | "worker_unavailable",
    readonly action: LocalizationPassControlAction,
    readonly journalRunId: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalizationPassControlError";
  }
}

export function isLocalizationPassPause(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof LocalizationPassPausedError;
}
