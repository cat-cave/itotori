export const TS_LIKE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}
