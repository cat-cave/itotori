import { createItotoriServer, type DashboardServerOptions } from "./server.js";
import { createProductionRetentionScheduler } from "./services/retention-deletion.js";
import type { RetentionScheduler } from "./services/retention-scheduler.js";

export type ItotoriServerRuntimeOptions = DashboardServerOptions & {
  readonly retentionScheduler?: RetentionScheduler;
};

const dashboardListenHost = "127.0.0.1";

/** Starts the HTTP service and its retention lifecycle together. The retention
 * run begins only after the listener is reachable and is stopped on close. */
export function startItotoriServer(options: ItotoriServerRuntimeOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? "4173");
  const retentionScheduler =
    options.retentionScheduler ??
    (options.databaseUrl === undefined
      ? createProductionRetentionScheduler({})
      : createProductionRetentionScheduler({ databaseUrl: options.databaseUrl }));
  const server = createItotoriServer(options);
  server.once("listening", () => {
    retentionScheduler.start();
    console.info(`Itotori dashboard listening on http://${dashboardListenHost}:${port}`);
  });
  server.once("close", () => retentionScheduler.stop());
  server.listen(port, dashboardListenHost);
  return server;
}
