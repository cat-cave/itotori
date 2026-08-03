import { configuredServicePort } from "./configured-port.js";
import {
  defaultReadJson,
  defaultWriteJson,
  type DriveLocalizationPassDeps,
} from "./launch-localization-pass.js";
import {
  createDetachedLocalizationPassRunner,
  type LocalizationPassRunnerPort,
} from "./localization-pass-runner.js";
import {
  withDatabaseItotoriServices,
  type ItotoriServiceFactory,
  type ItotoriServiceFactoryOptions,
} from "./database-services.js";

/**
 * Build one server-lifetime service factory. Its runner registry is deliberately
 * shared by request-scoped DB services, allowing the pause mutation to signal
 * the detached worker admitted by the launch mutation.
 */
export function createDatabaseItotoriServiceFactory(
  options: { databaseUrl?: string } & ItotoriServiceFactoryOptions,
): ItotoriServiceFactory {
  let sharedRunner: LocalizationPassRunnerPort | undefined;
  const runner = createDetachedLocalizationPassRunner({
    openSession: async (run) => {
      if (sharedRunner === undefined) {
        throw new Error("localization pass runner was not installed on its service factory");
      }
      await withDatabaseItotoriServices(
        { ...options, passRunner: sharedRunner },
        async (session) => {
          const substrate = configuredServicePort(session, "localizationSubstrate");
          if (substrate === undefined) {
            throw new Error(
              "launch-pass refused: localizationSubstrate is not installed on the detached session",
            );
          }
          await run({
            readJson: defaultReadJson,
            writeJson: defaultWriteJson,
            projectWorkflow: session.projectWorkflow,
            resolvePortSource: (request, perRun) => substrate.resolvePortSource(request, perRun),
          } satisfies DriveLocalizationPassDeps);
        },
      );
    },
  });
  sharedRunner = runner;
  return async (callback, sessionOptions) =>
    await withDatabaseItotoriServices(
      { ...options, ...sessionOptions, passRunner: runner },
      callback,
    );
}
