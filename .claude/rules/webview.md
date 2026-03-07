---
paths:
  - "src/webview/**"
---

## VS Code wiring

The dev server and VS Code extension have divergent code paths. When adding
features that touch host communication, check whether `webview-host.ts` needs
a parallel intercept (see `openFile`, `pickFile`, `forkToNewPanel` for the
pattern). Messages sent from host → webview at panel creation time must use
the retry-delay pattern — the webview JS isn't ready yet.

## Do not

- **Do not add `<select>` elements without explicit `option` background styling.**
  Native `<option>` elements in VS Code webviews inherit system defaults (often light)
  rather than the webview theme. Always add `option { background; color; }` rules
  using `--vscode-dropdown-background` / `--vscode-dropdown-foreground`.
