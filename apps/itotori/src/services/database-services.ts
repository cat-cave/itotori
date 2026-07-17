import { databaseUrlFromEnv, migrate, resetDatabase } from "@itotori/db";

import type { ItotoriApiServices, ItotoriReadOnlyApiServices } from "../api-handlers.js";
import type { ItotoriCliServices } from "../cli-handlers.js";

/** The remaining command/API surfaces require a new-pipeline composition
 * substrate. The retired DB factory must never silently reconstruct the old
 * provider/journal graph. */
export type ItotoriApplicationServices = ItotoriCliServices & ItotoriApiServices;

export type ItotoriServiceFactory = <T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
  options?: { sessionId?: string },
) => Promise<T>;

export type ItotoriReadOnlyServiceFactory = <T>(
  callback: (services: ItotoriReadOnlyApiServices) => Promise<T>,
  options?: { sessionId?: string },
) => Promise<T>;

export class ItotoriInvalidAuthSessionError extends Error {
  constructor() {
    super("the requested authenticated service factory is not installed");
    this.name = "ItotoriInvalidAuthSessionError";
  }
}

export async function withDatabaseItotoriServices<T>(
  _options: { databaseUrl?: string; bootstrapLocalUser?: boolean; sessionId?: string },
  _callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  throw new Error(
    "database services are unavailable after the legacy cutover: install the new-pipeline composition substrate",
  );
}

export function toReadOnlyServiceFactory(
  factory: ItotoriServiceFactory,
): ItotoriReadOnlyServiceFactory {
  return async (callback, options) =>
    await factory(async (services) => await callback(services), options);
}

export async function migrateItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await migrate(databaseUrl);
}

export async function resetItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await resetDatabase(databaseUrl);
}

export function startDatabaseContextCorrectionWorker(_options?: unknown): { stop(): void } {
  return { stop: () => undefined };
}
