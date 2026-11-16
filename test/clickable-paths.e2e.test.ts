import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Markdown, Text, getOsc8LinkAtColumn, stripTerminalSequences, setCapabilityOverrides, resetCapabilitiesCache, visibleWidth } from "@earendil-works/pi-tui";
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import registerClickablePaths from "../index.ts";
import { linkifyPaths } from "../src/linkify.ts";
function clickablePaths(pi: any, config: string) {
  pi.registerCommand ??= () => {};
  return registerClickablePaths(pi, config);
}

const dir = mkdtempSync(join(tmpdir(), "pi-clickable-e2e-"));
after(() => { rmSync(dir, { recursive: true, force: true }); resetCapabilitiesCache(); });
writeFileSync(join(dir, "sample.txt"), "text");
writeFileSync(join(dir, "linkify.ts"), "export {};\n");
writeFileSync(join(dir, "report.xlsx"), "zip");
const id = (s: string) => s;
const theme: any = Object.fromEntries(["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(k => [k, id]));

test("real pi-tui Markdown: system links, narrow width and no-hyperlink fallback", () => {
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const md = linkifyPaths("Open `sample.txt:12:3` or report.xlsx.", dir);
  const output = new Markdown(md, 0, 0, theme).render(80).join("\n");
  assert.ok(!output.includes("vscode:"), output);
  assert.ok(output.includes("sample.txt:12:3"), output);
  assert.ok(output.includes("\x1b]8;;file:///"), output);
  for (const line of new Markdown(md, 0, 0, theme).render(20)) assert.ok(visibleWidth(line) <= 20);
  setCapabilityOverrides({ hyperlinks: false });
  const fallback = new Markdown(md, 0, 0, theme).render(160).join("\n");
  assert.ok(!fallback.includes("\x1b]8;;"));
  assert.ok(fallback.includes("(file:///"), fallback);
});

test("paths inside inline commands are linkable without changing their visible text", () => {
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  for (const command of [
    `cd ${dir} && npm run check && git diff --check`,
    `${dir} && npm test`, `cd ${dir}`,
    "cat sample.txt && cat linkify.ts", 'cat "sample.txt" && echo done',
  ]) {
    for (const ticks of ["`", "``"]) {
      const md = linkifyPaths(ticks + command + ticks, dir);
      const rows = new Markdown(md, 0, 0, theme).render(1000);
      assert.ok(rows.join("\n").includes("\x1b]8;;file:///"), md);
      assert.equal(rows.map(stripTerminalSequences).join("\n").trimEnd(), command, md);
    }
  }
});

test("configured groups produce direct VS Code links; unmatched files keep system links", async () => {
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const handlers = new Map<string, Function>();
  let transform: any;
  const config = join(dir, "group-config.json");
  writeFileSync(config, JSON.stringify({ extensionOpeners: { "md, txt": "vscode" } }));
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerMarkdownTransformer: (handler: Function) => { transform = handler; },
    registerToolRenderer: () => {},
  };
  clickablePaths(pi, config);
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { notify: (s: string) => assert.fail(s) } };
  await handlers.get("session_start")!({}, ctx);
  try {
    const output = transform("sample.txt:12:3 and report.xlsx", { messageType: "assistant", isStreaming: false });
    assert.ok(output.includes("](vscode://file"), output);
    assert.ok(output.includes(":12:3)"), output);
    assert.ok(output.includes("](file:///"), output);
    assert.ok(!output.includes("127.0.0.1"), output);
    const rendered = new Markdown(output, 0, 0, theme).render(120).join("\n");
    assert.ok(rendered.includes("\x1b]8;;vscode://file"), rendered);
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
});

for (const toolName of ["write", "edit", "read", "bash"] as const) test(`real built-in ${toolName} header has an actionable link on the path cells`, async () => {
  initTheme("dark");
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const handlers = new Map<string, Function>();
  let resolve: any;
  const config = join(dir, `${toolName}-header-config.json`);
  writeFileSync(config, JSON.stringify({ extensionOpeners: { "txt, ts": "vscode" } }));
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerMarkdownTransformer: () => {},
    registerToolRenderer: (handler: Function) => { resolve = handler; },
  };
  clickablePaths(pi, config);
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { notify: (s: string) => assert.fail(s) } };
  await handlers.get("session_start")!({}, ctx);
  try {
    const factories = { write: createWriteToolDefinition, edit: createEditToolDefinition, read: createReadToolDefinition, bash: createBashToolDefinition };
    const base = factories[toolName](dir);
    const args: any = toolName === "write" ? { path: join(dir, "sample.txt"), content: "" }
      : toolName === "read" ? { path: join(dir, "linkify.ts"), offset: 1, limit: 190 }
      : toolName === "bash" ? { command: `cd ${dir} && npm run check && git diff --check`, timeout: 120 }
      : { path: join(dir, "linkify.ts"), edits: [] }; // No preview work: this test is for the header.
    const renderContext: any = { cwd: dir, argsComplete: true, expanded: true, state: {} };
    const renderTheme: any = { ...theme, fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s };
    const original = base.renderCall!(args, renderTheme, renderContext).render(160).join("\n");
    if (toolName !== "bash") assert.ok(original.includes("\x1b]8;;file:///"), original);
    const renderer = resolve(toolName, () => base);
    const rows: string[] = renderer.renderCall(args, renderTheme, renderContext).render(160);
    const output = rows.join("\n");
    const expected = toolName === "bash" ? pathToFileURL(dir).href
      : "vscode://file" + new URL(pathToFileURL(args.path).href).pathname;
    assert.ok(output.includes(`\x1b]8;;${expected}`), output);
    const actionable = rows.flatMap(row => Array.from({ length: visibleWidth(row) }, (_, column) => getOsc8LinkAtColumn(row, column))).filter(Boolean);
    assert.ok(actionable.includes(expected), `No clickable cells for ${expected}: ${output}`);
    assert.ok(output.includes("\x1b[4m"), output);
    const withoutLinks = (s: string) => s.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[(?:4|24)m/g, "");
    assert.equal(withoutLinks(output), withoutLinks(original));
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
});

