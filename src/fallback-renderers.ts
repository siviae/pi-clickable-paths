import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text, getCapabilities, getImageDimensions, imageFallback, stripTerminalSequences } from "@earendil-works/pi-tui";

/** Mirror Pi's generic header layout when a tool has no call renderer. */
export function fallbackCall(name: string, args: unknown, theme: Theme, expanded: boolean): Text {
  const title = theme.fg("toolTitle", theme.bold(name));
  if (args == null) return new Text(title, 0, 0);
  const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
  if (!entries.length) return new Text(title, 0, 0);
  let text: string;
  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
      return `  ${key}: ${raw.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
    });
    text = `${title}\n${theme.fg("muted", lines.join("\n"))}`;
  } else {
    const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
    const preview = pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs;
    text = `${title} ${theme.fg("muted", preview)}`;
  }
  return new Text(text, 0, 0);
}

/** Keep fallback collapse/image behavior while making its visible paths linkable. */
export function fallbackResult(result: AgentToolResult<unknown>, expanded: boolean, showImages: boolean,
  theme: Theme, keyHint: (id: "app.tools.expand", hint: string) => string): Text {
  const text = result.content.filter(c => c.type === "text").map(c => stripTerminalSequences(c.text ?? "")).join("\n").replace(/\r/g, "");
  const images = result.content.filter(c => c.type === "image");
  let output = text;
  if (images.length && (!getCapabilities().images || !showImages)) {
    const indicators = images.map(image => {
      const dims = image.data && image.mimeType ? getImageDimensions(image.data, image.mimeType) ?? undefined : undefined;
      return imageFallback(image.mimeType ?? "image/unknown", dims);
    }).join("\n");
    output = output ? `${output}\n${indicators}` : indicators;
  }
  const lines = output ? output.split("\n") : [];
  const visible = expanded ? lines : lines.slice(0, 10);
  let rendered = visible.map(line => theme.fg("toolOutput", line)).join("\n");
  const remaining = lines.length - visible.length;
  if (remaining) rendered += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  return new Text(rendered, 0, 0);
}
