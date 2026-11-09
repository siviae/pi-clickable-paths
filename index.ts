/**
 * clickable-paths — makes file paths in the transcript clickable.
 *
 * The harness says "your file is in C:\...\foo.ts" and you want to click it.
 * This registers a Markdown transformer (display-only: never touches model
 * context) that rewrites paths that EXIST on disk into markdown links. Pi's
 * Markdown component renders those as OSC 8 hyperlinks, so the terminal
 * handles the click natively: Ctrl+click opens the file with its default app
 * (folders open in Explorer).
 *
 * Safety rails:
 *  - fenced code blocks are left untouched
 *  - existing markdown links and inline code that is not a path are left as-is
 *  - only paths that resolve to something on disk become links
 *  - URLs (http/file/mailto) and drive roots (C:\) are skipped
 *
 * Works in terminals with OSC 8 support (Windows Terminal, VS Code, iTerm2,
 * Ghostty). No support + `terminal.hyperlinks: auto` → plain text, no harm.
 *
 * Zero deps. Reload with /reload after editing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Existing markdown links: protect wholesale (their text/URL must not be re-linked).
const MD_LINK = /\[[^\]\n]*\]\([^)\n]+\)/g;
// Inline code spans: candidate paths hide here (the agent usually backticks paths).
const CODE_SPAN = /`([^`\n]+)`/g;
// Plain candidates: Windows abs, POSIX abs (>=2 segments), or relative with extension.
const PATH_RE =
	/(?<![\w/:@~.\-])(?:[A-Za-z]:[\\/][^\s<>()\[\]{}"'`,;|*?!~=]+|\/(?:[\w@.%+-]+\/)+[\w@.%+-]+|(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})/g;
// Greedy char classes swallow sentence punctuation: split it off the link.
const TRAILING = /[.,;:!?)\]}'"]+$/;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

export function toFileUrl(p: string): string {
	const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
	const drive = segs.length && /^[A-Za-z]:$/.test(segs[0]) ? segs.shift() : null;
	return "file:///" + (drive ? drive + "/" : "") + segs.map(encodeURIComponent).join("/");
}

/** "[core](file:///...)" when `raw` (a candidate) exists on disk, else null. */
export function toClickable(raw: string, cwd: string): string | null {
	const core = raw.replace(TRAILING, "");
	if (core.length < 3) return null;
	if (/^(https?|file|mailto|data):/i.test(core)) return null;
	const win = /^[A-Za-z]:[\\/]/.test(core);
	const posixAbs = core.startsWith("/");
	if (!win && !posixAbs && !core.includes("/")) return null;
	const bare = core.replace(/[\\/]+$/, "");
	if (!bare || bare === "/" || /^[A-Za-z]:$/.test(bare)) return null; // drive roots, "/" alone
	let target: string;
	try {
		target = win || posixAbs ? path.normalize(core) : path.resolve(cwd, core);
	} catch {
		return null;
	}
	try {
		if (!fs.existsSync(target)) return null;
	} catch {
		return null;
	}
	return `[${core}](${toFileUrl(target)})`;
}

function linkifyLine(line: string, cwd: string): string {
	const regions: { start: number; end: number; text: string }[] = [];
	const overlaps = (s: number, e: number) => regions.some((r) => s < r.end && e > r.start);
	for (const m of line.matchAll(MD_LINK)) regions.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	for (const m of line.matchAll(CODE_SPAN)) {
		const s = m.index, e = s + m[0].length;
		if (overlaps(s, e)) continue;
		const link = toClickable(m[1].trim(), cwd);
		regions.push({ start: s, end: e, text: link ?? m[0] });
	}
	for (const m of line.matchAll(PATH_RE)) {
		const core = m[0].replace(TRAILING, "");
		const s = m.index, e = s + core.length;
		if (e <= s || overlaps(s, e)) continue;
		const link = toClickable(core, cwd);
		if (link) regions.push({ start: s, end: e, text: link });
	}
	if (!regions.length) return line;
	regions.sort((a, b) => a.start - b.start);
	let out = "", pos = 0;
	for (const r of regions) {
		if (r.start < pos) continue;
		out += line.slice(pos, r.start) + r.text;
		pos = r.end;
	}
	return out + line.slice(pos);
}

/** Linkify paths outside fenced code blocks. */
export function linkifyPaths(md: string, cwd: string): string {
	if (!md.includes("\\") && !md.includes("/") && !md.includes("`")) return md;
	let inFence = false;
	let fence = "";
	return md
		.split("\n")
		.map((line) => {
			const f = line.match(FENCE_LINE);
			if (f) {
				if (!inFence) {
					inFence = true;
					fence = f[1];
				} else if (f[1][0] === fence[0] && f[1].length >= fence.length) {
					inFence = false;
				}
				return line;
			}
			return inFence ? line : linkifyLine(line, cwd);
		})
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	pi.registerMarkdownTransformer((markdown, ctx) =>
		ctx.messageType === "user" || ctx.messageType === "assistant" ? linkifyPaths(markdown, cwd) : markdown,
	);
}
