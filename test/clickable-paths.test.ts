import assert from "node:assert/strict";
import { test, after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir, homedir } from "node:os";
import { linkifyPaths, linkifyTerminal } from "../src/linkify.ts";
import { PathCache, findReference, resolvePath, targetUrl, toFileUrl } from "../src/paths.ts";
import { parseSettings } from "../src/config.ts";
import { openerUrl, selectOpener } from "../src/opener.ts";

const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-clickable-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.mkdirSync(path.join(dir, "src"));
fs.mkdirSync(path.join(dir, "folder with spaces"));
for (const name of ["README.md", ".env", "src/main.ts", "my notes.md", "résumé.txt", "a(b)[c]#.txt", "LICENSE", ...(process.platform === "win32" ? [] : ["colon:42", "trailing."])]) fs.writeFileSync(path.join(dir, name), "Hello, world\n");
fs.writeFileSync(path.join(dir, "report.xlsx"), "PK zip data");
const fresh = () => ({ cache: new PathCache() });
const link = (text: string) => linkifyPaths(text, dir, fresh());
const fileUrl = (name: string) => toFileUrl(path.join(dir, name));
const withoutAddedUnderline = (s: string) => s.replace(/\x1b\[(?:4|24)m/g, "");

test("bare filenames, relative paths, dotfiles and punctuation", () => {
  for (const name of ["README.md", ".env", "src/main.ts", "résumé.txt"]) assert.ok(link(`see ${name}.`).includes(`](${fileUrl(name)})`), name);
  assert.equal(link("ordinary prose and someone@example.com"), "ordinary prose and someone@example.com");
  assert.equal(link("missing.txt"), "missing.txt");
});
test("backticks, quotes, spaces, Unicode, extensionless files and folders", () => {
  for (const name of ["my notes.md", "résumé.txt", "LICENSE", "folder with spaces"]) {
    assert.ok(link(`open \`${name}\``).includes("]("), name);
    assert.ok(link(`open "${name}"`).includes("]("), name);
  }
  const abs = path.join(dir, "my notes.md");
  assert.ok(link(`open ${abs} now`).includes(`](${fileUrl("my notes.md")}) now`));
  assert.ok(link(`\`${path.join(dir, "a(b)[c]#.txt")}\``).includes("%23.txt"));
});
test("ellipsis and punctuation never become links to the parent or current directory", () => {
  for (const text of ["...", "....", "......", "...!", "...:", "(...) ...", "`...`", "``...``", "…", "`…`"]) {
    assert.equal(link(text), text, text);
    assert.equal(linkifyTerminal(text, dir, fresh()), text, text);
  }
  const cache = new PathCache();
  for (const text of ["...", "...!", "...:", "", ".!", "..!"]) assert.equal(findReference(text, dir, cache), null, text);
  assert.equal(findReference("..", dir, cache)?.ref.path, path.dirname(dir));
  assert.equal(findReference(".", dir, cache)?.ref.path, dir);
  assert.equal(findReference("../README.md", path.join(dir, "src"), cache)?.ref.path, path.join(dir, "README.md"));
  assert.ok(link("`..`").includes("](file:///"));
  fs.writeFileSync(path.join(dir, "report...txt"), "text");
  assert.ok(link("report...txt").includes("](file:///"));
});

test("slash-only comment markers are not links, but the root directory still is", () => {
  for (const text of ["//", "///", "////", "//.", "//:", "`//`", "``//``", "// comment", "\\\\", "`\\\\`"]) {
    assert.equal(link(text), text, text);
    assert.equal(linkifyTerminal(text, dir, fresh()), text, text);
  }
  const cache = new PathCache();
  for (const text of ["//", "///", "//.", "//:", "\\\\"]) assert.equal(findReference(text, dir, cache), null, text);
  assert.equal(findReference("/", dir, cache)?.ref.path, path.parse(dir).root);
  assert.ok(findReference(dir, dir, cache));
});

test("regex delimiters and slash punctuation are not inferred as root paths", () => {
  const code = String.raw`while (variants.length < 8 && /[.,;!?:)\]}]$/.test(stripped))`;
  for (const text of [code, "`" + code + "`", "a / b", "return /[a-z]/.test(value)", "/", "/./", "/../", "\\"]) {
    assert.equal(link(text), text, text);
    assert.equal(linkifyTerminal(text, dir, fresh()), text, text);
  }
  const styled = "\x1b[32mwhile\x1b[0m (x && \x1b[31m/\x1b[0m[a-z]/.test(x))";
  assert.equal(linkifyTerminal(styled, dir, fresh()), styled);
  assert.ok(link("`/`").includes("](file:///"));
  assert.ok(link('"/"').includes("](file:///"));
  assert.ok(linkifyPaths("../README.md", path.join(dir, "src"), fresh()).includes("](file:///"));
  assert.ok(link(dir).includes("](file:///"));
});

test("source locations are parsed for editor links; literal filenames take precedence", () => {
  for (const input of ["src/main.ts:12:3", "src/main.ts#L12C3"]) {
    const found = findReference(input, dir, new PathCache())!;
    assert.deepEqual(found.ref, { path: path.join(dir, "src/main.ts"), line: 12, column: 3 });
    assert.ok(link(input).includes(`](${fileUrl("src/main.ts")})`));
  }
  if (process.platform !== "win32") {
    const found = findReference("colon:42", dir, new PathCache());
    assert.equal(found?.ref.path, path.join(dir, "colon:42"));
    assert.equal(found?.ref.line, undefined);
    assert.equal(findReference("trailing.", dir, new PathCache())?.label, "trailing.");
  }
});
test("home expansion, context cwd, @ references and single-segment absolute paths", () => {
  assert.equal(resolvePath("~/foo", dir), path.join(homedir(), "foo"));
  assert.equal(resolvePath("@src/main.ts", dir), path.join(dir, "src/main.ts"));
  assert.ok(link("@src/main.ts").includes("]("));
  assert.equal(resolvePath("README.md", path.join(dir, "src")), path.join(dir, "src", "README.md"));
  const rootFile = path.resolve("/file.txt");
  const fake = new PathCache(p => p === rootFile ? { kind: "file" } : null);
  assert.ok(linkifyPaths("/file.txt", path.parse(rootFile).root, { cache: fake }).includes(targetUrl({ path: rootFile })));
});
test("Markdown code, fences, links, reference definitions and URLs stay intact", () => {
  for (const text of [
    "```ts\nREADME.md\n```", "~~~\nREADME.md\n~~~", "    README.md",
    "[README.md](https://example.com/a(b))", "![README.md](src/main.ts)",
    "[README.md][ref]", "[README.md]", "[ref]: src/main.ts", "<README.md>",
    "`[README.md](https://example.com)`", "``[README.md](https://example.com)``",
    "https://example.com/src/main.ts", "file:///src/main.ts", "www.example.com/README.md", "`not a path`",
  ]) assert.equal(link(text), text, text);
  assert.ok(link("``README.md``").startsWith("[README.md]("));
  assert.equal(link("```\nREADME.md\n``` not closing\nREADME.md"), "```\nREADME.md\n``` not closing\nREADME.md");
});
test("all unmatched files and folders use system URLs, never inferred editor schemes", () => {
  for (const name of ["README.md", "report.xlsx", "LICENSE", "folder with spaces"]) {
    const output = link(`\`${name}\``);
    assert.ok(output.includes(`](${fileUrl(name)})`));
    assert.ok(!output.includes("vscode:"));
  }
});
test("Windows drive and UNC URL encoding independent of test platform", () => {
  assert.equal(toFileUrl("C:\\Users\\me\\my file#.txt"), "file:///C:/Users/me/my%20file%23.txt");
  assert.equal(toFileUrl("\\\\server\\share\\my file.xlsx"), "file://server/share/my%20file.xlsx");
  assert.equal(targetUrl({ path: "C:\\test\\a.txt", line: 3, column: 2 }), "file:///C:/test/a.txt");
});
test("terminal rendering preserves ANSI and existing links", () => {
  const input = "\x1b[31msrc/\x1b[1mmain.ts:12:3\x1b[0m";
  const output = linkifyTerminal(input, dir, fresh());
  assert.ok(output.includes("\x1b]8;;file:///"));
  assert.ok(output.includes("\x1b[4m"));
  assert.equal(withoutAddedUnderline(output.replace(/\x1b\]8;;.*?\x1b\\/g, "")), input);
  const existing = "\x1b]8;;https://example.com\x1b\\README.md\x1b]8;;\x1b\\";
  assert.equal(linkifyTerminal(existing, dir), existing);
});
test("existing local file OSC 8 destinations follow opener rules without changing labels or styles", () => {
  const config = parseSettings({ extensionOpeners: { md: "vscode" } });
  const opts = { ...fresh(), target: (ref: Parameters<typeof openerUrl>[0], meta: Parameters<typeof openerUrl>[1]) => openerUrl(ref, meta, config) };
  const file = fileUrl("README.md");
  const target = openerUrl({ path: path.join(dir, "README.md") }, { kind: "file" }, config);
  for (const terminator of ["\x07", "\x1b\\"]) {
    const original = `write \x1b]8;id=header;${file}${terminator}\x1b[36m~/short/README.md\x1b[0m\x1b]8;;${terminator}`;
    assert.equal(withoutAddedUnderline(linkifyTerminal(original, dir, opts)), original.replace(file, target));
  }
  for (const uri of ["https://github.com/earendil-works/pi", "vscode://file/a.md", fileUrl("report.xlsx"), file + "#fragment", file + "?query=1", "file:///missing/pi-clickable.md", "file:///%ZZ.md"]) {
    const original = `\x1b]8;;${uri}\x1b\\label\x1b]8;;\x1b\\`;
    assert.equal(withoutAddedUnderline(linkifyTerminal(original, dir, opts)), original, uri);
  }
  const prose = "Clickable local paths in [Pi](https://github.com/earendil-works/pi).";
  assert.equal(linkifyTerminal(prose, dir, opts), prose);
});

