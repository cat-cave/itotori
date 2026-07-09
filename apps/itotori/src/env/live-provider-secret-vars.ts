// The SINGLE source of truth for the live-provider secret env-var names that
// must NEVER reach a spawned native-CLI child process.
//
// Consumed by:
//   - apps/itotori/src/env/external-env-file.ts (the env-file allowlist),
//   - apps/itotori/src/native-bin/cli-bin-resolver.ts (the native-CLI spawn
//     scrub boundary), and
//   - scripts/native-deps.mjs (the standalone native-deps doctor, which is
//     Node-built-ins-only and runs BEFORE `pnpm install`, so it cannot import
//     this compiled module — instead it reads the JSON array embedded in the
//     marker block below at runtime; see `readLiveProviderSecretVars` there).
//
// Because the doctor parses the array out of THIS file's source, the list is
// defined exactly once here and can never drift between the app and the doctor.
//
// The set is the union of what the live OpenRouter path consumes:
//   - OPENROUTER_API_KEY               — the provider credential
//   - OPENROUTER_ZDR_ACCOUNT_ASSERTED  — the account-wide ZDR posture gate
//   - OPENROUTER_ZDR_DOWNGRADE         — operator-level per-leaf ZDR downgrade

// LIVE_PROVIDER_SECRET_VARS-JSON-START
const LIVE_PROVIDER_SECRET_VARS_JSON = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_ZDR_ACCOUNT_ASSERTED",
  "OPENROUTER_ZDR_DOWNGRADE",
];
// LIVE_PROVIDER_SECRET_VARS-JSON-END

/** The single source of truth for the live-provider secret env-var names. */
export const LIVE_PROVIDER_SECRET_VARS: readonly string[] = Object.freeze([
  ...LIVE_PROVIDER_SECRET_VARS_JSON,
]);

/**
 * Return a shallow copy of `env` with every live-provider secret removed. Used
 * at every native-CLI spawn boundary so a decode/render/probe child never
 * inherits the OpenRouter credentials. The source `env` is not mutated.
 */
export function scrubLiveProviderSecretsFromEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const scrubbed: Record<string, string | undefined> = { ...env };
  for (const key of LIVE_PROVIDER_SECRET_VARS) {
    delete scrubbed[key];
  }
  return scrubbed;
}
