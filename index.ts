import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, type Component } from "@earendil-works/pi-tui";
import { PathCache, findReference } from "./src/paths.ts";
import { linkifyPaths, linkifyTerminal, type Options } from "./src/linkify.ts";
import { DEFAULT_SETTINGS, loadSettings, type Settings } from "./src/config.ts";
import { openerUrl } from "./src/opener.ts";
import { fallbackCall, fallbackResult } from "./src/fallback-renderers.ts";

export { linkifyPaths, linkifyTerminal } from "./src/linkify.ts";
export { toFileUrl } from "./src/paths.ts";

export default function clickablePaths(pi: ExtensionAPI, configPath = join(getAgentDir(), "pi-clickable-paths.json")) {
  const cache = new PathCache();
  let settings: Settings = DEFAULT_SETTINGS;
  let cwd = process.cwd();
  let active = false;
  const toolFrames = new Map<string, unknown>();
  const urlsIn = (rows: string[]) => [...new Set([...rows.slice(0, 12).join("\n").matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map(m => m[1]))].slice(0, 4);
  const options = (): Options => ({ cache,
    target: (ref, meta) => openerUrl(ref, meta, settings) });

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    cache.clear();
    toolFrames.clear();
    try { settings = loadSettings(configPath); }
    catch (error) {
      settings = DEFAULT_SETTINGS;
      if (ctx.hasUI) ctx.ui.notify(`clickable-paths: ${configPath}: ${String(error)}. Using defaults.`, "error");
    }
    active = ctx.mode === "tui";
  });
  pi.on("before_agent_start", (_event, ctx) => { cwd = ctx.cwd; });
  pi.on("session_shutdown", () => { active = false; cache.clear(); toolFrames.clear(); });
  pi.registerCommand("clickable-paths-debug", {
    description: "Show active opener settings and the URLs emitted by recent tool renders",
    handler: async (args, ctx) => {
      const found = args.trim() ? findReference(args.trim(), ctx.cwd, cache) : null;
      const report = {
        configPath, mode: ctx.mode, active, hyperlinks: getCapabilities().hyperlinks,
        settings, requestedPath: args.trim() || undefined,
        requestedUrl: found ? openerUrl(found.ref, found.meta, settings) : undefined,
        recentToolFrames: [...toolFrames.values()],
      };
      const message = JSON.stringify(report, null, 2);
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });
  pi.registerMarkdownTransformer((markdown, ctx) => {
    // Don't do synchronous filesystem I/O for every streamed token or thinking update.
    if (!active || ctx.isStreaming || ctx.messageType === "assistant-thinking") return markdown;
    return linkifyPaths(markdown, cwd, options());
  });

  // Wrap other renderers, rather than replacing tools or touching their results.
  // Delegating through next() preserves built-in and other extensions' layouts.
  const unwrapped = new WeakMap<Component, Component>();
  const wrap = (component: Component, renderCwd: string, partial: boolean, name: string, slot: string): Component => {
    const proxy = new Proxy(component, {
      get(target, prop) {
        if (prop === "render") return (width: number) => {
          const rows = target.render(width);
          const hyperlinks = getCapabilities().hyperlinks;
          const enabled = active && !partial && settings.toolLinks && hyperlinks;
          const opts = { ...options(), budget: { remaining: 128 } };
          const output = enabled ? rows.map(row => linkifyTerminal(row, renderCwd, opts)) : rows;
          const key = `${name}/${slot}`;
          toolFrames.delete(key);
          toolFrames.set(key, { name, slot, cwd: renderCwd, active, partial, toolLinks: settings.toolLinks, hyperlinks, before: urlsIn(rows), after: urlsIn(output) });
          while (toolFrames.size > 10) toolFrames.delete(toolFrames.keys().next().value!);
          return output;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) { return Reflect.set(target, prop, value, target); },
    });
    unwrapped.set(proxy, component);
    return proxy;
  };
  pi.registerToolRenderer((name, next) => {
    const base = next();
    return {
      ...base,
      // Always provide both slots: otherwise Pi's generic fallback is drawn
      // outside this extension and path matching never sees it.
      renderCall: (args, theme, ctx) => {
        const lastComponent = ctx.lastComponent && (unwrapped.get(ctx.lastComponent) ?? ctx.lastComponent);
        let child: Component | undefined;
        try { child = base?.renderCall?.(args, theme, { ...ctx, lastComponent }); }
        catch { /* Like Pi, fall back when a custom renderer fails. */ }
        child ??= fallbackCall(name, args, theme, ctx.expanded);
        // Some live tool lifecycles leave argsComplete false even after the
        // result is final. It cannot gate header linking. Inspect the currently
        // rendered header with the same bounded filesystem cache instead.
        return wrap(child, ctx.cwd, false, name, "call");
      },
      renderResult: (result, opts, theme, ctx) => {
        const lastComponent = ctx.lastComponent && (unwrapped.get(ctx.lastComponent) ?? ctx.lastComponent);
        let child: Component | undefined;
        try { child = base?.renderResult?.(result, opts, theme, { ...ctx, lastComponent }); }
        catch { /* Keep the fallback inside the same linking pipeline. */ }
        child ??= fallbackResult(result, opts.expanded, ctx.showImages, theme, ctx.keyHint);
        return wrap(child, ctx.cwd, opts.isPartial, name, "result");
      },
    };
  });
}
