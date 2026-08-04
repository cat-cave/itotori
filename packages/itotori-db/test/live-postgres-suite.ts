// DB-owned suites call this at module registration time. Portable lanes do not
// collect them; a direct or misrouted run without Postgres must fail loudly.

export function requireLivePostgres<T>(registration: T): T {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("live Postgres test suite requires DATABASE_URL; run it in ci-tier1-db");
  }
  return registration;
}