test("an existing link does not prevent other paths on the same tool line from being linked", () => {
  const config = parseSettings({ extensionOpeners: { md: "vscode" } });
  const opts = { ...fresh(), target: (ref: Parameters<typeof openerUrl>[0], meta: Parameters<typeof openerUrl>[1]) => openerUrl(ref, meta, config) };
  const existing = "\x1b]8;;https://example.com\x1b\\README.md\x1b]8;;\x1b\\";
  const output = linkifyTerminal(`${existing} and README.md`, dir, opts);
  assert.ok(output.startsWith(existing + " and "), output);
  const expected = openerUrl({ path: path.join(dir, "README.md") }, { kind: "file" }, config);
  assert.ok(output.includes(` and \x1b]8;;${expected}\x1b\\\x1b[4mREADME.md\x1b]8;;\x1b\\\x1b[24m`), output);
});

test("local tool links are underlined through style resets and restore the surrounding style", () => {
  const open = `\x1b]8;;${fileUrl("README.md")}\x1b\\`;
  const close = "\x1b]8;;\x1b\\";
  const original = `before ${open}\x1b[31mREADME\x1b[0m.md${close} after`;
  const output = linkifyTerminal(original, dir);
  assert.ok(output.includes(open + "\x1b[4m"));
  assert.ok(output.includes("\x1b[0m\x1b[4m.md"), output);
  assert.ok(output.endsWith(close + "\x1b[24m after"), output);
  assert.equal(withoutAddedUnderline(output), original);

  const double = linkifyTerminal(`\x1b[4:2m before ${open}README.md${close} after`, dir);
  assert.ok(double.endsWith(close + "\x1b[4:2m after"), double);
  const rgb = linkifyTerminal(`\x1b[38;2;4;0;24m before ${open}README.md${close} after`, dir);
  assert.ok(rgb.endsWith(close + "\x1b[24m after"), rgb);
  const indexed = linkifyTerminal(`\x1b[38;5;4m before ${open}README.md${close} after`, dir);
  assert.ok(indexed.endsWith(close + "\x1b[24m after"), indexed);
  const web = "\x1b]8;;https://example.com\x1b\\Pi\x1b]8;;\x1b\\";
  assert.equal(linkifyTerminal(web, dir), web);
  const plain = "\x1b[4:2mplain text\x1b[24m";
  assert.equal(linkifyTerminal(plain, dir), plain);
});

