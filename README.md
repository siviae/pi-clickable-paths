# clickable-paths for Pi

Ctrl+click file paths in the [pi](https://github.com/earendil-works/pi) coding agent transcript to open them.

The agent says "your file is in `C:\Users\you\project\src\main.ts`". With this extension, paths that exist on disk are rendered as terminal hyperlinks (OSC 8): **Ctrl+click opens the file with its default app** (folders open in your file manager). Your terminal handles the click; this extension only wires the paths.

Display-only: it rewrites how messages are *rendered*, never what the model sees.

## Install

Either copy the single file:

```bash
# Windows (Git Bash)
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/clickable-paths.ts \
  https://raw.githubusercontent.com/iamdgarcia/pi-clickable-paths/main/index.ts
```

or clone the repo as an extension directory (pi auto-loads subdirectories containing `index.ts`):

```bash
git clone https://github.com/iamdgarcia/pi-clickable-paths.git ~/.pi/agent/extensions/pi-clickable-paths
```

Then run `/reload` in pi (or restart).

## What becomes clickable

- Absolute paths (`C:\...`, `C:/...`, `/usr/...`) — as written, backticks or not
- Relative paths with an extension (`src/lib/foo.py`), resolved against pi's launch directory
- Folders too

Only paths that **exist on disk** are linked, so prose, URLs, and imagined files stay untouched. Fenced code blocks, existing markdown links, and non-path inline code are never rewritten. Sentence punctuation after a path stays outside the link.

## Terminals

Anything with OSC 8 support: Windows Terminal, VS Code integrated terminal, iTerm2, Ghostty, Kitty, WezTerm. Without support, pi degrades gracefully to printing the `file:///` URL in parentheses (you can force behavior with `PI_HYPERLINKS=1|0`).

## Tests

```bash
node test/clickable-paths.test.ts        # linkify logic (10 checks, offline)
node test/clickable-paths.e2e.test.ts    # renders through pi-tui's real Markdown component
```

The e2e test imports pi-tui from your local pi install (path at the top of the file).

## License

MIT