test("fallback slots stay linkable for unknown, partial and failing renderer definitions", async () => {
  initTheme("dark");
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const handlers = new Map<string, Function>();
  let resolve: any;
  const config = join(dir, "fallback-config.json");
  writeFileSync(config, JSON.stringify({ extensionOpeners: { "txt, ts": "vscode" } }));
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerMarkdownTransformer: () => {},
    registerToolRenderer: (handler: Function) => { resolve = handler; },
  };
  clickablePaths(pi, config);
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { notify: (s: string) => assert.fail(s) } };
  await handlers.get("session_start")!({}, ctx);
  const renderTheme: any = { ...theme, fg: (_color: string, s: string) => s };
  try {
    const expected = "vscode://file" + new URL(pathToFileURL(join(dir, "linkify.ts")).href).pathname;
    const result = { content: [{ type: "text", text: "linkify.ts\nClickable local paths in [Pi](https://github.com/earendil-works/pi)." }], details: undefined };
    const renderContext: any = { cwd: dir, argsComplete: true, expanded: true, showImages: true, state: {}, keyHint: () => "expand" };
    for (const base of [undefined, {}, { renderResult: () => new Text("linkify.ts", 0, 0) }, { renderCall: () => new Text("linkify.ts", 0, 0) },
      { renderCall: () => { throw Error("broken call"); }, renderResult: () => { throw Error("broken result"); } }]) {
      const renderer = resolve("custom-inspect", () => base);
      const call = renderer.renderCall({ path: "linkify.ts" }, renderTheme, renderContext).render(160).join("\n");
      assert.ok(call.includes(`\x1b]8;;${expected}`), call);
      const output = renderer.renderResult(result, { expanded: true, isPartial: false }, renderTheme, renderContext).render(160).join("\n");
      assert.ok(output.includes(`\x1b]8;;${expected}`), output);
      assert.ok(!output.includes("\x1b]8;;https://"), output);
    }
    const renderer = resolve("unknown", () => undefined);
    const longResult = { content: [{ type: "text", text: Array.from({ length: 15 }, () => "linkify.ts").join("\n") }], details: undefined };
    const collapsed = renderer.renderResult(longResult, { expanded: false, isPartial: false }, renderTheme, renderContext).render(160).join("\n");
    assert.ok(collapsed.includes("5 more lines"), collapsed);
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
});

test("complete ToolExecutionComponent retains actionable links for builtin and generic tool headers", async () => {
  initTheme("dark");
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const handlers = new Map<string, Function>();
  let resolve: any;
  const config = join(dir, "tool-component-config.json");
  writeFileSync(config, JSON.stringify({ extensionOpeners: { "txt, ts": "vscode" } }));
  clickablePaths({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerMarkdownTransformer: () => {},
    registerToolRenderer: (handler: Function) => { resolve = handler; },
  } as any, config);
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { notify: (s: string) => assert.fail(s) } };
  await handlers.get("session_start")!({}, ctx);
  try {
    const path = join(dir, "linkify.ts");
    const cases: any[] = [
      ["read", createReadToolDefinition(dir), { path, offset: 1, limit: 190 }],
      ["edit", createEditToolDefinition(dir), { path, edits: [] }],
      ["write", createWriteToolDefinition(dir), { path, content: "" }],
      ["bash", createBashToolDefinition(dir), { command: `cd ${dir} && npm run check && git diff --check`, timeout: 120 }],
      ["custom-without-renderers", undefined, { path }],
    ];
    for (const [name, base, args] of cases) {
      // Reproduce the live report: a final result does not necessarily imply
      // that setArgsComplete() was ever called for the header.
      for (const argsComplete of [false, true]) {
        const definition = resolve(name, () => base);
        const component = new ToolExecutionComponent(name, "test-call", args, {}, definition, { requestRender() {} }, dir);
        if (argsComplete) component.setArgsComplete();
        component.updateResult({ content: [], details: undefined }, false);
        const expected = name === "bash" ? pathToFileURL(dir).href : "vscode://file" + new URL(pathToFileURL(path).href).pathname;
        for (const expanded of [false, true]) {
          component.setExpanded(expanded);
          const rows: string[] = component.render(180);
          const links = rows.flatMap(row => Array.from({ length: visibleWidth(row) }, (_, column) => getOsc8LinkAtColumn(row, column))).filter(Boolean);
          assert.ok(links.includes(expected), `${name} argsComplete=${argsComplete} expanded=${expanded}: ${rows.join("\n")}`);
        }
      }
    }
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
});

