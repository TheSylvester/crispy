# Crispy Desktop

Native desktop app for Crispy — a self-contained installer that bundles Node.js and the full crispy-code package. Users download one installer, double-click, and get a native desktop app. No terminal, no npm, no manual setup.

## Architecture

The Tauri shell spawns a bundled Node.js with the crispy daemon, waits for it to become healthy via `/health`, then loads the web UI (`http://localhost:{port}`) in a native window.

```
<app-install-dir>/
  crispy-app(.exe)           ← Tauri binary (native window shell)
  runtime/
    node(.exe)               ← Portable Node.js 22 LTS
    crispy/                  ← crispy-code package
      dist/crispy-cli.js     ← daemon entry point
      node_modules/          ← production deps (sans voice/optional)
      package.json
```

## Prerequisites

- **Rust** (stable): https://rustup.rs
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2"`
- **Node.js 18+** (for building the crispy-code package)
- **Tauri system dependencies**:
  - **Linux**: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows**: WebView2 runtime (bundled in installer via bootstrapper)
  - **macOS**: Xcode command line tools (`xcode-select --install`)

## Build

```bash
# 1. Build the crispy-code package first (from repo root)
cd ..
npm run build

# 2. Bundle the runtime (downloads Node.js, copies dist + deps)
cd tauri
bash scripts/bundle-runtime.sh        # Linux/macOS
# pwsh scripts/bundle-runtime.ps1     # Windows

# 3. Development mode (uses dev server on localhost:3456)
cargo tauri dev

# 4. Build installer
cargo tauri build
```

The installer is output to `src-tauri/target/release/bundle/`:
- **Windows**: `nsis/Crispy_{version}_x64-setup.exe`
- **macOS**: `dmg/Crispy_{version}_aarch64.dmg` (follow-up)
- **Linux**: `appimage/Crispy_{version}_amd64.AppImage`, `deb/crispy_{version}_amd64.deb` (follow-up)

## Update Signing

Tauri uses its own update signing (separate from OS code signing). Generate a key pair before your first release build:

```bash
cargo tauri signer generate -w ~/.tauri/crispy.key
```

This outputs a public key — paste it into `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. The private key at `~/.tauri/crispy.key` is used by CI to sign release artifacts.

The updater checks `https://github.com/TheSylvester/crispy/releases/latest/download/latest.json` on startup (15s delay) and every 4 hours.

## CI Release Workflow (Outline)

A GitHub Actions workflow should:

1. Build the crispy-code package (`npm run build`)
2. Run `scripts/bundle-runtime.sh` (or `.ps1` on Windows)
3. Run `cargo tauri build` with `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars set
4. Upload the installer + `latest.json` to the GitHub Release

## Platform Notes

### Windows
- WebView2 Evergreen runtime is auto-installed on Windows 10/11. The NSIS installer bundles the WebView2 bootstrapper as a fallback for edge cases (e.g., Windows Server).
- Process cleanup uses `taskkill /F /T /PID` to ensure the entire Node.js process tree is killed.

### macOS (follow-up)
- Unsigned DMGs are quarantined by Gatekeeper. Users must right-click → Open to bypass on first launch.
- Finder-launched apps have a minimal `PATH`. The Rust side will hydrate `PATH` from the user's login shell before spawning the daemon (not yet implemented — Windows-first).
- The title bar will use `"titleBarStyle": "Overlay"` with a drag region (not yet implemented).

### Linux (follow-up)
- Requires WebKitGTK 4.1. Install via `sudo apt install libwebkit2gtk-4.1-dev` (Ubuntu/Debian) or equivalent.
- Some distros ship older WebKitGTK that may not support newer CSS features (backdrop-filter, container queries). The UI degrades gracefully.
- Distributed as AppImage (portable) and .deb (Debian/Ubuntu).

## Design Decisions

- **Tray app model**: Closing the window minimizes to system tray. "Quit" from tray stops the daemon and exits.
- **Daemon reuse**: If a daemon started by another Crispy instance (global install, VS Code extension) is already running, the desktop app attaches to it instead of spawning a second one. The `we_own_daemon` flag tracks ownership.
- **`window.__CRISPY_DESKTOP__ = true`**: Injected via Tauri's `initialization_script()` — runs before React hydration on every navigation. Enables desktop-specific features in the React app.
- **Voice deps excluded**: `onnxruntime-node` (~208MB), `sharp` (~30-50MB), and `@huggingface/transformers` (~49MB) are excluded from the bundle. Voice will lazy-download these when first enabled.
