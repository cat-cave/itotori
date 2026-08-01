import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AuthorizationError,
  localUserId,
  permissionValues,
  type AuthorizationActor,
  type Permission,
} from "./authorization.js";
import {
  ArtifactStoreIntegrityError,
  ImmutableArtifactStore,
  type ArtifactActor,
  type ArtifactAuditEvent,
  type ArtifactAuthority,
  type ArtifactCapability,
  type ArtifactDescriptor,
  type ArtifactPruneReceipt,
  type ArtifactReference,
  type ArtifactRetentionPolicy,
  type ArtifactSnapshotExport,
} from "./immutable-artifact-store.js";
import { decodeArtifactSnapshot } from "./immutable-artifact-snapshot.js";
import type { LlmMemoCipher } from "./repositories/llm-call-memo-repository.js";

type StoredSnapshot = ArtifactSnapshotExport;

type ArtifactSnapshotPersistence = {
  load(): Promise<StoredSnapshot | undefined>;
  save(previousHash: string | undefined, next: StoredSnapshot): Promise<void>;
};

type ArtifactAuthorizer = (
  actor: AuthorizationActor,
  capability: ArtifactCapability,
) => Promise<void>;

const serviceActor: ArtifactActor = { actorId: "immutable-artifact-repository" };

class RepositoryAuthority implements ArtifactAuthority {
  #activeActor: string | undefined;
  #activeCapability: ArtifactCapability | undefined;

  hasCapability(actor: ArtifactActor, capability: ArtifactCapability): boolean {
    return actor.actorId === this.#activeActor && capability === this.#activeCapability;
  }

  run<T>(actor: ArtifactActor, capability: ArtifactCapability, operation: () => T): T {
    if (this.#activeActor !== undefined) throw new Error("artifact repository grant is nested");
    this.#activeActor = actor.actorId;
    this.#activeCapability = capability;
    try {
      return operation();
    } finally {
      this.#activeActor = undefined;
      this.#activeCapability = undefined;
    }
  }
}

export class ArtifactRepositoryConflictError extends Error {
  constructor() {
    super("immutable artifact repository changed during persistence");
    this.name = "ArtifactRepositoryConflictError";
  }
}

class AuthorizedImmutableArtifactRepository {
  readonly #authority: RepositoryAuthority;
  readonly #persistence: ArtifactSnapshotPersistence;
  readonly #authorize: ArtifactAuthorizer;
  readonly #store: ImmutableArtifactStore;
  readonly #allowRestrictedPersistence: boolean;
  #snapshotHash: string | undefined;
  #lastPersisted: ArtifactSnapshotExport | undefined;

  private constructor(input: {
    authority: RepositoryAuthority;
    persistence: ArtifactSnapshotPersistence;
    authorize: ArtifactAuthorizer;
    store: ImmutableArtifactStore;
    snapshotHash: string | undefined;
    allowRestrictedPersistence: boolean;
  }) {
    this.#authority = input.authority;
    this.#persistence = input.persistence;
    this.#authorize = input.authorize;
    this.#store = input.store;
    this.#snapshotHash = input.snapshotHash;
    this.#allowRestrictedPersistence = input.allowRestrictedPersistence;
  }

