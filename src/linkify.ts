import { fileURLToPath } from "node:url";
import { PathCache, findReference, targetUrl, type Metadata, type Reference } from "./paths.ts";

export type Span = { start: number; end: number; label: string; url: string; suffix?: string; replacement?: string };
export type Options = {
  cache?: PathCache; maxCandidates?: number;
  target?: (ref: Reference, meta: Metadata) => string;
  budget?: { remaining: number };
};
const sharedCache = new PathCache();
const escapeLabel = (s: string) => s.replace(/[\\`*_[\]<>]/g, "\\$&");
const markdownUrl = (s: string) => s.replace(/\(/g, "%28").replace(/\)/g, "%29");
const markdownLink = (s: Span) => `[${escapeLabel(s.label)}](${markdownUrl(s.url)})` + (s.suffix ?? "");
function codeFragment(text: string, ticks: string): string {
  if (!text) return "";
  // CommonMark trims one space from each end of a padded code span. Add our
  // own padding when needed so splitting a command doesn't change its text.
  const pad = (text.startsWith(" ") && text.endsWith(" ") && text.trim()) || text.startsWith("`") || text.endsWith("`");
  return ticks + (pad ? ` ${text} ` : text) + ticks;
}

// Full tokens, not substrings of URLs/email addresses. Unicode, drive letters,
// hidden files, single-segment absolute paths, and source locations are allowed.
const TOKEN = /[^\s<>"'`|=,;!?{}\[\]()]+/gu;
const URL = /(?:[a-z][a-z\d+.-]*:\/\/|mailto:|data:|www\.)[^\s<>]+/giu;
const candidate = (s: string, explicit: boolean) => explicit
  ? s.length > 0 && !/^[a-z][a-z\d+.-]*:\/\//i.test(s)
  : /[\\/]/.test(s) || /^@?(?:[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.-]+|\.[\p{L}\p{N}_.-]+)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?[.:]?$/u.test(s);

/** Find references without changing the source text. Bounds filesystem probes per invocation. */
export function findSpans(text: string, cwd: string, options: Options = {}, markdown = true): Span[] {
  const cache = options.cache ?? sharedCache;
  const spans: Span[] = [];
  const protectedRanges: [number, number][] = [];
  const overlaps = (s: number, e: number) => protectedRanges.some(([a, b]) => s < b && e > a);
  let attempts = 0;
  const add = (raw: string, start: number, explicit = false, end = start + raw.length) => {
    // A regex delimiter or division operator can be tokenized as '/' when the
    // next character is '[' or another separator. Don't infer a root path from
    // slash/dot-only punctuation; explicitly quoted/backticked roots still work.
    if (!explicit && /^[\\/][\\/.]*$/.test(raw)) return;
    if (!candidate(raw, explicit) || ++attempts > (options.maxCandidates ?? 128)) return;
    if (options.budget && options.budget.remaining-- <= 0) return;
    const found = findReference(raw, cwd, cache);
    if (!found) return;
    // Explicit inline code / quotes keep their delimiters; only replace inner text.
    spans.push({ start, end: end - (raw.length - found.label.length), label: found.label, url: options.target ? options.target(found.ref, found.meta) : targetUrl(found.ref) });
  };
  for (const m of text.matchAll(URL)) protectedRanges.push([m.index!, m.index! + m[0].length]);
  if (markdown) {
    // Existing inline links/images, reference links, and autolinks are owned by Markdown.
    // Balance link destinations so parentheses inside a destination are preserved.
    const links = /!?\[[^\]\n]*(?:\][^\]\n]*)?\](?:\(|\[[^\]\n]*\])/g;
    for (const m of text.matchAll(links)) {
      let end = m.index! + m[0].length;
      if (m[0].endsWith("(")) {
        let depth = 1;
        while (end < text.length && depth) {
          const c = text[end++];
          if (c === "\\") end++;
          else if (c === "(") depth++;
          else if (c === ")") depth--;
        }
      }
      protectedRanges.push([m.index!, end]);
    }
    for (const m of text.matchAll(/<[^>\n]+>/g)) protectedRanges.push([m.index!, m.index! + m[0].length]);
    for (const m of text.matchAll(/(`+)([^\n]*?)\1(?!`)/g)) {
      const start = m.index!, end = start + m[0].length;
      if (overlaps(start, end)) continue;
      protectedRanges.push([start, end]);
      const inner = m[2];
      if (inner === inner.trim()) {
        const before = spans.length;
        add(inner, start + m[1].length, true);
        if (spans.length > before) {
          const span = spans[spans.length - 1];
          span.suffix = inner.slice(span.label.length);
          span.start = start;
          span.end = end;
        } else {
          // A code span can be a command containing paths, not just one path.
          // Keep non-path portions as code and link only existing local paths.
          const innerSpans = findSpans(inner, cwd, options, false);
          if (innerSpans.length) {
            let replacement = "", pos = 0;
            for (const span of innerSpans) {
              if (span.start < pos) continue;
              replacement += codeFragment(inner.slice(pos, span.start), m[1]) + markdownLink(span);
              pos = span.end;
            }
            replacement += codeFragment(inner.slice(pos), m[1]);
            spans.push({ ...innerSpans[0], start, end, replacement });
          }
        }
      }
    }
    // Shortcut/collapsed reference links may have their definition elsewhere.
    for (const m of text.matchAll(/!?\[[^\]\n]*\]/g)) {
      const start = m.index!, end = start + m[0].length;
      if (!overlaps(start, end)) protectedRanges.push([start, end]);
    }
  }
  for (const m of text.matchAll(/(["'])([^\n]*?)\1/g)) {
    const start = m.index!, end = start + m[0].length;
    if (overlaps(start, end)) continue;
    protectedRanges.push([start, end]);
    add(m[2], start + 1, true);
  }
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index!, end = start + m[0].length;
    if (overlaps(start, end)) continue;
    // Do not interpret email addresses as bare filenames.
    if (m[0].includes("@") && !m[0].startsWith("@") && !/[\\/]/.test(m[0])) continue;
    // Unquoted absolute/home paths may contain spaces. Prefer the longest existing
    // prefix, bounded to 8 words / 512 chars. Ambiguous prose still needs quoting.
    if (/^(?:[a-z]:[\\/]|\/|~\/|\.\.?\/)/i.test(m[0])) {
      const tail = text.slice(start, start + 512).split(/[<>"'`|\[\]{}\n]/, 1)[0];
      const words = [...tail.matchAll(/\s+/g)].slice(0, 8).map(x => x.index!);
      const ends = [...words, Math.min(tail.length, words.length === 8 ? words[7] : tail.length)].sort((a, b) => b - a);
      let matched = false;
      for (const n of new Set(ends)) {
        if (n <= m[0].length || overlaps(start, start + n)) continue;
        const before = spans.length;
        add(tail.slice(0, n), start);
        if (spans.length > before) { matched = true; break; }
      }
      if (matched) { const s = spans[spans.length - 1]; protectedRanges.push([s.start, s.end]); continue; }
    }
    add(m[0], start);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Display-only Markdown rewriting. Fences and reference definitions stay untouched. */
export function linkifyPaths(md: string, cwd: string, options: Options = {}): string {
  let fence: string | undefined;
  const bounded = { ...options, budget: options.budget ?? { remaining: options.maxCandidates ?? 128 } };
  return md.split("\n").map(line => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = undefined;
      return line;
    }
    if (fence || /^\s{0,3}\[[^\]]+\]:/.test(line) || /^(?: {4}|\t)/.test(line)) return line;
    const spans = findSpans(line, cwd, bounded);
    let out = "", pos = 0;
    for (const s of spans) {
      if (s.start < pos) continue;
      out += line.slice(pos, s.start) + (s.replacement ?? markdownLink(s));
      pos = s.end;
    }
    return out + line.slice(pos);
  }).join("\n");
}

/** Retarget existing local file links using their URL, not their shortened label. */
function retargetFileLinks(line: string, options: Options): string {
  if (!options.target) return line;
  const cache = options.cache ?? sharedCache;
  let attempts = 0;
  return line.replace(/\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(\x07|\x1b\\)/g, (packet, params: string, uri: string, terminator: string) => {
    if (!/^file:/i.test(uri) || ++attempts > (options.maxCandidates ?? 128)) return packet;
    if (options.budget && options.budget.remaining-- <= 0) return packet;
    try {
      const url = new globalThis.URL(uri);
      // Don't drop fragments/queries or reinterpret remote/non-native file URLs.
      if (url.search || url.hash) return packet;
      const path = fileURLToPath(url);
      const meta = cache.get(path);
      if (!meta) return packet;
      const target = options.target!({ path }, meta);
      if (/[\x00-\x1f\x7f]/.test(target)) return packet;
      return `\x1b]8;${params};${target}${terminator}`;
    } catch { return packet; }
  });
}

/** Add OSC 8 links to already laid-out tool lines, preserving ANSI styles and width. */
export function linkifyTerminal(line: string, cwd: string, options: Options = {}): string {
  // Never reinterpret terminal images or alter their payloads.
  if (/\x1b(?:_G|\]1337;)/.test(line)) return line;
  const bounded = { ...options, budget: options.budget ?? { remaining: options.maxCandidates ?? 128 } };
  const retargeted = retargetFileLinks(line, bounded);
  // Process only the text outside existing OSC 8 spans, rather than skipping
  // an entire line because one of its paths was already linked by another renderer.
  const packets = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let out = "", pos = 0, linked = false;
  for (const packet of retargeted.matchAll(packets)) {
    const segment = retargeted.slice(pos, packet.index!);
    out += linked ? segment : linkifyUnlinkedTerminal(segment, cwd, bounded);
    out += packet[0];
    linked = packet[1].length > 0;
    pos = packet.index! + packet[0].length;
  }
  const tail = retargeted.slice(pos);
  return underlinePathLinks(out + (linked ? tail : linkifyUnlinkedTerminal(tail, cwd, bounded)));
}

/** Underline local path links without leaking the style into adjacent text. */
function underlinePathLinks(line: string): string {
  const tokens = /\x1b(?:\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\[([\d:;]*)m)/g;
  let out = "", pos = 0, linked = false, originalUnderline = "";
  for (const token of line.matchAll(tokens)) {
    out += line.slice(pos, token.index!) + token[0];
    if (token[1] !== undefined) {
      const pathLink = /^(?:file|vscode|vscode-insiders):/i.test(token[1]);
      if (pathLink) out += originalUnderline || "\x1b[4m";
      else if (linked) out += originalUnderline || "\x1b[24m";
      linked = pathLink;
    } else {
      const params = token[2].split(";");
      for (let i = 0; i < params.length; i++) {
        const code = params[i].split(":")[0];
        // RGB/indexed-color components can also be 0, 4, 21 or 24; they
        // aren't SGR attributes. Colon-form color components stay one token.
        if (["38", "48", "58"].includes(code) && !params[i].includes(":")) {
          if (params[i + 1] === "2") i += 4;
          else if (params[i + 1] === "5") i += 2;
          continue;
        }
        if (code === "0" || code === "" || code === "24" || params[i] === "4:0") originalUnderline = "";
        else if (code === "4" || code === "21") originalUnderline = `\x1b[${params[i]}m`;
      }
      // A renderer may reset all styles inside the label. Keep its colors and
      // other attributes, but reapply underline until the hyperlink closes.
      if (linked) out += originalUnderline || "\x1b[4m";
    }
    pos = token.index! + token[0].length;
  }
  return out + line.slice(pos) + (linked ? originalUnderline || "\x1b[24m" : "");
}

function linkifyUnlinkedTerminal(line: string, cwd: string, options: Options): string {
  const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
  const indices: number[] = [];
  let plain = "", pos = 0;
  for (const m of line.matchAll(ansi)) {
    for (let i = pos; i < m.index!; i++) { indices.push(i); plain += line[i]; }
    pos = m.index! + m[0].length;
  }
  for (let i = pos; i < line.length; i++) { indices.push(i); plain += line[i]; }
  let out = ""; pos = 0;
  for (const s of findSpans(plain, cwd, options, false)) {
    const start = indices[s.start], end = indices[s.end - 1] + 1;
    if (start < pos) continue;
    out += line.slice(pos, start) + `\x1b]8;;${s.url}\x1b\\` + line.slice(start, end) + "\x1b]8;;\x1b\\";
    pos = end;
  }
  return out + line.slice(pos);
}
