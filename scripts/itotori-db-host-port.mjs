#!/usr/bin/env node
/**
 * Deterministic, bind-checked host-port allocation for the worktree product DB.
 *
 * Preferred port = deriveHostPort(worktree). On collision, probe forward within
 * the configured span. Never random. When allocation fails, the typed error
 * names the worktree, ports tried, and who holds them.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

import { deriveHostPort, portRange } from "./itotori-db-compose-env.mjs";

/** @typedef {{ port: number, identity: string, kind: "container" | "process" | "unknown" }} PortHolder */

/**
 * Typed failure when no free host port can be claimed for this worktree.
 */
export class HostPortUnavailableError extends Error {
  /**
   * @param {{
   *   worktreeRoot: string,
   *   preferredPort: number,
   *   portsTried: number[],
   *   holders: PortHolder[],
   * }} detail
   */
  constructor(detail) {
    const holderLines =
      detail.holders.length === 0
        ? "  (no holder identity resolved)"
        : detail.holders.map((h) => `  port ${h.port}: ${h.identity} (${h.kind})`).join("\n");
    super(
      `host port unavailable for product database in worktree ${detail.worktreeRoot}. ` +
        `preferred port ${detail.preferredPort}; tried ${detail.portsTried.join(", ")}.\n` +
        `holders:\n${holderLines}\n` +
        `Free one of those ports (or remove the foreign container) and re-run \`just dev db-up\`. ` +
        `Lifecycle-managed containers carry label com.itotori.product-db=1; ` +
        `foreign squatters are reported, never reaped.`,
    );
    this.name = "HostPortUnavailableError";
    /** @type {"host-port-unavailable"} */
    this.code = "host-port-unavailable";
    this.worktreeRoot = detail.worktreeRoot;
    this.preferredPort = detail.preferredPort;
    this.portsTried = detail.portsTried;
    this.holders = detail.holders;
    this.remediation = "just dev db-up";
  }
}

/**
 * Candidate ports starting at `preferred`, walking forward (wrapping once
 * within [base, base+span)). Deterministic for a given preferred + range.
 *
 * @param {number} preferred
 * @param {{ base: number, span: number }} range
 * @returns {number[]}
 */
export function candidatePorts(preferred, range) {
  const { base, span } = range;
  const startOffset = (((preferred - base) % span) + span) % span;
  const ports = [];
  for (let i = 0; i < span; i += 1) {
    ports.push(base + ((startOffset + i) % span));
  }
  return ports;
}

/**
 * Probe whether this process can exclusively bind the host port (IPv4 any).
 * Releases the bind before resolving so compose can claim it next.
 *
 * @param {number} port
 * @param {{ createServer?: typeof createServer }} [options]
 * @returns {Promise<boolean>}
 */
export function isPortBindable(port, options = {}) {
  const create = options.createServer ?? createServer;
  return new Promise((resolve) => {
    const server = create();
    server.unref();
    const done = (ok) => {
      try {
        server.close();
      } catch {
        // already closed
      }
      resolve(ok);
    };
    server.once("error", () => done(false));
    try {
      server.listen({ port, host: "0.0.0.0", exclusive: true }, () => done(true));
    } catch {
      done(false);
    }
  });
}

/**
 * Allocate a free host port for `worktreeRoot`.
 * Prefer the derived (or explicit) port when free; otherwise probe forward.
 *
 * @param {string} worktreeRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   isBindable?: (port: number) => boolean | Promise<boolean>,
 *   describeHolder?: (port: number, env: NodeJS.ProcessEnv) => PortHolder | null | Promise<PortHolder | null>,
 *   maxProbes?: number,
 * }} [options]
 * @returns {Promise<{ port: number, preferredPort: number, portsTried: number[], skipped: PortHolder[] }>}
 */
export async function allocateHostPort(worktreeRoot, env = process.env, options = {}) {
  const range = portRange(env);
  const explicit = env.ITOTORI_DB_HOST_PORT;
  const preferredPort = explicit ? parseExplicitPort(explicit) : deriveHostPort(worktreeRoot, env);
  const isBindable = options.isBindable ?? ((p) => isPortBindable(p));
  const describe = options.describeHolder ?? describePortHolder;
  // Explicit override: only that port. Derived: probe the whole span (capped).
  const maxProbes = options.maxProbes ?? (explicit ? 1 : Math.min(range.span, 64));
  const candidates = explicit
    ? [preferredPort]
    : candidatePorts(preferredPort, range).slice(0, maxProbes);

  /** @type {number[]} */
  const portsTried = [];
  /** @type {PortHolder[]} */
  const skipped = [];

  for (const port of candidates) {
    portsTried.push(port);
    const free = await isBindable(port);
    if (free) {
      return { port, preferredPort, portsTried, skipped };
    }
    const holder = (await describe(port, env)) ?? {
      port,
      identity: "unknown listener (bind probe failed)",
      kind: /** @type {const} */ ("unknown"),
    };
    skipped.push(holder);
  }

  throw new HostPortUnavailableError({
    worktreeRoot,
    preferredPort,
    portsTried,
    holders: skipped,
  });
}

/**
 * Identify who is holding a host TCP port: prefer container identity, then process.
 *
 * @param {number} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PortHolder | null}
 */
export function describePortHolder(port, env = process.env) {
  const container = findContainerHoldingPort(port, env);
  if (container) return container;
  const processHolder = findProcessHoldingPort(port);
  if (processHolder) return processHolder;
  return {
    port,
    identity: `port ${port} is not bindable (holder not identified)`,
    kind: "unknown",
  };
}

/**
 * @param {number} port
 * @param {NodeJS.ProcessEnv} env
 * @returns {PortHolder | null}
 */
function findContainerHoldingPort(port, env) {
  const listed = runDocker(
    ["ps", "--format", '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.itotori.product-db"}}'],
    env,
  );
  if (listed.status !== 0) return null;
  const needle = `:${port}->`;
  const needleHost = `0.0.0.0:${port}->`;
  const needleAny = `*:${port}->`;
  for (const line of listed.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, ports, productDb] = line.split("\t");
    if (!ports) continue;
    if (!ports.includes(needle) && !ports.includes(needleHost) && !ports.includes(needleAny)) {
      // Also match host-port-only publish forms like "57753/tcp"
      if (!new RegExp(`(^|,)\\s*${port}->`, "u").test(ports) && !ports.includes(`${port}->`)) {
        continue;
      }
    }
    const labeled = productDb === "1" ? "lifecycle-labeled" : "unlabeled/foreign";
    return {
      port,
      identity: `container ${name || id} (${labeled}; id=${(id || "").slice(0, 12)})`,
      kind: "container",
    };
  }
  return null;
}

/**
 * @param {number} port
 * @returns {PortHolder | null}
 */
function findProcessHoldingPort(port) {
  // ss is available on this platform; fall back quietly if not.
  const result = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  const portRe = new RegExp(`:${port}\\b`, "u");
  for (const line of result.stdout.split("\n")) {
    if (!portRe.test(line)) continue;
    const users = line.match(/users:\(\((.+)\)\)/u);
    const identity = users
      ? `process ${users[1]}`
      : `listener matching :${port} (ss; no users field — often needs elevated privileges)`;
    return { port, identity, kind: "process" };
  }
  return null;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseExplicitPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ITOTORI_DB_HOST_PORT must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runDocker(args, env) {
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
