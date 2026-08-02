/** Typed, value-free deployment input checks shared by real CLI startup paths. */
export class RequiredDeploymentInputError extends Error {
  readonly code: "missing-required-deployment-input" = "missing-required-deployment-input";
  readonly inputName: "DATABASE_URL" = "DATABASE_URL";

  constructor() {
    super("required deployment input DATABASE_URL is absent before database readiness");
    this.name = "RequiredDeploymentInputError";
  }
}

/** Resolve the database endpoint or refuse before opening a database connection. */
export function requireDatabaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env.DATABASE_URL;
  if (value === undefined || value.length === 0) throw new RequiredDeploymentInputError();
  return value;
}
