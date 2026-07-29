import { afterEach, describe, expect, it } from "vitest";
import { createItotoriServer } from "../src/server.js";
import type {
  ItotoriApplicationServices,
  ItotoriServiceFactory,
} from "../src/services/database-services.js";

const servers: ReturnType<typeof createItotoriServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("dashboard API failure responses", () => {
  it("reports missing migrations without rendering the failed SQL or bound values", async () => {
    const response = await requestFromFactory(() => {
      const postgresError = Object.assign(new Error('relation "itotori_users" does not exist'), {
        code: "42P01",
      });
      return new Error(
        'Failed query: insert into "itotori_users" ("user_id") values ($1) params: local-user',
        { cause: postgresError },
      );
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "database_migrations_required",
      error: "Database migrations are not applied. Run itotori db-migrate, then refresh.",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/insert|params|local-user|itotori_users/i);
  });

  it("serves a dashboard read without passing a request-time bootstrap option", async () => {
    const factory: ItotoriServiceFactory = async (callback, options) => {
      expect(options).not.toHaveProperty("bootstrapLocalUser");
      return await callback({
        projectWorkflow: {
          async getDashboardDecisions() {
            return {
              projectId: "project-1",
              counts: {
                pendingDecisionCount: 0,
                projectFindingDecisionCount: 0,
                localeBranchFindingDecisionCount: 0,
                runtimeValidationDecisionCount: 0,
              },
              pendingDecisions: [],
            };
          },
        },
      } as ItotoriApplicationServices);
    };
    const server = createItotoriServer({ serviceFactory: factory });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/projects/decisions`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId: "project-1",
      counts: { pendingDecisionCount: 0 },
    });
  });

  it("does not expose unexpected error internals", async () => {
    const response = await requestFromFactory(
      () => new Error("Failed query: select secret_value from private_table params: secret"),
    );

    expect(response.body).toEqual({
      code: "internal_error",
      error: "The service could not complete this request. Check the server logs and try again.",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/select|params|secret/i);
  });

  it("reports a refused configured database endpoint without exposing its credentials", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://local-user:do-not-display@127.0.0.1:55432/local_db";
    try {
      const response = await requestFromFactory(() =>
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:55432"), {
          address: "127.0.0.1",
          code: "ECONNREFUSED",
          port: 55432,
        }),
      );

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        code: "database_unreachable",
        error:
          "Database at 127.0.0.1:55432/local_db is unreachable. Start it with just dev db-up, then refresh.",
      });
      expect(JSON.stringify(response.body)).not.toMatch(/local-user|do-not-display|postgres:/i);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("keeps a refused unrelated endpoint classified as an internal error", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://local-user:do-not-display@127.0.0.1:55432/local_db";
    try {
      const response = await requestFromFactory(() =>
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:55433"), {
          address: "127.0.0.1",
          code: "ECONNREFUSED",
          port: 55433,
        }),
      );

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: "internal_error",
        error: "The service could not complete this request. Check the server logs and try again.",
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("sanitizes a database failure caught inside a read handler", async () => {
    const server = createItotoriServer({
      serviceFactory: async (callback) =>
        await callback({
          projectWorkflow: {
            async getDashboardDecisions() {
              const postgresError = Object.assign(
                new Error('relation "itotori_users" does not exist'),
                {
                  code: "42P01",
                },
              );
              throw new Error('Failed query: select * from "itotori_users" params: local-user', {
                cause: postgresError,
              });
            },
          },
        } as unknown as ItotoriApplicationServices),
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/projects/decisions`);

    expect(await response.json()).toEqual({
      code: "database_migrations_required",
      error: "Database migrations are not applied. Run itotori db-migrate, then refresh.",
    });
  });

  it("reports a missing jobs read-model dependency as a typed migration failure, never an empty table", async () => {
    const server = createItotoriServer({
      readOnlyServiceFactory: async (callback) =>
        await callback({
          authorization: { async requirePermission() {} },
          jobs: {
            async loadRunTable() {
              const postgresError = Object.assign(
                new Error('relation "itotori_provider_runs" does not exist'),
                { code: "42P01" },
              );
              throw new Error("jobs provider-run dependency is unavailable", {
                cause: postgresError,
              });
            },
          },
        } as unknown as ItotoriApplicationServices),
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/jobs/run-table?projectId=project-1`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "database_migrations_required",
      error: "Database migrations are not applied. Run itotori db-migrate, then refresh.",
    });
  });
});

async function requestFromFactory(error: () => Error): Promise<{
  status: number;
  body: unknown;
}> {
  const server = createItotoriServer({
    readOnlyServiceFactory: async () => {
      throw error();
    },
  });
  servers.push(server);
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/api/projects/decisions`);
  return { status: response.status, body: await response.json() };
}

async function listen(server: ReturnType<typeof createItotoriServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