  static openLocal(
    root: string,
    cipher?: LlmMemoCipher,
  ): Promise<AuthorizedImmutableArtifactRepository> {
    return this.#open({
      persistence: new FileArtifactSnapshotPersistence(root, cipher),
      allowRestrictedPersistence: cipher !== undefined,
      authorize(actor, capability) {
        const permission = permissionForCapability(capability);
        return actor.userId === localUserId
          ? Promise.resolve()
          : Promise.reject(new AuthorizationError(actor, permission));
      },
    });
  }

  static async #open(input: {
    persistence: ArtifactSnapshotPersistence;
    authorize: ArtifactAuthorizer;
    allowRestrictedPersistence: boolean;
  }): Promise<AuthorizedImmutableArtifactRepository> {
    const authority = new RepositoryAuthority();
    const stored = await input.persistence.load();
    if (
      !input.allowRestrictedPersistence &&
      stored !== undefined &&
      decodeArtifactSnapshot(stored.serialized).artifacts.some(
        (artifact) => artifact.retention.classification === "restricted",
      )
    ) {
      throw new ArtifactStoreIntegrityError(
        "restricted local artifact persistence requires an explicit cipher",
      );
    }
    const store =
      stored === undefined
        ? ImmutableArtifactStore.create(authority)
        : ImmutableArtifactStore.reload(stored.serialized, stored.snapshotHash, authority);
    return new AuthorizedImmutableArtifactRepository({
      authority,
      persistence: input.persistence,
      authorize: input.authorize,
      store,
      snapshotHash: stored?.snapshotHash,
      allowRestrictedPersistence: input.allowRestrictedPersistence,
    });
  }

  put(
    actor: AuthorizationActor,
    input: {
      bytes: Uint8Array;
      retention: ArtifactRetentionPolicy;
      at: string;
      expectedId?: string;
      parents?: readonly string[];
    },
  ): Promise<ArtifactDescriptor> {
    return this.#perform(actor, "artifact:write", input.at, (storeActor) => {
      if (
        input.retention.classification === "restricted" &&
        !this.#allowRestrictedPersistence &&
        this.#authority.hasCapability(storeActor, "artifact:write")
      ) {
        throw new ArtifactStoreIntegrityError(
          "restricted local artifact persistence requires an explicit cipher",
        );
      }
      return this.#store.put({ ...input, actor: storeActor });
    });
  }

  addReference(
    actor: AuthorizationActor,
    input: {
      referenceId: string;
      artifactId: string;
      purpose: ArtifactReference["purpose"];
      at: string;
    },
  ): Promise<ArtifactReference> {
    return this.#perform(actor, "artifact:reference", input.at, (storeActor) =>
      this.#store.addReference({ ...input, actor: storeActor }),
    );
  }

  removeReference(
    actor: AuthorizationActor,
    input: { referenceId: string; at: string },
  ): Promise<void> {
    return this.#perform(actor, "artifact:reference", input.at, (storeActor) =>
      this.#store.removeReference({ ...input, actor: storeActor }),
    );
  }

  retain(
    actor: AuthorizationActor,
    input: { artifactId: string; until: string; at: string },
  ): Promise<void> {
    return this.#perform(actor, "artifact:retain", input.at, (storeActor) =>
      this.#store.retain({ ...input, actor: storeActor }),
    );
  }

  prune(
    actor: AuthorizationActor,
    input: { scope: readonly string[]; at: string },
  ): Promise<ArtifactPruneReceipt> {
    return this.#perform(actor, "artifact:prune", input.at, (storeActor) =>
      this.#store.prune({ ...input, actor: storeActor }),
    );
  }

  availability(
    actor: AuthorizationActor,
    input: { artifactId: string; at: string },
  ): Promise<
    | { artifactId: string; status: "available"; byteLength: number }
    | { artifactId: string; status: "missing" }
  > {
    return this.#perform(actor, "artifact:read", input.at, (storeActor) =>
      this.#store.availability({ ...input, actor: storeActor }),
    );
  }

  read(
    actor: AuthorizationActor,
    input: { artifactId: string; at: string },
  ): Promise<Uint8Array | undefined> {
    return this.#perform(actor, "artifact:read", input.at, (storeActor) =>
      this.#store.read({ ...input, actor: storeActor }),
    );
  }

  describe(
    actor: AuthorizationActor,
    input: { artifactId: string; at: string },
  ): Promise<ArtifactDescriptor | undefined> {
    return this.#perform(actor, "artifact:read", input.at, (storeActor) =>
      this.#store.describe({ ...input, actor: storeActor }),
    );
  }

  resolveReference(
    actor: AuthorizationActor,
    input: { referenceId: string; at: string },
  ): Promise<ArtifactReference | undefined> {
    return this.#perform(actor, "artifact:read", input.at, (storeActor) =>
      this.#store.resolveReference({ ...input, actor: storeActor }),
    );
  }

  auditTrail(actor: AuthorizationActor, at: string): Promise<readonly ArtifactAuditEvent[]> {
    return this.#perform(actor, "artifact:audit", at, (storeActor) =>
      this.#store.auditTrail({ actor: storeActor, at }),
    );
  }

  async exportSnapshot(actor: AuthorizationActor, at: string): Promise<ArtifactSnapshotExport> {
    await this.#perform(actor, "artifact:export", at, (storeActor) =>
      this.#store.exportSnapshot({ actor: storeActor, at }),
    );
    const persisted = this.#lastPersisted;
    if (persisted === undefined) throw new Error("artifact repository snapshot was not persisted");
    return { ...persisted };
  }

  async #perform<T>(
    actor: AuthorizationActor,
    capability: ArtifactCapability,
    at: string,
    operation: (storeActor: ArtifactActor) => T,
  ): Promise<T> {
    let authorizationFailure: unknown;
    try {
      await this.#authorize(actor, capability);
    } catch (error) {
      authorizationFailure = error;
    }
    const storeActor = { actorId: actor.userId };
    let completion: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      const value =
        authorizationFailure === undefined
          ? this.#authority.run(storeActor, capability, () => operation(storeActor))
          : operation(storeActor);
      completion = { ok: true, value };
    } catch (error) {
      completion = { ok: false, error };
    }
    await this.#persist(at);
    if (authorizationFailure !== undefined) throw authorizationFailure;
    if (!completion.ok) throw completion.error;
    return completion.value;
  }

  async #persist(at: string): Promise<void> {
    const exported = this.#export(at);
    await this.#persistence.save(this.#snapshotHash, exported);
    this.#snapshotHash = exported.snapshotHash;
    this.#lastPersisted = exported;
  }

  #export(at: string): ArtifactSnapshotExport {
    return this.#authority.run(serviceActor, "artifact:export", () =>
      this.#store.exportSnapshot({ actor: serviceActor, at }),
    );
  }
}

