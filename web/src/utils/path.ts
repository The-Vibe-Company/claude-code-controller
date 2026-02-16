/**
 * Cross-platform path utilities for the frontend.
 * Handles both Unix (/) and Windows (\) path separators so that
 * paths received from Windows servers render correctly.
 */

/** Split a path on both / and \ */
export function splitPath(p: string): string[] {
  return p.split(/[\\/]/);
}

/** Return the last non-empty segment of a path (the "filename" or dir name). */
export function pathBasename(p: string): string {
  return splitPath(p).filter(Boolean).pop() || p;
}

/** Return the parent directory of a path. */
export function pathParent(p: string): string {
  const parts = splitPath(p);
  // Trim trailing empty segments (from trailing slashes)
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length <= 1) return p;
  parts.pop();
  const sep = p.includes("\\") ? "\\" : "/";
  const joined = parts.join(sep);
  if (joined === "") return sep;
  // Keep drive letter format on Windows (e.g. "C:\")
  if (/^[A-Za-z]:$/.test(joined)) return joined + "\\";
  return joined;
}

/** Check whether a path is a root path (/ or C:\ etc). */
export function isRootPath(p: string): boolean {
  return p === "/" || /^[A-Za-z]:[\\\/]?$/.test(p);
}

/** Return the last N segments of a path, joined with /. */
export function pathTail(p: string, n: number): string {
  return splitPath(p).filter(Boolean).slice(-n).join("/");
}
