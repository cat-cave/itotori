import {
  activeHostLifecyclePayloadPath,
  applySignedHostUpdate,
  readHostLifecycleState,
  rollbackHostLifecycle,
} from "./install-lifecycle.js";

type LifecycleCommand = "update" | "rollback" | "lifecycle-status";

export function runLifecycleHandler(args: readonly string[], command: LifecycleCommand): void {
  switch (command) {
    case "update":
      print(
        applySignedHostUpdate({
          stateRoot: requiredFlag(args, "--state-root"),
          updateDirectory: requiredFlag(args, "--release"),
          publicKeyPath: requiredFlag(args, "--public-key"),
        }),
      );
      return;
    case "rollback":
      print(
        rollbackHostLifecycle({
          stateRoot: requiredFlag(args, "--state-root"),
          version: requiredFlag(args, "--version"),
        }),
      );
      return;
    case "lifecycle-status": {
      const stateRoot = requiredFlag(args, "--state-root");
      print({
        outcome: "status",
        state: readHostLifecycleState(stateRoot),
        activePayloadPath: activeHostLifecyclePayloadPath(stateRoot),
      });
    }
  }
}

function requiredFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new Error(`${flag} is required; run \`itotori ${args[0]} --help\` for usage`);
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
