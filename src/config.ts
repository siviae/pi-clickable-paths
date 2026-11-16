import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, type Config } from "./paths.ts";

export type Opener = "vscode" | "vscode-insiders" | "system";
export type Settings = Config & { extensionOpeners: Record<string, Opener> };
export const DEFAULT_SETTINGS: Settings = { ...DEFAULT_CONFIG, extensionOpeners: {} };

export function parseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Config must be a JSON object");
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key === "extensionCommands") throw new Error("extensionCommands is no longer supported. Use extensionOpeners with vscode, vscode-insiders or system. No HTTP command server is used.");
    if (!["extensionOpeners", "toolLinks"].includes(key)) throw new Error(`Unknown setting: ${key}`);
  }
  const out: Settings = { ...DEFAULT_SETTINGS, extensionOpeners: {} };
  if (v.toolLinks !== undefined) {
    if (typeof v.toolLinks !== "boolean") throw new Error("toolLinks must be a boolean");
    out.toolLinks = v.toolLinks;
  }
  if (v.extensionOpeners !== undefined) {
    if (!v.extensionOpeners || typeof v.extensionOpeners !== "object" || Array.isArray(v.extensionOpeners)) throw new Error("extensionOpeners must be an object");
    const assigned = new Set<string>();
    for (const [group, value] of Object.entries(v.extensionOpeners)) {
      const extensions = group.split(",").map(ext => ext.trim());
      if (!extensions.every(ext => /^\.?[a-z\d_-]+$/i.test(ext))) throw new Error(`Invalid extension group: ${group}`);
      if (value !== "vscode" && value !== "vscode-insiders" && value !== "system") throw new Error(`Invalid opener for ${group}: use vscode, vscode-insiders or system`);
      for (const raw of extensions) {
        const ext = raw.replace(/^\./, "").toLowerCase();
        if (assigned.has(ext)) throw new Error(`Duplicate extension in extensionOpeners: ${ext}`);
        assigned.add(ext);
        Object.defineProperty(out.extensionOpeners, ext, { value, enumerable: true, configurable: true, writable: true });
      }
    }
  }
  return out;
}
export function loadSettings(file: string): Settings {
  try { return parseSettings(JSON.parse(readFileSync(file, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS, extensionOpeners: {} }; throw error; }
}
