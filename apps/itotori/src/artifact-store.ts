import { readFile, realpath } from "node:fs/promises";
import { type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve, sep } from "node:path";

const managedRuntimeArtifactUriRoot = "artifacts/utsushi/runtime/";
const privateRuntimeArtifactUriRoot = "artifacts/utsushi/private/";

export type ArtifactStoreRoots = {
  managedArtifactRoot?: URL;
  privateArtifactRoot?: URL;
  publicFixtureArtifactRoot?: URL;
};

export async function serveArtifactStoreRequest(input: {
  pathname: string;
  response: ServerResponse;
  roots: ArtifactStoreRoots;
  authorizeReveal: () => Promise<void>;
}): Promise<void> {
  const artifactUri = decodeArtifactStoreUri(input.pathname);
  if (artifactUri === null || !isArtifactStoreUri(artifactUri)) {
    writePlain(input.response, 400, "bad artifact uri");
    return;
  }

  try {
    // This is the server equivalent of RedactionGovernor.canReveal. The
    // browser's view of a capability is only an affordance; bytes leave only
    // after the permission authority grants the same reveal capability.
    await input.authorizeReveal();
  } catch {
    writePlain(input.response, 403, "reveal capability is required");
    return;
  }

  for (const candidate of candidatesFor(artifactUri, input.roots)) {
    const file = await readRootedFile(candidate.root, candidate.path);
    if (file !== null) {
      input.response.writeHead(200, { "content-type": contentType(artifactUri) });
      input.response.end(file);
      return;
    }
  }
  writePlain(input.response, 404, "not found");
}

function candidatesFor(uri: string, roots: ArtifactStoreRoots): Array<{ root: URL; path: string }> {
  const candidates: Array<{ root: URL; path: string }> = [];
  if (uri.startsWith(managedRuntimeArtifactUriRoot) && roots.managedArtifactRoot !== undefined) {
    candidates.push({
      root: roots.managedArtifactRoot,
      path: uri.slice(managedRuntimeArtifactUriRoot.length),
    });
  }
  if (uri.startsWith(privateRuntimeArtifactUriRoot) && roots.privateArtifactRoot !== undefined) {
    candidates.push({
      root: roots.privateArtifactRoot,
      path: uri.slice(privateRuntimeArtifactUriRoot.length),
    });
  }
  if (roots.publicFixtureArtifactRoot !== undefined) {
    candidates.push({ root: roots.publicFixtureArtifactRoot, path: uri });
  }
  return candidates;
}

function decodeArtifactStoreUri(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname.slice("/artifact-store/".length));
  } catch {
    return null;
  }
}

function isArtifactStoreUri(uri: string): boolean {
  return (
    (uri.startsWith(managedRuntimeArtifactUriRoot) ||
      uri.startsWith(privateRuntimeArtifactUriRoot)) &&
    !isUnsafeRelativePath(uri)
  );
}

function isUnsafeRelativePath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}

async function readRootedFile(root: URL, path: string): Promise<Buffer | null> {
  const rootPath = fileURLToPath(root);
  const candidatePath = resolve(rootPath, path);
  if (isOutsideRoot(relative(rootPath, candidatePath))) return null;
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(rootPath),
      realpath(candidatePath),
    ]);
    if (isOutsideRoot(relative(realRoot, realCandidate))) return null;
    return await readFile(realCandidate);
  } catch {
    return null;
  }
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".png":
      return "image/png";
    case ".webm":
      return "video/webm";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function writePlain(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(body);
}
