/** Typed, value-free deployment input checks shared by real CLI startup paths. */
export class RequiredDeploymentInputError extends Error {
  readonly code = "missing-required-deployment-input" as const;
  readonly inputName = "DATABASE_URL" as const;
  /** Operator action when the URL is not declared at all. */
  readonly remediation =
    "export DATABASE_URL from `just dev db-up` (or set it to your Postgres URL)";

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
