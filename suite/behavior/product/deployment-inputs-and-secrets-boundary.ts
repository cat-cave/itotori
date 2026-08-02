/**
 * JSON-only observation of real deployment loaders. `modulePath` optionally
 * names a compiled config-module mutation; no observation is fabricated.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configurationText,
  encodeQuoted,
  exactEntries,
  fullConfiguration,
  loadConfiguration,
  loadEnvironment,
  missingRequiredDatabaseUrl,
  negativeControls,
  refusal,
  request,
  sameBytes,
  scenario,
  suppliedFileBytes,
  wrapperSecretFileRemoved,
  writePrivate,
  type DeploymentInputScenarioObservation,
  type NegativeControls,
  type Request,
  type StringEnvironment,
} from "./deployment-inputs-and-secrets-support.js";

export type { DeploymentInputScenarioObservation } from "./deployment-inputs-and-secrets-support.js";

export interface DeploymentInputsAndSecretsObservation {
  readonly schema: "itotori.deployment-inputs-and-secrets-observation.v1";
  readonly configurationSchemaCount: number;
  readonly missingRequiredDatabaseUrl: {
    readonly typed: boolean;
    readonly preReadiness: boolean;
    readonly code: string | null;
    readonly inputName: string | null;
    readonly configWrites: number;
  };
  readonly negativeControls: NegativeControls;
  readonly scenarios: readonly DeploymentInputScenarioObservation[];
  readonly observedFields: number;
}

function configArgs(path: string): readonly string[] {
  return ["--deployment-config", path];
}

function envArgs(path: string): readonly string[] {
  return ["--env-file", path];
}

export async function observeDeploymentInputsAndSecrets(
  input: Request,
): Promise<DeploymentInputsAndSecretsObservation> {
  const [configuration, environment] = await Promise.all([
    loadConfiguration(input),
    loadEnvironment(input),
  ]);
  const settingNames = configuration.DEPLOYMENT_CONFIG_SCHEMA.map((setting) => setting.name);
  if (
    settingNames.length < 33 ||
    new Set(settingNames).size !== settingNames.length ||
    !settingNames.includes("application.profile")
  ) {
    throw new Error("deployment-config-schema-not-closed-or-large-enough");
  }
  const root = mkdtempSync(join(tmpdir(), "itotori-deployment-observation-"));
  try {
    const controls = negativeControls(root, configuration, environment);
    const wrapperRemoved = wrapperSecretFileRemoved();
    const scenarios: DeploymentInputScenarioObservation[] = [];

    const localConfig = join(root, "local.conf");
    const localSecretPath = join(root, "local.env");
    const localSecret = "local-secret-not-for-output";
    writePrivate(localConfig, "application.profile=self-hosted");
    writePrivate(localSecretPath, `OPENROUTER_API_KEY=${encodeQuoted(localSecret)}`);
    const localValues = configuration.loadDeploymentConfigurationFile({
      args: configArgs(localConfig),
    }).values;
    const localEnv: StringEnvironment = {};
    const localLoaded = environment.loadExternalEnvFile({
      args: envArgs(localSecretPath),
      env: localEnv,
    });
    scenarios.push(
      scenario(
        "001",
        "ready",
        localValues.get("application.profile") === "self-hosted" &&
          localEnv.OPENROUTER_API_KEY === localSecret &&
          localLoaded.appliedKeys.join("\0") === "OPENROUTER_API_KEY",
        true,
        null,
        controls,
        !JSON.stringify(localLoaded).includes(localSecret),
        true,
        wrapperRemoved,
        localValues.size,
      ),
    );

    const managedConfig = join(root, "managed.conf");
    const managedSecretPath = join(root, "managed.env");
    const custodyReference = "custody-reference-not-for-output";
    writePrivate(managedConfig, "application.profile=managed");
    writePrivate(managedSecretPath, `OPENROUTER_ZDR_DOWNGRADE=${custodyReference}`);
    const managedValues = configuration.loadDeploymentConfigurationFile({
      args: configArgs(managedConfig),
    }).values;
    const managedEnv: StringEnvironment = {};
    const managedLoaded = environment.loadExternalEnvFile({
      args: envArgs(managedSecretPath),
      env: managedEnv,
    });
    scenarios.push(
      scenario(
        "002",
        "ready",
        managedValues.get("application.profile") === "managed" &&
          managedEnv.OPENROUTER_ZDR_DOWNGRADE === custodyReference &&
          managedLoaded.appliedKeys.join("\0") === "OPENROUTER_ZDR_DOWNGRADE",
        true,
        null,
        controls,
        !JSON.stringify(managedLoaded).includes(custodyReference),
        true,
        wrapperRemoved,
        managedValues.size,
      ),
    );

    const unknownConfig = join(root, "scenario-unknown.conf");
    const unknownSecret = "unknown-setting-secret-not-for-output";
    writePrivate(
      unknownConfig,
      `application.profile=self-hosted\nunknown.setting=${unknownSecret}`,
    );
    const unknown = refusal(
      () => configuration.loadDeploymentConfigurationFile({ args: configArgs(unknownConfig) }),
      unknownSecret,
    );
    scenarios.push(
      scenario(
        "003",
        "refused",
        false,
        unknown.code === "unknown-setting",
        unknown.code,
        controls,
        unknown.redacted,
        true,
        wrapperRemoved,
        0,
      ),
    );

    const insecureSecretPath = join(root, "scenario-insecure.env");
    const insecureSecret = "insecure-secret-not-for-output";
    writePrivate(insecureSecretPath, `OPENROUTER_API_KEY=${insecureSecret}\\`);
    // The source mode is part of the real loader admission check.
    chmodSync(insecureSecretPath, 0o644);
    const insecureTarget: StringEnvironment = {};
    const insecure = refusal(
      () =>
        environment.loadExternalEnvFile({ args: envArgs(insecureSecretPath), env: insecureTarget }),
      insecureSecret,
    );
    scenarios.push(
      scenario(
        "004",
        "refused",
        false,
        insecure.code === "source-permissions-insecure" &&
          insecureTarget.OPENROUTER_API_KEY === undefined,
        insecure.code,
        controls,
        insecure.redacted,
        true,
        wrapperRemoved,
        0,
      ),
    );

    const suppliedPath = join(root, "operator-supplied.env");
    const suppliedSecret = "supplied-secret-not-for-output";
    writePrivate(suppliedPath, `OPENROUTER_API_KEY=${encodeQuoted(suppliedSecret)}`);
    const suppliedBefore = suppliedFileBytes(suppliedPath);
    let interrupted = false;
    let suppliedLoaded = false;
    try {
      const suppliedEnv: StringEnvironment = {};
      const result = environment.loadExternalEnvFile({
        args: envArgs(suppliedPath),
        env: suppliedEnv,
      });
      suppliedLoaded =
        suppliedEnv.OPENROUTER_API_KEY === suppliedSecret && result.appliedKeys.length === 1;
      throw new Error("operator-interrupted-after-startup-validation");
    } catch (error) {
      interrupted =
        error instanceof Error && error.message === "operator-interrupted-after-startup-validation";
    }
    scenarios.push(
      scenario(
        "005",
        "interrupted",
        suppliedLoaded,
        interrupted,
        null,
        controls,
        true,
        sameBytes(suppliedBefore, suppliedFileBytes(suppliedPath)),
        wrapperRemoved,
        1,
      ),
    );

    const everyEntry = fullConfiguration(configuration);
    const everyPath = join(root, "all-documented.conf");
    writePrivate(everyPath, configurationText(everyEntry));
    const everyValues = configuration.loadDeploymentConfigurationFile({
      args: configArgs(everyPath),
    }).values;
    scenarios.push(
      scenario(
        "006",
        "ready",
        exactEntries(everyValues, everyEntry),
        true,
        null,
        controls,
        true,
        true,
        wrapperRemoved,
        everyValues.size,
      ),
    );

    const duplicatePath = join(root, "late-duplicate.conf");
    const duplicateValue = "duplicate-value-not-for-output";
    writePrivate(
      duplicatePath,
      `${configurationText(everyEntry)}\napplication.profile=${duplicateValue}`,
    );
    const duplicate = refusal(
      () => configuration.loadDeploymentConfigurationFile({ args: configArgs(duplicatePath) }),
      duplicateValue,
    );
    scenarios.push(
      scenario(
        "007",
        "refused",
        false,
        duplicate.code === "duplicate-setting",
        duplicate.code,
        controls,
        duplicate.redacted,
        true,
        wrapperRemoved,
        0,
      ),
    );

    const nonUnicodePath = join(root, "non-unicode.conf");
    writePrivate(nonUnicodePath, new Uint8Array([0xff, 0xfe, 0xfd]));
    const nonUnicode = refusal(
      () => configuration.loadDeploymentConfigurationFile({ args: configArgs(nonUnicodePath) }),
      "non-unicode-secret-not-for-output",
    );
    scenarios.push(
      scenario(
        "008",
        "refused",
        false,
        nonUnicode.code === "non-unicode",
        nonUnicode.code,
        controls,
        nonUnicode.redacted,
        true,
        wrapperRemoved,
        0,
      ),
    );

    const punctuationPath = join(root, "punctuation.env");
    const punctuation = 'dollar$ quote" space and \\ path';
    writePrivate(punctuationPath, `OPENROUTER_API_KEY=${encodeQuoted(punctuation)}`);
    const punctuationEnv: StringEnvironment = {};
    const punctuationLoaded = environment.loadExternalEnvFile({
      args: envArgs(punctuationPath),
      env: punctuationEnv,
    });
    scenarios.push(
      scenario(
        "009",
        "ready",
        punctuationEnv.OPENROUTER_API_KEY === punctuation,
        true,
        null,
        controls,
        !JSON.stringify(punctuationLoaded).includes(punctuation),
        true,
        wrapperRemoved,
        1,
      ),
    );

    const trailingPath = join(root, "trailing.env");
    const trailingSecret = "trailing-secret-not-for-output";
    writePrivate(trailingPath, `OPENROUTER_API_KEY=${trailingSecret}\\`);
    const trailingTarget: StringEnvironment = {};
    const trailing = refusal(
      () => environment.loadExternalEnvFile({ args: envArgs(trailingPath), env: trailingTarget }),
      trailingSecret,
    );
    scenarios.push(
      scenario(
        "010",
        "refused",
        false,
        trailing.code === "unsupported-value-form" &&
          trailingTarget.OPENROUTER_API_KEY === undefined,
        trailing.code,
        controls,
        trailing.redacted,
        true,
        wrapperRemoved,
        0,
      ),
    );

    return {
      schema: "itotori.deployment-inputs-and-secrets-observation.v1",
      configurationSchemaCount: settingNames.length,
      missingRequiredDatabaseUrl: await missingRequiredDatabaseUrl(),
      negativeControls: controls,
      scenarios,
      observedFields: settingNames.length + scenarios.length * 10 + 5,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `${JSON.stringify(await observeDeploymentInputsAndSecrets(request(process.argv[2])))}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
