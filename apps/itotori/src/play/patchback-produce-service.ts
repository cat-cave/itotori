// Produce-a-playable-build service — the API-facing trigger for native patchback.
//
// A reviewer/corrector working in the Studio asks for a playable patched game.
// This service loads the run's produce plan (accepted outputs -> the strict
// native patchback input + the read-only source game root) through an injected
// port, drives the REAL native apply seam via `produceNativePatchbackBuild`
// (`kaifuu patch`), and hands the produced, hash-bound build to the SAME
// `createDeliveredPatchArchive` boundary the immutable-version delivery route
// uses. There is no second patchback path and no fabricated artifact: the
// downloaded tar is exactly the byte-surgical Kaifuu output.
//
// The produce plan loader is the composition boundary (the run-state adapter
// that resolves accepted outputs + source root); it is injected so this service
// stays free of the durability substrate and is drivable end-to-end in a test
// against real game bytes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuthorizationActor } from "@itotori/db";

import {
  createDeliveredPatchArchive,
  type DeliveredPatchArchive,
} from "../patch-export/delivery-archive.js";
import type { RealLivePatchScope } from "../patchback/apply.js";
import type { NativePatchbackInput } from "../patchback/types.js";
import { produceNativePatchbackBuild } from "../patchback/produce-build.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

/** What the reviewer is asking to finalize into a playable build. */
export type PatchbackProduceRequest = {
  projectId?: string;
  localeBranchId?: string;
  runId?: string;
};

/**
 * The resolved plan for one produce: the strict native patchback input, the
 * read-only source game root, the byte-fidelity scope, and (optionally) the run
 * whose accepted outputs are being finalized. Returned by the injected loader.
 */
export type LoadedProducePlan = {
  input: NativePatchbackInput;
  sourceRoot: string;
  scope: RealLivePatchScope;
  runId?: string;
};

/** The composition boundary: resolve a produce plan from run state. Returns null
 * when the request addresses no produce-eligible run (a clean 404). */
export interface PatchbackProduceInputLoaderPort {
  load(
    actor: AuthorizationActor,
    request: PatchbackProduceRequest,
  ): Promise<LoadedProducePlan | null>;
}

export type PatchbackProduceServiceDeps = {
  loader: PatchbackProduceInputLoaderPort;
  /** Test seam; production defaults to the real sanitized native-CLI spawn. */
  nativeCli?: NativeCliRunner;
  /** Owned temporary root for produced build trees (defaults to the OS tmpdir). */
  temporaryRoot?: string;
  now?: () => Date;
  log?: (message: string) => void;
};

export interface PatchbackProduceServicePort {
  produceArchive(
    actor: AuthorizationActor,
    request: PatchbackProduceRequest,
  ): Promise<DeliveredPatchArchive | null>;
}

/** Actor-bound projection wired at the HTTP boundary. */
export interface BoundPatchbackProduceServicePort {
  produceArchive(request: PatchbackProduceRequest): Promise<DeliveredPatchArchive | null>;
}

export class PatchbackProduceService implements PatchbackProduceServicePort {
  private readonly now: () => Date;

  constructor(private readonly deps: PatchbackProduceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async produceArchive(
    actor: AuthorizationActor,
    request: PatchbackProduceRequest,
  ): Promise<DeliveredPatchArchive | null> {
    const plan = await this.deps.loader.load(actor, request);
    if (plan === null) return null;

    const buildRoot = mkdtempSync(
      join(this.deps.temporaryRoot ?? tmpdir(), "itotori-patchback-produce-"),
    );
    const produced = produceNativePatchbackBuild(
      plan.input,
      {
        sourceRoot: plan.sourceRoot,
        buildRoot,
        scope: plan.scope,
        ...(plan.runId !== undefined ? { runId: plan.runId } : {}),
        ...(this.deps.nativeCli !== undefined ? { nativeCli: this.deps.nativeCli } : {}),
        ...(this.deps.log !== undefined ? { log: this.deps.log } : {}),
      },
      this.now,
    );
    try {
      // Capture the produced bytes into an in-memory tar BEFORE cleanup removes
      // the owned build tree. The archiver re-verifies the hash-bound manifest.
      return await createDeliveredPatchArchive(produced.patch);
    } finally {
      produced.cleanup();
    }
  }
}

export function bindPatchbackProduceService(
  service: PatchbackProduceServicePort,
  actor: AuthorizationActor,
): BoundPatchbackProduceServicePort {
  return {
    produceArchive: (request) => service.produceArchive(actor, request),
  };
}