test("runtime diagnostic reports the actual tool frame flags and emitted URLs", async () => {
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const handlers = new Map<string, Function>();
  let resolve: any, debug: any, report: any;
  clickablePaths({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: any) => { debug = definition.handler; },
    registerMarkdownTransformer: () => {},
    registerToolRenderer: (handler: Function) => { resolve = handler; },
  } as any, join(dir, "missing-debug-config.json"));
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { notify: (message: string) => { report = JSON.parse(message); } } };
  await handlers.get("session_start")!({}, ctx);
  try {
    const renderer = resolve("debug-tool", () => undefined);
    const renderTheme: any = { ...theme, fg: (_color: string, s: string) => s };
    renderer.renderCall({ path: "linkify.ts" }, renderTheme, { cwd: dir, argsComplete: false, isPartial: false, expanded: true }).render(160);
    await debug("linkify.ts", ctx);
    assert.equal(report.active, true);
    assert.equal(report.hyperlinks, true);
    assert.equal(report.requestedUrl, pathToFileURL(join(dir, "linkify.ts")).href);
    assert.equal(report.recentToolFrames[0].name, "debug-tool");
    assert.equal(report.recentToolFrames[0].partial, false);
    assert.ok(report.recentToolFrames[0].after.includes(report.requestedUrl));
  } finally { await handlers.get("session_shutdown")!({}, ctx); }
});

test("extension lifecycle, streaming, model context preservation and composable tool rendering", async () => {
  resetCapabilitiesCache(); setCapabilityOverrides({ hyperlinks: true });
  const handlers = new Map<string, Function>();
  let transform: any, resolve: any;
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerMarkdownTransformer: (handler: Function) => { transform = handler; },
    registerToolRenderer: (handler: Function) => { resolve = handler; },
  };
  clickablePaths(pi, join(dir, "absent-config.json"));
  const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { notify: () => {} } };
  await handlers.get("session_start")!({}, ctx);
  const message = "sample.txt:12:3";
  assert.equal(transform(message, { isStreaming: true }), message);
  assert.equal(transform(message, { messageType: "assistant-thinking" }), message);
  assert.ok(transform(message, { messageType: "assistant", isStreaming: false }).includes("](file:///"));
  // Only display hooks are registered. No message/tool-result/context rewrites.
  assert.ok(!handlers.has("context")); assert.ok(!handlers.has("tool_result")); assert.ok(!handlers.has("message_end"));
  let receivedPrevious: any;
  const child = new Text("sample.txt:12:3", 0, 0);
  const base = {
    renderShell: "self",
    renderResult: (_r: any, _o: any, _t: any, context: any) => { receivedPrevious = context.lastComponent; return child; },
  };
  const renderer = resolve("any-tool", () => base);
  assert.equal(renderer.renderShell, "self");
  const result = { content: [{ type: "text", text: message }] };
  const renderCtx: any = { cwd: dir };
  const wrapped = renderer.renderResult(result, { isPartial: false }, theme, renderCtx);
  const rows = wrapped.render(80);
  assert.ok(rows[0].includes("\x1b]8;;file:///"));
  assert.equal(visibleWidth(rows[0]), visibleWidth(child.render(80)[0]));
  renderer.renderResult(result, { isPartial: false }, theme, { ...renderCtx, lastComponent: wrapped });
  assert.equal(receivedPrevious, child);
  assert.deepEqual(result, { content: [{ type: "text", text: message }] });
  const partial = renderer.renderResult(result, { isPartial: true }, theme, renderCtx);
  assert.ok(!partial.render(80)[0].includes("\x1b]8;;"));
  setCapabilityOverrides({ hyperlinks: false });
  assert.ok(!wrapped.render(80)[0].includes("\x1b]8;;"));
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(transform(message, { messageType: "assistant" }), message);
});
