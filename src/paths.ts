import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export type Config = { toolLinks: boolean };
export const DEFAULT_CONFIG: Config = { toolLinks: true };
export type Metadata = { kind: "file" | "directory" };
export type Reference = { path: string; line?: number; column?: number };

/** Bounded positive/negative TTL cache, shared by Markdown and tool rendering. */
export class PathCache {
  private entries = new Map<string, { expires: number; value: Metadata | null }>();
  private readonly inspect: (p: string) => Metadata | null;
  private readonly now: () => number;
  private readonly max: number;
  private readonly ttl: number;
  constructor(inspect: (p: string) => Metadata | null = inspectPath,
    now: () => number = Date.now, max = 2048, ttl = 5000) {
    this.inspect = inspect; this.now = now; this.max = max; this.ttl = ttl;
  }
  get(p: string): Metadata | null {
    const hit = this.entries.get(p);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = this.inspect(p);
    this.entries.delete(p);
    this.entries.set(p, { value, expires: this.now() + this.ttl });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  clear() { this.entries.clear(); }
}

function inspectPath(p: string): Metadata | null {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return { kind: "directory" };
    if (stat.isFile()) return { kind: "file" };
    return null; // Devices, sockets and pipes are not linked. File contents are never read.
  } catch { return null; }
}

export function resolvePath(raw: string, cwd: string, home = homedir()): string | null {
  if (/[\x00-\x1f\x7f]/.test(raw) || /^[a-z][a-z\d+.-]*:\/\//i.test(raw) || /^(?:mailto|data):/i.test(raw)) return null;
  let p = raw.replace(/^@(?=[^\s@])/u, "");
  if (p === "~" || /^~[\\/]/.test(p)) p = home + p.slice(1);
  if (process.platform !== "win32" && (/^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\"))) return null;
  return path.resolve(cwd, p);
}

export function toFileUrl(p: string): string {
  return pathToFileURL(p, { windows: /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\") }).href;
}

export function targetUrl(ref: Reference): string {
  // No inferred editor or content type: unmatched paths always use the OS default.
  return toFileUrl(ref.path);
}

export function findReference(raw: string, cwd: string, cache: PathCache): { ref: Reference; meta: Metadata; label: string } | null {
  // Ellipses and repeated-slash markers are prose/comments, not directories.
  if (!raw || /^\.{3,}[.,;!?:)\]}]*$/.test(raw) || /^[\\/]{2,}[.,;!?:)\]}]*$/.test(raw)) return null;
  // Prefer literal filenames (including colons and punctuation) over source locations.
  const variants = [raw];
  let stripped = raw;
  while (variants.length < 8 && /[.,;!?:)\]}]$/.test(stripped)) { stripped = stripped.slice(0, -1); variants.push(stripped); }
  for (const label of variants) {
    // Trimming punctuation must never manufacture '.'/'..' or an empty path
    // (which path.resolve would interpret as the working directory).
    if (!label || (label !== raw && (label === "." || label === ".."))) continue;
    const p = resolvePath(label, cwd);
    if (!p) continue;
    // Windows silently aliases trailing dots/spaces to a different filename.
    const exact = process.platform === "win32" && /[. ]$/.test(label) ? null : cache.get(p);
    if (exact) return { ref: { path: p }, meta: exact, label };
    const loc = label.match(/^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/);
    if (!loc) continue;
    const target = resolvePath(loc[1], cwd);
    if (!target) continue;
    const meta = cache.get(target);
    const line = Number(loc[2] ?? loc[4]);
    const column = loc[3] ?? loc[5];
    if (meta && meta.kind !== "directory" && Number.isSafeInteger(line) && (!column || Number.isSafeInteger(Number(column)))) {
      return { ref: { path: target, line, ...(column ? { column: Number(column) } : {}) }, meta, label };
    }
  }
  return null;
}
