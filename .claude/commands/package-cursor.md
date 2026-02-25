---
description: "Build VSIX and install Crispy into Cursor (WSL)"
allowed-tools: Bash, Read, Glob, Grep
---

# Package Crispy for Cursor (WSL)

Build a `.vsix` package and install it into the WSL Cursor extensions directory.

**Context:** The `cursor --install-extension` CLI is unreliable on WSL due to
stale IPC sockets. This command bypasses the CLI by manually extracting the
VSIX (which is just a zip) into the extensions directory.

## Steps

### 1. Read version from package.json

Extract the `version` field from `package.json`. This will be used for the
extension directory name (e.g. `TheSylvester.crispy-<version>`).

### 2. Build and package

```
npm run package
```

This runs `npm run build` (extension + webview + dev-server) then `vsce package`,
producing `crispy-<version>.vsix` in the project root.

If this fails, stop and report the error.

### 3. Remove any existing Crispy installations

Check `~/.cursor-server/extensions/` for any directories matching
`TheSylvester.crispy*` and remove them:

```
rm -rf ~/.cursor-server/extensions/TheSylvester.crispy*
```

### 4. Extract VSIX into Cursor extensions directory

The target directory is `~/.cursor-server/extensions/TheSylvester.crispy-<version>`.

```bash
TARGET=~/.cursor-server/extensions/TheSylvester.crispy-<version>
mkdir -p "$TARGET"
cd "$TARGET"
unzip -o /home/silver/dev/crispy/crispy-<version>.vsix 'extension/*' -d .
cp -a extension/* .
rm -rf extension
```

### 5. Verify the installation

Confirm these critical files exist in the target directory:
- `package.json`
- `dist/extension.js`
- `dist/webview/main.js`
- `dist/webview/index.html`

### 6. Report

Tell the user:
- The version number that was packaged
- That they need to **Reload Window** in Cursor (`Ctrl+Shift+P` > "Reload Window")
- The VSIX file location in case they want it for other installs