test("positive/negative TTL cache, bounded size and explicit clear", () => {
  let now = 0, calls = 0;
  const cache = new PathCache(() => { calls++; return null; }, () => now, 2, 10);
  cache.get("a"); cache.get("a"); assert.equal(calls, 1);
  now = 11; cache.get("a"); assert.equal(calls, 2);
  cache.get("b"); cache.get("c"); cache.get("a"); assert.equal(calls, 5);
  cache.clear(); cache.get("a"); assert.equal(calls, 6);
});
test("candidate budget applies to the whole message", () => {
  let probes = 0;
  const cache = new PathCache(() => { probes++; return null; });
  linkifyPaths(Array.from({ length: 5000 }, (_, i) => `missing${i}.txt`).join("\n"), dir, { cache, maxCandidates: 10 });
  assert.ok(probes <= 10, `unexpected probes: ${probes}`);
});
test("grouped extension openers, normalization and invalid configs", () => {
  const cfg = parseSettings({ extensionOpeners: { " md, .TXT, json ": "vscode", ".XLSX, ods": "system" } });
  assert.deepEqual(Object.keys(cfg.extensionOpeners), ["md", "txt", "json", "xlsx", "ods"]);
  assert.equal(cfg.extensionOpeners.md, "vscode");
  assert.equal(cfg.extensionOpeners.txt, "vscode");
  assert.equal(cfg.extensionOpeners.xlsx, "system");
  for (const config of [
    { extensionOpeners: { md: "code %s" } }, { extensionOpeners: { md: ["code", "%s"] } },
    { extensionOpeners: { md: "http://127.0.0.1/" } }, { toolLinks: "yes" },
    { extensionOpeners: { "md,": "vscode" } }, { extensionOpeners: { "md,txt": "vscode", ".MD": "system" } },
    { textCommand: "code %s" }, { extensionCommands: { md: "code %s" } },
  ]) assert.throws(() => parseSettings(config));
  assert.throws(() => parseSettings({ extensionCommands: {} }), /extensionOpeners/);
});
test("VS Code is opt-in by extension; unmatched files and all folders use the system", () => {
  const cfg = parseSettings({ extensionOpeners: { "md,txt": "vscode", "xlsx,ods": "system" } });
  assert.equal(selectOpener({ path: "/a.txt" }, { kind: "file" }, cfg), "vscode");
  assert.equal(selectOpener({ path: "/a.XLSX" }, { kind: "file" }, cfg), "system");
  assert.equal(selectOpener({ path: "/a.py" }, { kind: "file" }, cfg), "system");
  assert.equal(selectOpener({ path: "/LICENSE" }, { kind: "file" }, cfg), "system");
  assert.equal(selectOpener({ path: "/folder.txt" }, { kind: "directory" }, cfg), "system");
});
test("direct VS Code URIs include encoded paths and source locations, not localhost URLs", () => {
  const cfg = parseSettings({ extensionOpeners: { "md,txt": "vscode" } });
  const ref = { path: path.join(dir, "my notes.md"), line: 42, column: 2 };
  const url = openerUrl(ref, { kind: "file" }, cfg);
  assert.equal(url, "vscode://file" + new URL(toFileUrl(ref.path)).pathname + ":42:2");
  assert.equal(openerUrl({ ...ref, column: undefined }, { kind: "file" }, cfg), url.replace(/:2$/, ""));
  assert.equal(openerUrl({ path: ref.path }, { kind: "file" }, cfg), url.replace(/:42:2$/, ""));
  assert.ok(!url.includes("127.0.0.1"));
  assert.equal(openerUrl({ path: path.join(dir, "report.xlsx") }, { kind: "file" }, cfg), fileUrl("report.xlsx"));
  const special = { path: path.join(dir, "a(b)[c]#.txt") };
  assert.equal(new URL(openerUrl(special, { kind: "file" }, cfg)).hash, "");
});
test("direct editor URI encoding for Windows, UNC, Unicode and Insiders", () => {
  const cfg = parseSettings({ extensionOpeners: { txt: "vscode-insiders" } });
  assert.equal(openerUrl({ path: "C:\\test\\my file#.txt", line: 3, column: 2 }, { kind: "file" }, cfg), "vscode-insiders://file/C:/test/my%20file%23.txt:3:2");
  assert.equal(openerUrl({ path: "\\\\server\\share\\a.txt" }, { kind: "file" }, cfg), "vscode-insiders://file//server/share/a.txt");
  assert.ok(openerUrl({ path: path.join(dir, "résumé.txt") }, { kind: "file" }, cfg).includes("%C3%A9"));
});
