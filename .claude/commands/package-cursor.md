---
description: "Build VSIX and install Crispy into Cursor (WSL)"
allowed-tools: Bash, Read, Glob, Grep, Edit
args: "[version] — omit to auto-increment last segment"
---

# Package Crispy for Cursor (WSL)

Build a `.vsix` package and install it into the WSL Cursor extensions directory.

**Context:** The `cursor --install-extension` CLI is unreliable on WSL due to
stale IPC sockets. This command bypasses the CLI by manually extracting the
VSIX (which is just a zip) into the extensions directory, then patches
Cursor's registry files so it recognizes the extension.

## Steps

### 0. Determine target version and bump

Read the current `version` from `package.json`.

- If the user passed a `$ARGUMENTS` value (e.g. `0.1.0-rc2`), use that as the
  target version.
- If **no argument** was provided, auto-increment the last numeric segment of
  the current version. Examples:
  - `0.1.4-dev.26` → `0.1.4-dev.27`
  - `0.1.4-rc.3` → `0.1.4-rc.4`
  - `0.1.4` → `0.1.5`

Update the version **everywhere**:

1. `package.json` — the `"version"` field
2. `src/webview/components/WelcomePage.tsx` — the `<p>` subtitle
3. `src/core/adapters/codex/codex-app-server-adapter.ts` — `clientInfo.version`
4. `src/core/adapters/codex/codex-discovery.ts` — `clientInfo.version`

Use the Edit tool for each file. Strip any leading `v` from the argument
(e.g. `v0.1.0-rc2` → `0.1.0-rc2`) for the semver fields, but keep the `v`
prefix in WelcomePage's display string.

Then run `npm install --package-lock-only` to sync `package-lock.json`.

### 1. Read version from package.json

Extract the `version` field from `package.json`. This will be used for the
extension directory name (e.g. `the-sylvester.crispy-<version>`).

### 2. Build and package

```
npm run package
```

This runs `npm run build` (extension + webview + dev-server) then `vsce package`,
producing `crispy-<version>.vsix` in the project root.

If this fails, stop and report the error.

### 3. Remove any existing Crispy installations

Check `~/.cursor-server/extensions/` for any directories matching
`the-sylvester.crispy*` or `TheSylvester.crispy*` (case-insensitive) and
remove them:

```
rm -rf ~/.cursor-server/extensions/the-sylvester.crispy* ~/.cursor-server/extensions/TheSylvester.crispy*
```

### 4. Extract VSIX into Cursor extensions directory

The target directory is `~/.cursor-server/extensions/the-sylvester.crispy-<version>`.

Extract the full VSIX (including metadata files), then flatten the
`extension/` subtree to the root:

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
TARGET=~/.cursor-server/extensions/the-sylvester.crispy-<version>
mkdir -p "$TARGET"
cd "$TARGET"
unzip -o "$PROJECT_ROOT/crispy-<version>.vsix" -d .
# Flatten extension/ subtree to root
cp -a extension/* .
rm -rf extension
```

### 5. Patch Cursor registry files

Cursor tracks extensions via two files. Both must be updated or the extension
won't load.

#### 5a. Clear the `.obsolete` flag

Cursor marks manually-placed extensions as obsolete on reload. Remove the
entry from `~/.cursor-server/extensions/.obsolete` (JSON object):

```python
python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.cursor-server/extensions/.obsolete'
if p.exists():
    data = json.loads(p.read_text() or '{}')
    # Remove any crispy entries (case-insensitive match)
    keys_to_remove = [k for k in data if 'crispy' in k.lower()]
    for k in keys_to_remove:
        data.pop(k)
    p.write_text(json.dumps(data))
"
```

#### 5b. Update `extensions.json` registry

Cursor discovers installed extensions from this registry file, not by
scanning the directory. Upsert the Crispy entry:

```python
python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.cursor-server/extensions/extensions.json'
data = json.loads(p.read_text()) if p.exists() else []

# Remove any existing crispy entries (case-insensitive)
data = [e for e in data if 'crispy' not in str(e.get('identifier', {})).lower()]

# Add new entry
data.append({
    'identifier': {'id': 'the-sylvester.crispy'},
    'version': '<version>',
    'location': {
        '\$mid': 1,
        'path': str(pathlib.Path.home() / '.cursor-server/extensions/the-sylvester.crispy-<version>'),
        'scheme': 'file'
    },
    'relativeLocation': 'the-sylvester.crispy-<version>'
})

p.write_text(json.dumps(data, indent='\t'))
"
```

### 6. Verify the installation

Confirm these critical files exist in the target directory:
- `package.json`
- `dist/extension.js`
- `dist/webview/main.js`
- `dist/webview/index.html`

### 7. Commit version bump

Stage the files that were edited in step 0:

1. `package.json`
2. `package-lock.json`
3. `src/webview/components/WelcomePage.tsx`
4. `src/core/adapters/codex/codex-app-server-adapter.ts`
5. `src/core/adapters/codex/codex-discovery.ts`

Create a commit with message: `chore: bump version to <version>`

### 8. Report

Tell the user:
- The version number that was packaged
- That they need to **Reload Window** in Cursor (`Ctrl+Shift+P` > "Reload Window")
- The VSIX file location in case they want it for other installs
