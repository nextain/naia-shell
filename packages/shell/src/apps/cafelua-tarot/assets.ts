/** Vite emits this module in assets; the package root is one directory above it. */
export function assetUrl(path: string, moduleUrl = import.meta.url): string {
  return new URL(path.replace(/^\//, ""), new URL("../", moduleUrl)).href;
}