function permissionForCapability(capability: ArtifactCapability): Permission {
  if (capability === "artifact:read" || capability === "artifact:export") {
    return permissionValues.contentRead;
  }
  if (capability === "artifact:write" || capability === "artifact:reference") {
    return permissionValues.runtimeIngest;
  }
  if (capability === "artifact:retain" || capability === "artifact:prune") {
    return permissionValues.retentionManage;
  }
  return permissionValues.auditWrite;
}

class FileArtifactSnapshotPersistence implements ArtifactSnapshotPersistence {
  readonly #snapshotPath: string;
  readonly #referencePath: string;

  constructor(
    root: string,
    private readonly cipher?: LlmMemoCipher,
  ) {
    this.#snapshotPath = resolve(root, "immutable-artifacts.json");
    this.#referencePath = resolve(root, "immutable-artifacts.ref");
    mkdirSync(root, { recursive: true });
  }

  async load(): Promise<StoredSnapshot | undefined> {
    const hasSnapshot = existsSync(this.#snapshotPath);
    const hasReference = existsSync(this.#referencePath);
    if (!hasSnapshot && !hasReference) return undefined;
    if (!hasSnapshot || !hasReference) throw new Error("artifact repository files are incomplete");
    const persisted = readFileSync(this.#snapshotPath, "utf8");
    const envelope = localCipherEnvelope(persisted);
    if (envelope === undefined) {
      if (this.cipher !== undefined) {
        throw new ArtifactStoreIntegrityError("ciphered local repository contains plaintext");
      }
      return {
        serialized: persisted,
        snapshotHash: readFileSync(this.#referencePath, "utf8").trim(),
      };
    }
    if (this.cipher === undefined) {
      throw new ArtifactStoreIntegrityError("local artifact repository requires its cipher");
    }
    try {
      return {
        serialized: await this.cipher.open(
          Buffer.from(envelope.ciphertextBase64, "base64"),
          envelope.keyRef,
        ),
        snapshotHash: readFileSync(this.#referencePath, "utf8").trim(),
      };
    } catch (error: unknown) {
      throw new ArtifactStoreIntegrityError(
        `local artifact ciphertext could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async save(previousHash: string | undefined, next: StoredSnapshot): Promise<void> {
    const current = await this.load();
    if (current?.snapshotHash !== previousHash) throw new ArtifactRepositoryConflictError();
    const snapshotNext = `${this.#snapshotPath}.next`;
    const referenceNext = `${this.#referencePath}.next`;
    const sealed = this.cipher === undefined ? undefined : await this.cipher.seal(next.serialized);
    let persisted = next.serialized;
    if (sealed !== undefined) {
      persisted = `${JSON.stringify({
        schemaVersion: "itotori.local-artifact-envelope.v1",
        ciphertextBase64: Buffer.from(sealed.ciphertext).toString("base64"),
        keyRef: sealed.keyRef,
      })}\n`;
    }
    let installed = false;
    try {
      writeFileSync(snapshotNext, persisted, { encoding: "utf8", flag: "wx" });
      writeFileSync(referenceNext, `${next.snapshotHash}\n`, { encoding: "utf8", flag: "wx" });
      renameSync(snapshotNext, this.#snapshotPath);
      renameSync(referenceNext, this.#referencePath);
      installed = true;
    } finally {
      if (!installed && sealed !== undefined) {
        await this.cipher?.releaseKeyReference(sealed.keyRef);
      }
    }
  }
}

export async function openLocalImmutableArtifactRepository(
  root: string,
  cipher?: LlmMemoCipher,
): Promise<ImmutableArtifactRepository> {
  return AuthorizedImmutableArtifactRepository.openLocal(root, cipher);
}

export type ImmutableArtifactRepository = AuthorizedImmutableArtifactRepository;

type LocalCipherEnvelope = {
  schemaVersion: "itotori.local-artifact-envelope.v1";
  ciphertextBase64: string;
  keyRef: string;
};

function localCipherEnvelope(serialized: string): LocalCipherEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) {
    return undefined;
  }
  if (value.schemaVersion !== "itotori.local-artifact-envelope.v1") return undefined;
  if (
    !("ciphertextBase64" in value) ||
    typeof value.ciphertextBase64 !== "string" ||
    !("keyRef" in value) ||
    typeof value.keyRef !== "string"
  ) {
    throw new ArtifactStoreIntegrityError("local artifact cipher envelope is invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    ciphertextBase64: value.ciphertextBase64,
    keyRef: value.keyRef,
  };
}
