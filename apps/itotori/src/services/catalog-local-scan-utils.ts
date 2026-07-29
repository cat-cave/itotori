import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, sep } from "node:path";

export const archiveExtensions = new Set([
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".tgz",
  ".gz",
  ".xz",
  ".bz2",
  ".iso",
  ".xp3",
  ".rpa",
  ".rgss3a",
  ".rvdata2",
]);
const installerExtensions = new Set([".exe", ".msi", ".dmg", ".pkg"]);
const scriptExtensions = new Set([".rpy", ".ks", ".txt", ".ini", ".json", ".rvdata2"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const audioExtensions = new Set([".ogg", ".wav", ".mp3", ".m4a"]);
const videoExtensions = new Set([".mp4", ".webm", ".avi", ".mpg", ".mpeg"]);
const publicExtensionKeys = new Set([
  "[none]",
  ...archiveExtensions,
  ...installerExtensions,
  ...scriptExtensions,
  ...imageExtensions,
  ...audioExtensions,
  ...videoExtensions,
]);
const unknownExtensionKey = "unknown_extension" as const;

export function normalizedExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === "" ? "[none]" : extension;
}
export function publicExtensionKey(extension: string): string {
  return publicExtensionKeys.has(extension) ? extension : unknownExtensionKey;
}
export function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}
export function leafSegment(path: string): string {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}
export function classifyFileKind(name: string, extension: string): string {
  if (archiveExtensions.has(extension)) return "archive";
  if (installerExtensions.has(extension)) return "installer";
  if (scriptExtensions.has(extension)) return "engine_or_script_metadata";
  if (imageExtensions.has(extension)) return "image_asset";
  if (audioExtensions.has(extension)) return "audio_asset";
  if (videoExtensions.has(extension)) return "video_asset";
  return "other";
}
export function increment(
  target: Record<string, number>,
  key: string,
  by: number,
): Record<string, number> {
  target[key] = (target[key] ?? 0) + by;
  return target;
}
export function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) increment(target, key, count);
}
export function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
export function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
export function safeReference(value: string): string | undefined {
  return /^[a-z0-9_.:-]+$/u.test(value) ? value : undefined;
}
export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}
export type PrivateHash = ((scope: string, value: string | Buffer) => string) & { key: string };
export function createPrivateHash(key: string): PrivateHash {
  const privateHash = ((scope: string, value: string | Buffer): string =>
    `sha256:${privateHashHex(key, scope, value)}`) as PrivateHash;
  privateHash.key = key;
  return privateHash;
}
export function privateHashHex(key: string, scope: string, value: string | Buffer): string {
  return createHmac("sha256", key).update(scope).update("\0").update(value).digest("hex");
}
function sha256(value: string | Buffer): string {
  return `sha256:${hashHex(value)}`;
}
function hashHex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
