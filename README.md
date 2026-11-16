# pi-clickable-paths

Clickable local paths in [Pi](https://github.com/earendil-works/pi).

**A matching extension rule selects VS Code, VS Code Insiders, or the system
default application. Unmatched files always use the system default.** Links go
directly to the app's URL handler: no HTTP server, browser tab, shell commands,
extra daemon or confirmation page.

Display-only: no changes to messages, tool execution, session content, or model
context. Tool renderers compose with existing renderers without replacing tools.

## Install

Requires Pi **1.5.0+**, Node **22.19+**, and an OSC 8 capable terminal.

```sh
pi install git:github.com/siviae/pi-clickable-paths
# Or use a local checkout:
pi install ./pi-clickable-paths
```

Then `/reload` or restart Pi. Disable the original clickable-paths extension if
installed: two path transformers should not run together.

The terminal controls its click gesture (often Cmd+click on macOS or Ctrl+click
elsewhere). Pi fullscreen mode can also handle a link with an ordinary click.
Enable `terminal.hyperlinks` in Pi if your terminal is not detected. Clickable
local paths are always underlined in tool headers/results; surrounding text keeps
its original styling. Pi's Markdown renderer also underlines message links. This
styling does not depend on Cmd/hover and does not change the click gesture.

## Configuration

Optional file: **`~/.pi/agent/pi-clickable-paths.json`** (under Pi's agent directory
if overridden). Apply changes with `/reload`.

```json
{
  "extensionOpeners": {
    "md, txt, json, ts, js": "vscode",
    "xlsx, xls, ods": "system"
  }
}
```

One comma-separated key covers multiple extensions. Whitespace around extensions
and optional leading dots are accepted; matching is case-insensitive. Each
extension may appear in only one rule; overlapping groups are a config error.
Single-extension keys remain supported.

Supported opener values:

| Opener | Generated URL | Behavior |
| --- | --- | --- |
| `vscode` | `vscode://file/…` | Opens VS Code, including optional line/column |
| `vscode-insiders` | `vscode-insiders://file/…` | Opens VS Code Insiders |
| `system` | `file:///…` | Opens the file with its OS default app |

A file without a rule uses `system`. Directories always use `system`, even when
their name ends in a configured extension. Files without extensions also use
`system`. `toolLinks` is the only other setting (boolean, default `true`).

### LibreOffice

Spreadsheets use `file://` links. To open them in LibreOffice, make LibreOffice the
system default for their extensions. On macOS: select a file in Finder → Get Info
→ Open with → LibreOffice → Change All. Repeat for each desired extension.

The `system` rule does **not** force LibreOffice: if Excel or Numbers is the
default, that application opens instead. The spreadsheet rule above is explicit
for readability but can be omitted, since unmatched extensions already use the
system app. There is no assumed LibreOffice-specific URL scheme for local files.

VS Code must have its URL handler registered. The `code` CLI does not need to be
on PATH; it is not executed. URL handling is delegated to the terminal and OS.

### Migration from command rules

`extensionCommands`, `code %s`, and arbitrary command strings are no longer
supported. Replace them with `extensionOpeners` entries as shown above. Invalid
config produces a Pi error notification and falls back to system links.

The old localhost command server has been removed entirely. After `/reload`,
newly rendered paths use direct app/system URLs; old links in terminal scrollback
may still contain obsolete localhost addresses and should not be used.

## Path support

- Absolute POSIX and native Windows/UNC paths; relative paths use the active
  session cwd (tool paths use the tool renderer's cwd).
- Bare filenames (`README.md`), dotfiles (`.env`), `~/…` and `@src/main.ts`.
- Extensionless filenames and folders in backticks or quotes (`LICENSE`).
- Unicode and spaces in backticks/quotes. Plain absolute, `~/` and `./` paths with
  spaces use the longest existing prefix (bounded to 8 words/512 chars).
- `src/main.ts:42`, `src/main.ts:42:7`, and `src/main.ts#L42C7` supply line/column
  to VS Code links. System links ignore locations. Literal existing filenames
  with colons/punctuation take precedence.
- User/assistant Markdown and tool call/result displays, including restored
  sessions and third-party tool renderers. Both explicit renderers and generic
  fallback headers/results pass through the same path-linking pipeline.
- Local paths inside shell command headers and inline-code commands in messages,
  such as `cd /path/to/project && npm test`, become links too. A directory opens
  in the system file manager; the command itself is not executed by clicking its
  path. Non-path parts retain their code styling and visible whitespace.
- Only existing local regular files/directories are linked. Rendering does not
  open files, execute commands or read file contents.

Markdown fences, indented code blocks, non-path inline code, reference definitions,
existing links/images, URLs and autolinks are preserved. Converting path inline
code into a link necessarily replaces its code-span styling. Opening a document
may execute active content in its app; only open files you trust.

## Performance and boundaries

- Shared cache: up to 2048 positive/negative filesystem results, 5-second TTL;
  at most 128 candidate resolutions per message/tool render.
- Assistant/thinking streams and partial tool results are not linkified. Tool
  headers are linkified from their current rendered text even if Pi's
  `argsComplete` flag remains false; header checks use the same bounded cache.
- Cold cache entries still use synchronous filesystem metadata checks. Caching
  and budgets reduce repeated work but cannot prevent a single slow network
  mount from blocking. No content reads or text/binary sniffing are performed.
- Cached results refresh on the next render after TTL, not on a timer. A newly
  created file may need a redraw/reload before its link appears.
- Tool links are added after the original renderer lays out text. A path split
  across rows, truncated or hidden in a collapsed result may not be linked.
  Expand the tool / widen the terminal. Existing local `file://` OSC 8 links
  (including built-in tool headers) follow configured opener rules; their labels,
  styles and OSC parameters are preserved. Other existing links are unchanged,
  and no links are nested. An existing link does not block linking other paths
  on the same line. Terminal image payloads are skipped.
- Ambiguous plain prose is not a complete path grammar; use backticks/quotes for
  precise recognition. Complex Markdown nesting may be left untouched.
- Without hyperlink support, Markdown shows a printable URL fallback; tool
  displays remain unchanged to preserve width. Terminal/OS policy still applies.
- Remote SSH/WSL/container paths must exist locally and be meaningful to desktop
  apps. No remote path mapping is attempted.

## Troubleshooting live tool links

After `/reload`, reproduce the problematic tool call, then run:

```text
/clickable-paths-debug ~/IdeaProjects/pi-clickable-paths/src/linkify.ts
```

The report shows the active config, TUI mode, hyperlink support, expected URL for
that path, and the before/after hyperlink destinations from the most recent tool
renders. This distinguishes a rule mismatch, a skipped partial render, missing
renderer interception, and a correct emitted URL that the terminal isn't opening.
Only ten recent tool/slot summaries are kept in memory; no log file is written.
This diagnostic does not open the file or execute a command.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

Tests cover isolated temporary fixtures, actual pi-tui Markdown rendering (OSC 8,
fallback and width), mocked Pi lifecycle/composable renderers, grouped opener
rules, direct editor/system URL encoding, and cache budgets. Integration tests
render complete Pi tool components for read/edit/write/bash and renderer-less
tools, then use Pi's own terminal-column hyperlink resolver to check their path
cells. Missing/throwing renderer slots and fallback collapse behavior are covered.
No GUI applications are started by tests. CI runs on macOS, Linux and Windows.

MIT. See LICENSE.
