/**
 * End-to-end check: linkified markdown through pi-tui's real Markdown component.
 * Asserts the OSC 8 escape + file:// URL reach the terminal stream (hyperlinks on)
 * and the parenthesized-URL fallback appears (hyperlinks off).
 * Run: node test/clickable-paths.e2e.test.ts (run from the repo root)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { linkifyPaths } from "../index.ts";

// Resolve pi-tui from the local pi install (global npm tree; override with PI_TUI_DIST).
// Skips with a note when pi is not installed locally.
function loadPiTui() {
	const dist = process.env.PI_TUI_DIST
		?? process.env.APPDATA + "/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
	if (!fs.existsSync(dist)) {
		console.log(`SKIP — pi-tui not found at ${dist} (set PI_TUI_DIST)`);
		process.exit(0);
	}
	return import("file:///" + dist.replace(/\\/g, "/"));
}

const { Markdown, setCapabilityOverrides, resetCapabilitiesCache } = await loadPiTui();

const id = (s: string) => s;
const theme: any = {
	heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id,
	quote: id, quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id,
	strikethrough: id, underline: id,
};

const tmp = path.join(import.meta.dirname, ".tmp-test");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const sample = path.join(tmp, "sample.txt");
fs.writeFileSync(sample, "hi");

const md = `Your file is in \`${sample}\`, see also .tmp-test/sample.txt.`;
const linkified = linkifyPaths(md, import.meta.dirname);
assert.ok(linkified.includes("](file:///C:/"), linkified);

// 1. hyperlink-capable terminal -> OSC 8 with file:/// URL in the rendered stream
setCapabilityOverrides({ hyperlinks: true });
resetCapabilitiesCache();
const joined = new Markdown(linkified, 0, 0, theme).render(100).join("\n");
assert.ok(joined.includes("\x1b]8;;file:///"), "OSC 8 escape missing in rendered output");
assert.ok(joined.includes(`file:///${sample.replace(/\\/g, "/")}`), "file:// URL missing in rendered output");
assert.ok(joined.includes("sample.txt"), "visible path text missing");

// 2. no hyperlink support -> parenthesized file URL fallback (text != href)
setCapabilityOverrides({ hyperlinks: false });
resetCapabilitiesCache();
const off = new Markdown(linkified, 0, 0, theme).render(100).join("\n");
assert.ok(off.includes("(file:///C:/"), "parenthesized fallback URL missing");
assert.ok(!off.includes("\x1b]8;;"), "OSC 8 must be absent when unsupported");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK — e2e: OSC 8 + fallback both render correctly through pi-tui Markdown");
