/**
 * The sub-path the app is served under, e.g. "/board", or "" at the origin root.
 *
 * It is fixed at build time by `SCOTTY_BASE_PATH` (see next.config.ts), which
 * sets Next's `basePath` and exposes the same value to client code here. Next
 * prefixes `<Link>`, `router.push` and its own assets by itself; anything that
 * builds a root-absolute URL by hand (`fetch`, `EventSource`, `href`,
 * `window.location`) must go through `withBasePath`.
 */
export const basePath: string = process.env.NEXT_PUBLIC_SCOTTY_BASE_PATH || "";

/** Prefix a root-absolute path ("/api/...", "/p/...") with the base path. */
export function withBasePath(path: string): string {
  return path.startsWith("/") ? `${basePath}${path}` : path;
}

/** Inverse for `window.location.pathname`: the path with the base path removed. */
export function stripBasePath(pathname: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}
