import { extname } from "node:path";
import { targetUrl, type Metadata, type Reference } from "./paths.ts";
import type { Opener, Settings } from "./config.ts";

export function selectOpener(ref: Reference, meta: Metadata, config: Settings): Opener {
  if (meta.kind === "directory") return "system";
  const ext = extname(ref.path).slice(1).toLowerCase();
  return Object.hasOwn(config.extensionOpeners, ext) ? config.extensionOpeners[ext] : "system";
}

/** Pure rendering-time URL selection. No HTTP server, processes, or commands. */
export function openerUrl(ref: Reference, meta: Metadata, config: Settings): string {
  const opener = selectOpener(ref, meta, config);
  const file = targetUrl(ref);
  if (opener === "system") return file;
  const parsed = new URL(file);
  // File URL encoding protects spaces, Unicode, # and ? from becoming URI syntax.
  // UNC paths retain their server/share rather than dropping the server name.
  const editorPath = parsed.host ? `//${parsed.host}${parsed.pathname}` : parsed.pathname;
  const location = ref.line ? `:${ref.line}${ref.column ? `:${ref.column}` : ""}` : "";
  return `${opener}://file${editorPath}${location}`;
}
