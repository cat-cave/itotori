import { generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostLifecycleError,
  applySignedHostUpdate,
  buildSignedReleaseManifest,
  canonicalReleaseManifest,
  initializeHostLifecycle,
  readHostLifecycleState,
  rollbackHostLifecycle,
} from "../src/install-lifecycle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("installed host lifecycle", () => {
  it("atomically promotes a real signed payload and retains data through rollback", () => {
    const work = tempRoot();
    const stateRoot = join(work, "host");
    const v1Payload = writePayload(work, "v1", "version-one");
    const initialized = initializeHostLifecycle({
      stateRoot,
      releaseVersion: "1.0.0",
      releasePayloadPath: v1Payload,
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(initialized.outcome).toBe("initialized");
    expect(lstatSync(initialized.activePayloadPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(initialized.activePayloadPath)).toBe(
      realpathSync(join(stateRoot, "releases", "1.0.0", "payload")),
    );
    expect(readFileSync(join(initialized.activePayloadPath, "cli.txt"), "utf8")).toBe(
      "version-one",
    );
    writeFileSync(join(stateRoot, "data", "retained.json"), '{"survives":true}\n');

    const key = generateKeyPairSync("ed25519");
    const release = signedRelease(work, "2.0.0", "version-two", key.privateKey);
    const publicKeyPath = join(work, "release-public-key.pem");
    writeFileSync(publicKeyPath, key.publicKey.export({ type: "spki", format: "pem" }));

    const updated = applySignedHostUpdate({
      stateRoot,
      updateDirectory: release,
      publicKeyPath,
      installedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(updated.outcome).toBe("updated");
    expect(updated.state.active.version).toBe("2.0.0");
    expect(updated.state.active.provenance.kind).toBe("signed-update");
    expect(realpathSync(updated.activePayloadPath)).toBe(
      realpathSync(join(stateRoot, "releases", "2.0.0", "payload")),
    );
    expect(readFileSync(join(updated.activePayloadPath, "cli.txt"), "utf8")).toBe("version-two");
    expect(readFileSync(join(stateRoot, "releases", "2.0.0", "payload", "cli.txt"), "utf8")).toBe(
      "version-two",
    );
    expect(readFileSync(join(stateRoot, "data", "retained.json"), "utf8")).toBe(
      '{"survives":true}\n',
    );

    const rolledBack = rollbackHostLifecycle({
      stateRoot,
      version: "1.0.0",
      installedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(rolledBack.outcome).toBe("rolled-back");
    expect(rolledBack.state.active.version).toBe("1.0.0");
    expect(realpathSync(rolledBack.activePayloadPath)).toBe(
      realpathSync(join(stateRoot, "releases", "1.0.0", "payload")),
    );
    expect(readFileSync(join(rolledBack.activePayloadPath, "cli.txt"), "utf8")).toBe("version-one");
    expect(readFileSync(join(stateRoot, "data", "retained.json"), "utf8")).toBe(
      '{"survives":true}\n',
    );
  });

  it("refuses invalid signatures and damaged payloads before replacing the active release", () => {
    const work = tempRoot();
    const stateRoot = join(work, "host");
    initializeHostLifecycle({
      stateRoot,
      releaseVersion: "1.0.0",
      releasePayloadPath: writePayload(work, "v1", "version-one"),
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    writeFileSync(join(stateRoot, "data", "retained.txt"), "must-survive");
    const before = JSON.stringify(readHostLifecycleState(stateRoot));
    const key = generateKeyPairSync("ed25519");
    const publicKeyPath = join(work, "release-public-key.pem");
    writeFileSync(publicKeyPath, key.publicKey.export({ type: "spki", format: "pem" }));

    const invalidSignatureRelease = signedRelease(work, "2.0.0", "version-two", key.privateKey);
    writeFileSync(
      join(invalidSignatureRelease, "signature.sig"),
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(() =>
      applySignedHostUpdate({ stateRoot, updateDirectory: invalidSignatureRelease, publicKeyPath }),
    ).toThrow("host lifecycle update refused before replacement: release signature is invalid");
    expect(JSON.stringify(readHostLifecycleState(stateRoot))).toBe(before);
    expect(existsSync(join(stateRoot, "releases", "2.0.0"))).toBe(false);
    expect(readFileSync(join(stateRoot, "data", "retained.txt"), "utf8")).toBe("must-survive");

    const damagedPayloadRelease = signedRelease(work, "2.1.0", "version-two", key.privateKey);
    writeFileSync(join(damagedPayloadRelease, "payload", "cli.txt"), "tampered-after-signing");
    expect(() =>
      applySignedHostUpdate({ stateRoot, updateDirectory: damagedPayloadRelease, publicKeyPath }),
    ).toThrow("payload files do not match the signed manifest");
    expect(JSON.stringify(readHostLifecycleState(stateRoot))).toBe(before);
    expect(existsSync(join(stateRoot, "releases", "2.1.0"))).toBe(false);
  });

  it("diagnoses a missing font before it creates host readiness state", () => {
    const work = tempRoot();
    const stateRoot = join(work, "host");
    expect(() =>
      initializeHostLifecycle({
        stateRoot,
        releaseVersion: "1.0.0",
        releasePayloadPath: writePayload(work, "v1", "version-one"),
        requiredFonts: ["Itotori Behavior Missing Font"],
      }),
    ).toThrow(HostLifecycleError);
    expect(() =>
      initializeHostLifecycle({
        stateRoot,
        releaseVersion: "1.0.0",
        releasePayloadPath: writePayload(work, "v1", "version-one"),
        requiredFonts: ["Itotori Behavior Missing Font"],
      }),
    ).toThrow("required font unavailable: Itotori Behavior Missing Font");
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("is singular when initialized again with the same installed payload", () => {
    const work = tempRoot();
    const stateRoot = join(work, "host");
    const input = {
      stateRoot,
      releaseVersion: "1.0.0",
      releasePayloadPath: writePayload(work, "v1", "version-one"),
      installedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(initializeHostLifecycle(input).outcome).toBe("initialized");
    unlinkSync(join(stateRoot, "current"));
    expect(initializeHostLifecycle(input).outcome).toBe("unchanged");
    expect(readHostLifecycleState(stateRoot).active.version).toBe("1.0.0");
    expect(realpathSync(join(stateRoot, "current"))).toBe(
      realpathSync(join(stateRoot, "releases", "1.0.0", "payload")),
    );
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-install-lifecycle-"));
  roots.push(root);
  return root;
}

function writePayload(root: string, name: string, contents: string): string {
  const payload = join(root, name, "payload");
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "cli.txt"), contents);
  return payload;
}

function signedRelease(
  root: string,
  version: string,
  contents: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  const release = join(root, `release-${version}`);
  const payload = join(release, "payload");
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "cli.txt"), contents);
  const manifest = buildSignedReleaseManifest({
    version,
    payloadPath: payload,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  writeFileSync(join(release, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(
    join(release, "signature.sig"),
    sign(null, Buffer.from(canonicalReleaseManifest(manifest)), privateKey).toString("base64"),
  );
  return release;
}
