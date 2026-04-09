//! Crispy Desktop — Tauri v2 shell for the Crispy daemon.
//!
//! Lifecycle: splash → spawn bundled node + daemon → wait for health →
//! navigate webview to localhost:{port}. Tray icon persists when window
//! is closed; "Quit" from tray kills the daemon (if we own it) and exits.

mod menu;

use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{MenuEvent, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WebviewWindow, WindowEvent,
};

/// Counter for unique window labels.
static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Initialization script injected into every Crispy webview window.
/// Sets the desktop flag and bridges document.title to the native window title.
const WINDOW_INIT_SCRIPT: &str = r#"
window.__CRISPY_DESKTOP__ = true;
(function() {
    var ipc = window.__TAURI_INTERNALS__;

    if (!ipc) return;

    // Direct IPC bridge — page JS calls window.__CRISPY_CREATE_WINDOW__(query)
    // instead of the unreliable title command channel (MutationObserver doesn't
    // fire reliably in WebView2 for programmatic document.title changes).
    window.__CRISPY_CREATE_WINDOW__ = function(query) {
        return ipc.invoke('create_window', {
            query: query || null,
            path: window.location.pathname || null
        });
    };

    // Title bridge — poll document.title and sync to native window title.
    // MutationObserver doesn't fire for programmatic document.title changes
    // in WebView2, so we poll instead.
    var lastTitle = '';
    setInterval(function() {
        var t = document.title;
        if (t && t !== lastTitle) {
            lastTitle = t;
            ipc.invoke('set_window_title', { title: t }).catch(function() {});
        }
    }, 300);

    // Handle menu actions dispatched from Rust via window.eval().
    window.__CRISPY_MENU_ACTION__ = function(action) {
        if (action === 'new_window') {
            ipc.invoke('create_window', {
                query: null,
                path: window.location.pathname || null
            }).catch(function() {});
        } else if (action === 'new_session') {
            // Dispatch a custom event the React app can listen to
            window.dispatchEvent(new CustomEvent('crispy-menu', { detail: { action: 'new_session' } }));
        } else if (action.indexOf('update_available:') === 0 || action === 'daemon_crashed') {
            window.dispatchEvent(new CustomEvent('crispy-menu', { detail: { action: action } }));
        }
    };
})();
"#;

// ============================================================================
// State
// ============================================================================

/// Which environment a daemon is running in.
#[derive(Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum DaemonEnv {
    Native,                // Windows host or Linux host
    Wsl,                   // WSL distro (name stored in DaemonState)
}

/// State for a single daemon instance.
#[allow(dead_code)]
struct DaemonState {
    pid: Option<u32>,
    port: u16,
    we_own: bool,
    environment: DaemonEnv,
    /// WSL distro name (only set when environment == Wsl)
    wsl_distro: Option<String>,
}

/// WSL lifecycle status, queryable from webview.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "status")]
enum WslStatus {
    #[serde(rename = "detecting")]
    Detecting,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "not_installed")]
    NotInstalled { distro: String },
    #[serde(rename = "starting")]
    Starting { distro: String },
    #[serde(rename = "connected")]
    Connected { distro: String, port: u16 },
    #[serde(rename = "failed")]
    Failed { distro: String, error: String },
}

struct AppState {
    primary_daemon: Option<DaemonState>,
    #[allow(dead_code)]
    wsl_daemon: Option<DaemonState>,   // Phase C: WSL remote daemon
    is_quitting: bool,
    /// WSL lifecycle status — replaces the old wsl_needs_install field.
    wsl_status: WslStatus,
}

// ============================================================================
// Window helpers — abstract over single/multi-window
// ============================================================================

/// Get the focused window, falling back to any visible window, then any window.
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows.values().find(|w| w.is_focused().unwrap_or(false)).cloned()
        .or_else(|| windows.values().find(|w| w.is_visible().unwrap_or(false)).cloned())
        .or_else(|| windows.into_values().next())
}

/// Dispatch a JS eval to all open windows.
fn eval_all_windows(app: &AppHandle, script: &str) {
    for window in app.webview_windows().values() {
        let _ = window.eval(script);
    }
}

/// Navigate all windows to a URL (used when daemon restarts on a new port).
fn navigate_all_windows(app: &AppHandle, url: &Url) {
    for window in app.webview_windows().values() {
        let _ = window.navigate(url.clone());
    }
}

/// Show and focus the most appropriate window (focused > visible > any).
fn show_any_window(app: &AppHandle) {
    if let Some(w) = focused_window(app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ============================================================================
// Platform paths — mirrors src/core/paths.ts
// ============================================================================

fn crispy_root() -> PathBuf {
    if cfg!(windows) {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\"));
            home.join("AppData").join("Roaming").to_string_lossy().into_owned()
        });
        PathBuf::from(appdata).join("Crispy")
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".crispy")
    }
}

fn run_dir() -> PathBuf {
    crispy_root().join("run")
}

fn logs_dir() -> PathBuf {
    crispy_root().join("logs")
}

// ============================================================================
// Port configuration — persisted to ~/.crispy/tauri.json
// ============================================================================

const DEFAULT_NATIVE_PORT: u16 = 3456;
const DEFAULT_WSL_PORT: u16 = 3466;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortConfig {
    #[serde(default = "default_native_port")]
    native_port: u16,
    #[serde(default = "default_wsl_port")]
    wsl_port: u16,
}

fn default_native_port() -> u16 { DEFAULT_NATIVE_PORT }
fn default_wsl_port() -> u16 { DEFAULT_WSL_PORT }

impl Default for PortConfig {
    fn default() -> Self {
        Self {
            native_port: DEFAULT_NATIVE_PORT,
            wsl_port: DEFAULT_WSL_PORT,
        }
    }
}

fn read_port_config() -> PortConfig {
    let path = crispy_root().join("tauri.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => PortConfig::default(),
    }
}

fn write_port_config(config: &PortConfig) -> Result<(), String> {
    let path = crispy_root().join("tauri.json");
    std::fs::create_dir_all(crispy_root())
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize port config: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write tauri.json: {}", e))?;
    Ok(())
}

// ============================================================================
// Health check
// ============================================================================

#[derive(Deserialize)]
struct HealthResponse {
    status: String,
    #[allow(dead_code)]
    pid: Option<u64>,
    #[allow(dead_code)]
    port: Option<u16>,
}

async fn check_health(port: u16) -> bool {
    let url = format!("http://localhost:{}/health", port);
    match reqwest::get(&url).await {
        Ok(resp) => match resp.json::<HealthResponse>().await {
            Ok(h) => h.status == "ok",
            Err(_) => false,
        },
        Err(_) => false,
    }
}

// ============================================================================
// Process management
// ============================================================================

fn read_port_file() -> Option<u16> {
    let path = run_dir().join("crispy.port");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

fn read_pid_file() -> Option<u32> {
    let path = run_dir().join("crispy.pid");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use std::process::Command;
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        use std::process::Command;
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .output()
            .map(|o| {
                let out = String::from_utf8_lossy(&o.stdout);
                out.contains(&pid.to_string())
            })
            .unwrap_or(false)
    }
}

fn kill_daemon(pid: u32) {
    kill_daemon_signal(pid, false);
}

fn kill_daemon_signal(pid: u32, _force: bool) {
    #[cfg(unix)]
    {
        let signal = if _force { "-9" } else { "-15" };
        let _ = Command::new("kill").args([signal, &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        // taskkill /F is always forceful on Windows
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status();
    }
}

fn cleanup_stale_run_files() {
    if let Some(pid) = read_pid_file() {
        if !is_process_alive(pid) {
            let _ = std::fs::remove_file(run_dir().join("crispy.pid"));
            let _ = std::fs::remove_file(run_dir().join("crispy.port"));
        }
    }
}

// ============================================================================
// Daemon spawn
// ============================================================================

fn spawn_daemon(
    node_bin: &PathBuf,
    cli_js: &PathBuf,
    port: u16,
) -> Result<u32, String> {
    // Ensure directories exist
    let log_dir = logs_dir();
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;
    std::fs::create_dir_all(run_dir())
        .map_err(|e| format!("Failed to create run directory: {}", e))?;

    let log_path = log_dir.join("crispy.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_stderr = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone log file handle: {}", e))?;

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));

    let mut cmd = Command::new(node_bin);
    cmd.arg(cli_js)
        .arg("_daemon")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&home)
        .stdout(std::process::Stdio::from(log_file))
        .stderr(std::process::Stdio::from(log_stderr));

    // On Windows, prevent a console window from appearing.
    // CREATE_NO_WINDOW and DETACHED_PROCESS are mutually exclusive per Windows docs.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn daemon: {}", e))?;
    Ok(child.id())
}

// ============================================================================
// Daemon startup orchestration
// ============================================================================

async fn start_or_attach_daemon(
    node_bin: &PathBuf,
    cli_js: &PathBuf,
    port: u16,
) -> Result<(u16, bool, Option<u32>), String> {
    // Always kill any existing daemon and start fresh. The desktop app bundles
    // its own daemon runtime — attaching to a stale daemon from a previous
    // install serves old JS and causes silent failures (no alerts, stale UI).
    if let Some(pid) = read_pid_file() {
        if is_process_alive(pid) {
            log::info!("Killing existing daemon (pid={}) to ensure fresh runtime", pid);
            kill_daemon_graceful(pid);
        }
    }

    // Clean up stale files
    cleanup_stale_run_files();

    // Spawn new daemon
    let pid = spawn_daemon(node_bin, cli_js, port)?;

    // Wait for port file (up to 15s, polling every 200ms)
    let mut port: Option<u16> = None;
    for _ in 0..75 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Some(p) = read_port_file() {
            port = Some(p);
            break;
        }
    }

    let port = match port {
        Some(p) => p,
        None => {
            kill_daemon(pid);
            return Err("Daemon did not write port file within 15 seconds. Check ~/.crispy/logs/crispy.log".to_string());
        }
    };

    // Health check with retries (up to 10 attempts, 500ms apart)
    let mut healthy = false;
    for _ in 0..10 {
        if check_health(port).await {
            healthy = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    if !healthy {
        kill_daemon(pid);
        return Err(format!(
            "Daemon started but health check failed on port {}. Check ~/.crispy/logs/crispy.log",
            port
        ));
    }

    Ok((port, true, Some(pid)))
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Called from webview init script when document.title changes.
/// Tauri v2 does not auto-propagate document.title to the native window title.
#[tauri::command]
fn set_window_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// Return the current port configuration from ~/.crispy/tauri.json.
#[tauri::command]
fn get_port_config() -> PortConfig {
    read_port_config()
}

/// Save port configuration to ~/.crispy/tauri.json.
/// Changes take effect on next daemon restart.
#[tauri::command]
fn set_port_config(native_port: u16, wsl_port: u16) -> Result<String, String> {
    let config = PortConfig { native_port, wsl_port };
    write_port_config(&config)?;
    Ok("Port config saved — restart daemon to apply".to_string())
}

/// Query WSL lifecycle status — returns JSON with status, distro, port, error.
/// Called by WorkspacePicker on mount and polled until terminal state.
#[tauri::command]
fn get_wsl_status(app: AppHandle) -> WslStatus {
    let state = app.state::<Mutex<AppState>>();
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    s.wsl_status.clone()
}

/// Navigate the calling window to the primary daemon's workspace picker.
/// Used by the logo click — ensures we always land on the native daemon,
/// not the WSL daemon (which would cause duplicate workspace entries).
#[tauri::command]
fn switch_to_picker(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let port = {
        let state = app.state::<Mutex<AppState>>();
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.primary_daemon.as_ref().map_or(0, |d| d.port)
    };
    if port == 0 {
        return Err("No daemon running".into());
    }
    let url = Url::parse(&format!("http://localhost:{}/", port))
        .map_err(|e| format!("Invalid URL: {}", e))?;
    let _ = window.navigate(url);
    Ok(())
}

/// Create a new Crispy window pointed at the same daemon.
/// Called from menu, tray, keyboard shortcut, or webview split button.
/// Optional `query` param carries fork/openPanel URL params (e.g. "forkFrom=X&forkAt=Y").
/// Optional `path` overrides the workspace path (from JS `window.location.pathname`),
/// since Tauri's `window.url()` doesn't track SPA pushState navigation.
#[tauri::command]
fn create_window(app: AppHandle, query: Option<String>, path: Option<String>) -> Result<(), String> {
    spawn_new_window(&app, query.as_deref(), path.as_deref());
    Ok(())
}

/// Shared window creation logic — used by Tauri command, menu handler, and tray.
/// Opens a new window pointed at the same workspace as the currently focused window.
/// Optional `query` is appended as URL search params (for fork/openPanel).
/// Optional `path` overrides the workspace path — use when called from JS
/// (which knows the real SPA-routed path via window.location.pathname).
///
/// IMPORTANT: WebviewWindowBuilder::build() deadlocks on Windows when called from
/// synchronous Tauri command/event handlers (wry#583). All callers are sync (menu,
/// tray, command), so we gather state synchronously then spawn an async task to do
/// the actual window creation off the main thread.
fn spawn_new_window(app: &AppHandle, query: Option<&str>, explicit_path: Option<&str>) {
    // Determine the base URL. Prefer the focused window's navigated URL (preserves
    // the correct daemon port — primary vs WSL). Fall back to primary daemon port.
    let base_url = focused_window(app)
        .and_then(|w| w.url().ok())
        .and_then(|u| {
            // Only use it if it's an http://localhost URL (not tauri:// splash)
            if u.scheme() == "http" && u.host_str() == Some("localhost") {
                u.port().map(|p| format!("http://localhost:{}", p))
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            let port = {
                let state = app.state::<Mutex<AppState>>();
                let s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.primary_daemon.as_ref().map_or(0, |d| d.port)
            };
            if port == 0 {
                log::error!("Cannot create new window: no daemon running");
            }
            format!("http://localhost:{}", port)
        });

    // Use the explicit path from JS (accurate for SPA pushState routing),
    // falling back to Tauri's window.url() (only accurate for full navigations).
    let current_path = explicit_path
        .filter(|p| p.len() > 1)
        .map(|p| p.to_string())
        .or_else(|| {
            focused_window(app)
                .and_then(|w| w.url().ok())
                .and_then(|u| {
                    let path = u.path().to_string();
                    if path.len() > 1 { Some(path) } else { None }
                })
        })
        .unwrap_or_default();

    let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("window-{}", n);
    log::info!("spawn_new_window: base={} path={:?} query={:?}", base_url, current_path, query);
    let target = match query {
        Some(q) if !q.is_empty() => format!("{}{}?{}", base_url, current_path, q),
        _ => format!("{}{}", base_url, current_path),
    };
    let app = app.clone();

    // Build the window off the main thread to avoid WebView2 deadlock (wry#583).
    tauri::async_runtime::spawn(async move {
        let target_url = match Url::parse(&target) {
            Ok(u) => u,
            Err(e) => { log::error!("Invalid URL for new window: {}", e); return; }
        };

        let window = match tauri::WebviewWindowBuilder::new(
                &app, &label, tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(WINDOW_INIT_SCRIPT)
            .title("Crispy")
            .inner_size(1200.0, 800.0)
            .min_inner_size(600.0, 400.0)
            .center()
            .on_navigation(|url| {
                if is_local_url(url.as_str()) {
                    true
                } else {
                    let _ = open::that(url.as_str());
                    false
                }
            })
            .build()
        {
            Ok(w) => w,
            Err(e) => { log::error!("Failed to create window: {}", e); return; }
        };

        // Wait for WebView2 to initialize and load the splash,
        // then navigate to daemon — same pattern as the main window.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = window.navigate(target_url);
    });
}

// ============================================================================
// Navigation guard — external links open in system browser
// ============================================================================

fn is_local_url(url: &str) -> bool {
    if let Ok(parsed) = Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            // "tauri.localhost" is the Windows origin for WebviewUrl::App(...)
            return host == "localhost" || host == "tauri.localhost"
                || host == "127.0.0.1" || host == "::1";
        }
    }
    // Allow tauri:// and about:blank
    url.starts_with("tauri://") || url.starts_with("about:")
}

// ============================================================================
// Menu action dispatch to webview
// ============================================================================

fn dispatch_menu_action(window: &WebviewWindow, action: &str) {
    let script = format!(
        "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') {{ window.__CRISPY_MENU_ACTION__('{}'); }}",
        action
    );
    let _ = window.eval(&script);
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().0.as_str();

    match id {
        "new_session" => {
            if let Some(window) = focused_window(app) {
                dispatch_menu_action(&window, id);
            }
        }
        "switch_workspace" => {
            // Always navigate to the primary (native) daemon's root — not the
            // current window's port, which may be the WSL daemon.
            let port = {
                let state = app.state::<Mutex<AppState>>();
                let s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.primary_daemon.as_ref().map_or(0, |d| d.port)
            };
            if port > 0 {
                if let Some(window) = focused_window(app) {
                    if let Ok(url) = Url::parse(&format!("http://localhost:{}/", port)) {
                        let _ = window.navigate(url);
                    }
                }
            }
        }
        "port_settings" => {
            open_port_settings_window(app);
        }
        "new_window" => {
            // Route through JS so the init script can capture window.location.pathname
            // (Tauri's window.url() doesn't track SPA pushState navigation).
            if let Some(window) = focused_window(app) {
                dispatch_menu_action(&window, "new_window");
            } else {
                spawn_new_window(app, None, None);
            }
        }
        "open_docs" => {
            let _ = open::that("https://github.com/TheSylvester/crispy");
        }
        "open_discord" => {
            let _ = open::that("https://discord.gg/e2vw4bTPup");
        }
        "open_log" => {
            let log_path = logs_dir().join("crispy.log");
            let _ = open::that(log_path);
        }
        "bring_all_front" => {
            for window in app.webview_windows().values() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

// ============================================================================
// Background health monitor
// ============================================================================

fn start_health_monitor(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;

            let state = app_handle.state::<Mutex<AppState>>();
            let (we_own, port) = {
                let s = state.lock().unwrap_or_else(|e| e.into_inner());
                let d = s.primary_daemon.as_ref();
                (d.map_or(false, |d| d.we_own), d.map_or(0, |d| d.port))
            };

            if we_own && port > 0 && !check_health(port).await {
                eval_all_windows(&app_handle,
                    "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') { window.__CRISPY_MENU_ACTION__('daemon_crashed'); }"
                );
            }
        }
    });
}

// ============================================================================
// Background update checker
// ============================================================================

fn start_update_checker(app_handle: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    tauri::async_runtime::spawn(async move {
        // Initial delay
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;

        loop {
            match app_handle.updater() {
                Ok(updater) => {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            let version = update.version.clone();
                            let script = format!(
                                "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') {{ window.__CRISPY_MENU_ACTION__('update_available:{}'); }}",
                                version
                            );
                            eval_all_windows(&app_handle, &script);
                        }
                        Ok(None) => { /* up to date */ }
                        Err(e) => {
                            log::warn!("Update check failed: {}", e);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Updater not available: {}", e);
                }
            }

            // Check every 4 hours
            tokio::time::sleep(std::time::Duration::from_secs(4 * 60 * 60)).await;
        }
    });
}

// ============================================================================
// Port settings window
// ============================================================================

fn open_port_settings_window(app: &AppHandle) {
    // If already open, show and focus it
    if let Some(w) = app.get_webview_window("port-settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "port-settings",
        tauri::WebviewUrl::App("port-settings.html".into()),
    )
    .title("Port Settings")
    .inner_size(320.0, 240.0)
    .resizable(false)
    .center()
    .build();
}

#[tauri::command]
fn close_port_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("port-settings") {
        let _ = w.close();
    }
}

// ============================================================================
// Tray
// ============================================================================

fn build_tray(app: &AppHandle, we_own_daemon: bool) -> Result<(), String> {
    let open_item = MenuItemBuilder::with_id("tray_open", "Open Crispy").build(app)
        .map_err(|e| format!("Failed to build menu item: {}", e))?;

    let new_window_item = MenuItemBuilder::with_id("tray_new_window", "New Window").build(app)
        .map_err(|e| format!("Failed to build menu item: {}", e))?;

    let daemon_item = if we_own_daemon {
        MenuItemBuilder::with_id("tray_restart", "Restart Daemon").build(app)
            .map_err(|e| format!("Failed to build menu item: {}", e))?
    } else {
        MenuItemBuilder::with_id("tray_reconnect", "Reconnect").build(app)
            .map_err(|e| format!("Failed to build menu item: {}", e))?
    };

    let separator = tauri::menu::PredefinedMenuItem::separator(app)
        .map_err(|e| format!("Failed to build separator: {}", e))?;

    let port_settings_item = MenuItemBuilder::with_id("tray_port_settings", "Port Settings…").build(app)
        .map_err(|e| format!("Failed to build menu item: {}", e))?;

    let quit_item = MenuItemBuilder::with_id("tray_quit", "Quit").build(app)
        .map_err(|e| format!("Failed to build menu item: {}", e))?;

    let tray_menu = tauri::menu::MenuBuilder::new(app)
        .item(&open_item)
        .item(&new_window_item)
        .item(&daemon_item)
        .item(&port_settings_item)
        .item(&separator)
        .item(&quit_item)
        .build()
        .map_err(|e| format!("Failed to build tray menu: {}", e))?;

    let tray_builder = TrayIconBuilder::new();
    let tray_builder = if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder.icon(icon)
    } else {
        tray_builder
    };
    tray_builder
        .menu(&tray_menu)
        .tooltip("Crispy")
        .on_menu_event(move |app, event| {
            let id = event.id().0.as_str();
            match id {
                "tray_open" => {
                    show_any_window(app);
                }
                "tray_new_window" => {
                    spawn_new_window(app, None, None);
                }
                "tray_restart" => {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        restart_daemon(&app_clone).await;
                    });
                }
                "tray_reconnect" => {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        reconnect_daemon(&app_clone).await;
                    });
                }
                "tray_port_settings" => {
                    open_port_settings_window(app);
                }
                "tray_quit" => {
                    {
                        let state = app.state::<Mutex<AppState>>();
                        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                        s.is_quitting = true;
                    }
                    shutdown_daemon(app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_any_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {}", e))?;

    Ok(())
}

// ============================================================================
// WSL Detection & Daemon Management (Windows only)
// ============================================================================

/// Result of WSL detection: distro name, install state, and version info.
#[allow(dead_code)]
struct WslDetection {
    distro: String,
    crispy_installed: bool,
    /// Installed crispy-code version in WSL (e.g. "0.2.8"), if detectable.
    installed_version: Option<String>,
    daemon_port: Option<u16>,
}

/// Create a `wsl.exe` Command with CREATE_NO_WINDOW to prevent console flashing.
#[cfg(windows)]
fn wsl_command() -> Command {
    let mut cmd = Command::new("wsl.exe");
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Detect the default WSL distro and check if crispy-code is available.
#[cfg(windows)]
fn detect_wsl() -> Option<WslDetection> {
    // Run `wsl.exe -l -v` to list distros
    let output = wsl_command()
        .args(["-l", "-v"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    // wsl.exe -l -v outputs UTF-16LE on Windows
    let stdout_bytes = &output.stdout;
    let stdout = String::from_utf16_lossy(
        &stdout_bytes.chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<u16>>()
    );

    // Parse lines: "  NAME    STATE   VERSION"
    // Default distro has a '*' prefix
    let mut default_distro: Option<String> = None;
    for line in stdout.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let is_default = trimmed.starts_with('*');
        let name_part = if is_default {
            trimmed[1..].trim_start()
        } else {
            trimmed
        };

        // Extract distro name (first whitespace-delimited token)
        let distro_name = name_part.split_whitespace().next()?;

        // Check if it's running
        let is_running = name_part.contains("Running");

        if is_default || (default_distro.is_none() && is_running) {
            default_distro = Some(distro_name.to_string());
        }
    }

    let distro = default_distro?;

    // Check if crispy-code is installed (global PATH or ~/.crispy/bin/)
    let which_result = wsl_command()
        .args(["-d", &distro, "-e", "bash", "-lic",
               "which crispy 2>/dev/null || test -x ~/.crispy/node_modules/.bin/crispy"])
        .output()
        .ok();
    let crispy_installed = which_result
        .map(|o| o.status.success())
        .unwrap_or(false);

    // Check installed version
    let installed_version = if crispy_installed {
        wsl_command()
            .args(["-d", &distro, "-e", "bash", "-c",
                   "node -e \"try{process.stdout.write(require(process.env.HOME+'/.crispy/node_modules/crispy/package.json').version)}catch{process.stdout.write(require(process.env.HOME+'/.crispy/node_modules/crispy-code/package.json').version)}\" 2>/dev/null"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if !v.is_empty() { Some(v) } else { None }
                } else {
                    None
                }
            })
    } else {
        None
    };

    // If installed, check for a LIVE daemon inside WSL.
    // Must verify the PID is alive inside WSL — not just that the port responds,
    // because WSL2 localhost forwarding means the Windows daemon's port is also
    // reachable from the health check, producing false positives.
    let daemon_port = if crispy_installed {
        wsl_command()
            .args(["-d", &distro, "-e", "bash", "-c",
                   "pid=$(cat ~/.crispy/run/crispy.pid 2>/dev/null) && kill -0 $pid 2>/dev/null && cat ~/.crispy/run/crispy.port 2>/dev/null"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8_lossy(&o.stdout).trim().parse::<u16>().ok()
                } else {
                    None
                }
            })
    } else {
        None
    };

    Some(WslDetection { distro, crispy_installed, installed_version, daemon_port })
}

/// Spawn a crispy-code daemon inside WSL.
#[cfg(windows)]
async fn spawn_wsl_daemon(distro: &str, wsl_port: u16) -> Result<u16, String> {
    // Clean up stale run files inside WSL before spawning.
    // Without this, the daemon may see a stale port file and exit early.
    let _ = wsl_command()
        .args(["-d", distro, "-e", "bash", "-c",
               "rm -f ~/.crispy/run/crispy.pid ~/.crispy/run/crispy.port"])
        .output();

    // Use bash -lic (interactive login) so .bashrc is fully sourced — nvm, fnm, volta
    // etc. only initialize in interactive shells. Without -i, node isn't in PATH.
    // Redirect daemon output to a log file inside WSL for debugging.
    let spawn_cmd = format!(
        "mkdir -p ~/.crispy/logs ~/.crispy/run; export PATH=$HOME/.crispy/node_modules/.bin:$PATH; crispy _daemon --host 0.0.0.0 --port {} >> ~/.crispy/logs/wsl-daemon.log 2>&1",
        wsl_port
    );
    let mut cmd = wsl_command();
    cmd.args([
            "-d", distro,
            "-e", "bash", "-lic",
            &spawn_cmd,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let _child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn WSL daemon: {}", e))?;

    // Poll for port file AND verify PID is alive inside WSL (up to 15s).
    // Don't use check_health(port) from Windows — WSL2 localhost forwarding
    // would make the Windows daemon answer, giving a false positive.
    for _ in 0..75 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Verify PID alive + read port in one shot inside WSL
        if let Ok(out) = wsl_command()
            .args(["-d", distro, "-e", "bash", "-c",
                   "pid=$(cat ~/.crispy/run/crispy.pid 2>/dev/null) && kill -0 $pid 2>/dev/null && cat ~/.crispy/run/crispy.port 2>/dev/null"])
            .output()
        {
            if out.status.success() {
                if let Ok(port) = String::from_utf8_lossy(&out.stdout).trim().parse::<u16>() {
                    return Ok(port);
                }
            }
        }
    }

    Err("WSL daemon did not start within 15 seconds".into())
}

/// Provision or upgrade crispy-code in WSL from the bundled tarball.
/// Uses `wslpath` to convert the Windows resource path to a WSL-accessible path.
#[cfg(windows)]
async fn provision_wsl_crispy(app: &AppHandle, distro: &str) -> Result<(), String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;

    // Find the bundled .tgz tarball
    let runtime_dir = resource_dir.join("runtime");
    let tarball = std::fs::read_dir(&runtime_dir)
        .map_err(|e| format!("Failed to read runtime dir: {}", e))?
        .filter_map(|e| e.ok())
        .find(|e| {
            e.file_name().to_string_lossy().starts_with("crispy-")
                && e.file_name().to_string_lossy().ends_with(".tgz")
        })
        .ok_or_else(|| "No crispy tarball found in runtime bundle".to_string())?;

    let win_path = tarball.path().to_string_lossy().to_string();
    log::info!("Provisioning WSL crispy-code from: {}", win_path);

    // Use wslpath inside WSL to convert the Windows path — handles spaces, drive letters, etc.
    // Then npm install from the tarball to get correct Linux native modules.
    let install_cmd = format!(
        r#"src=$(wslpath -a -u '{}'); npm install --prefix "$HOME/.crispy" "$src" 2>&1"#,
        win_path.replace('\'', "'\\''")
    );

    #[allow(unused_imports)]
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-d", distro, "-e", "bash", "-lic", &install_cmd]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run WSL provision: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if output.status.success() {
        log::info!("WSL crispy-code provisioned successfully");
        Ok(())
    } else {
        Err(format!("WSL provision failed (exit {}):\n{}", output.status, stdout))
    }
}

/// Start WSL daemon detection and management after primary daemon is ready.
#[cfg(windows)]
fn start_wsl_daemon_manager(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Short delay to let the primary daemon stabilize
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        // Read WSL settings
        // TODO: read from %APPDATA%\Crispy\settings.json for wslEnabled/wslDistro

        let set_status = |handle: &AppHandle, status: WslStatus| {
            let state = handle.state::<Mutex<AppState>>();
            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.wsl_status = status;
        };

        let detection = detect_wsl();
        let detection = match detection {
            Some(d) => d,
            None => {
                log::info!("No WSL detected or WSL not available");
                set_status(&app_handle, WslStatus::NotFound);
                return;
            }
        };

        let app_version = app_handle.package_info().version.to_string();
        log::info!("WSL detected: distro={}, crispy_installed={}, version={:?}, app={}",
            detection.distro, detection.crispy_installed,
            detection.installed_version, app_version);

        if !detection.crispy_installed {
            // Not installed at all — try auto-provisioning from bundled tarball
            log::info!("crispy-code not installed in WSL, attempting auto-provision...");
            set_status(&app_handle, WslStatus::Starting { distro: detection.distro.clone() });
            match provision_wsl_crispy(&app_handle, &detection.distro).await {
                Ok(()) => {
                    log::info!("Auto-provisioned crispy-code in WSL");
                }
                Err(e) => {
                    log::error!("Auto-provision failed: {}", e);
                    set_status(&app_handle, WslStatus::NotInstalled { distro: detection.distro.clone() });
                    return;
                }
            }
        } else if detection.installed_version.as_deref() != Some(&app_version) {
            // Version mismatch — upgrade from bundled tarball
            log::info!("WSL crispy-code version mismatch ({:?} vs {}), upgrading...",
                detection.installed_version, app_version);
            set_status(&app_handle, WslStatus::Starting { distro: detection.distro.clone() });
            match provision_wsl_crispy(&app_handle, &detection.distro).await {
                Ok(()) => {
                    log::info!("Upgraded crispy-code in WSL to {}", app_version);
                }
                Err(e) => {
                    log::warn!("Upgrade failed, proceeding with existing version: {}", e);
                    // Don't abort — try with the old version, it might partially work
                }
            }
        }

        // Always kill existing WSL daemon and start fresh — same reasoning as
        // the native daemon: attaching to a stale daemon serves old JS.
        set_status(&app_handle, WslStatus::Starting { distro: detection.distro.clone() });

        if detection.daemon_port.is_some() {
            log::info!("Killing existing WSL daemon to ensure fresh runtime");
            let _ = wsl_command()
                .args(["-d", &detection.distro, "-e", "bash", "-c",
                       "kill $(cat ~/.crispy/run/crispy.pid 2>/dev/null) 2>/dev/null; rm -f ~/.crispy/run/crispy.pid ~/.crispy/run/crispy.port"])
                .status();
            // Brief pause for process cleanup
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }

        let port = {
            let wsl_port = read_port_config().wsl_port;
            match spawn_wsl_daemon(&detection.distro, wsl_port).await {
                Ok(p) => p,
                Err(e) => {
                    log::error!("Failed to spawn WSL daemon: {}", e);
                    set_status(&app_handle, WslStatus::Failed {
                        distro: detection.distro.clone(),
                        error: e.clone(),
                    });
                    return;
                }
            }
        };

        // Store WSL daemon state
        {
            let state = app_handle.state::<Mutex<AppState>>();
            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.wsl_daemon = Some(DaemonState {
                pid: None, // WSL PID not directly accessible from Windows
                port,
                we_own: true,
                environment: DaemonEnv::Wsl,
                wsl_distro: Some(detection.distro.clone()),
            });
            s.wsl_status = WslStatus::Connected {
                distro: detection.distro.clone(),
                port,
            };
        }

        log::info!("WSL daemon ready at port {} (distro: {})", port, detection.distro);
    });
}

/// Stub for non-Windows platforms.
#[cfg(not(windows))]
fn start_wsl_daemon_manager(_app_handle: AppHandle) {
    // WSL detection only runs on Windows
}

/// Tauri command: install crispy-code in WSL (called from install card UI).
/// Uses the bundled tarball via provision_wsl_crispy for version-matched install.
#[cfg(windows)]
#[tauri::command]
async fn install_crispy_in_wsl(app: AppHandle, distro: String) -> Result<String, String> {
    provision_wsl_crispy(&app, &distro).await
        .map(|()| "crispy-code installed successfully".to_string())
}

#[cfg(not(windows))]
#[tauri::command]
async fn install_crispy_in_wsl(_distro: String) -> Result<String, String> {
    Err("WSL install only available on Windows".into())
}

// ============================================================================
// Daemon restart / reconnect
// ============================================================================

async fn restart_daemon(app: &AppHandle) {
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(_) => return,
    };

    let node_bin = resource_dir.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" });
    let cli_js = resource_dir.join("runtime").join("crispy").join("dist").join("crispy-cli.js");

    // Kill current daemon if we own it
    shutdown_daemon(app);

    // Spawn new one — read port config for restart too
    let port_config = read_port_config();
    match start_or_attach_daemon(&node_bin, &cli_js, port_config.native_port).await {
        Ok((port, we_own, pid)) => {
            {
                let state = app.state::<Mutex<AppState>>();
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.primary_daemon = Some(DaemonState {
                    pid,
                    port,
                    we_own,
                    environment: DaemonEnv::Native,
                    wsl_distro: None,
                });
            }
            if let Ok(url) = Url::parse(&format!("http://localhost:{}", port)) {
                navigate_all_windows(app, &url);
            }
        }
        Err(e) => {
            log::error!("Failed to restart daemon: {}", e);
        }
    }
}

async fn reconnect_daemon(app: &AppHandle) {
    if let Some(port) = read_port_file() {
        if check_health(port).await {
            {
                let state = app.state::<Mutex<AppState>>();
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(ref mut d) = s.primary_daemon {
                    d.port = port;
                } else {
                    s.primary_daemon = Some(DaemonState {
                        pid: read_pid_file(),
                        port,
                        we_own: false,
                        environment: DaemonEnv::Native,
                        wsl_distro: None,
                    });
                }
            }
            if let Ok(url) = Url::parse(&format!("http://localhost:{}", port)) {
                navigate_all_windows(app, &url);
            }
        }
    }
}

/// Kill a daemon process gracefully, then force-kill if still alive after 5s.
fn kill_daemon_graceful(pid: u32) {
    kill_daemon(pid);
    for _ in 0..50 {
        if !is_process_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    kill_daemon_signal(pid, true);
}

fn shutdown_daemon(app: &AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let s = state.lock().unwrap_or_else(|e| e.into_inner());

    // Always kill the primary daemon on quit — even if we attached to an existing one.
    // The desktop app IS the daemon lifecycle owner. If someone restarts and we left
    // a stale daemon, the new app attaches to it and serves old JS.
    if let Some(ref d) = s.primary_daemon {
        if let Some(pid) = d.pid {
            kill_daemon_graceful(pid);
        }
    }

    // Always kill WSL daemon too.
    // WSL processes can't be killed via Windows taskkill — use wsl.exe
    #[cfg(windows)]
    if let Some(ref d) = s.wsl_daemon {
        if d.port > 0 {
            if let Some(ref distro) = d.wsl_distro {
                let distro = distro.clone();
                let _ = std::thread::spawn(move || {
                    let _ = wsl_command()
                        .args(["-d", &distro, "-e", "bash", "-c",
                               "kill $(cat ~/.crispy/run/crispy.pid 2>/dev/null) 2>/dev/null"])
                        .status();
                }).join();
            }
        }
    }
}

// ============================================================================
// Tauri entry point
// ============================================================================

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_any_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![set_window_title, create_window, switch_to_picker, get_wsl_status, install_crispy_in_wsl, get_port_config, set_port_config, close_port_settings])
        .manage(Mutex::new(AppState {
            primary_daemon: None,
            wsl_daemon: None,
            is_quitting: false,
            wsl_status: WslStatus::Detecting,
        }))
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Clear ALL WebView2 caches on startup to ensure fresh JS is loaded.
            // WebView2 aggressively caches HTTP responses from localhost even with
            // Cache-Control headers. Nuke every cache directory under EBWebView/.
            #[cfg(windows)]
            {
                if let Ok(data_dir) = app_handle.path().app_local_data_dir() {
                    let webview_dir = data_dir.join("EBWebView");
                    if webview_dir.exists() {
                        // Delete cache dirs: Default/Cache, Default/Code Cache,
                        // ShaderCache, GrShaderCache, GraphiteDawnCache, etc.
                        for dir_name in &[
                            "Default\\Cache", "Default\\Code Cache",
                            "Default\\Service Worker", "ShaderCache",
                            "GrShaderCache", "GraphiteDawnCache",
                        ] {
                            let dir = webview_dir.join(dir_name);
                            if dir.exists() {
                                log::info!("Clearing WebView2 cache: {:?}", dir);
                                let _ = std::fs::remove_dir_all(&dir);
                            }
                        }
                    }
                }
            }

            // Build native menu
            match menu::build_menu(&app_handle) {
                Ok(menu) => {
                    let _ = app.set_menu(menu);
                }
                Err(e) => {
                    log::error!("Failed to build menu: {}", e);
                }
            }

            // Resolve bundled paths
            let resource_dir = app_handle.path().resource_dir()
                .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

            let node_bin = resource_dir.join("runtime").join(
                if cfg!(windows) { "node.exe" } else { "node" }
            );
            let cli_js = resource_dir
                .join("runtime")
                .join("crispy")
                .join("dist")
                .join("crispy-cli.js");

            // Verify bundled Node.js exists
            if !node_bin.exists() {
                let msg = format!(
                    "Bundled Node.js not found at: {}\n\nPlease reinstall Crispy.",
                    node_bin.display()
                );
                tauri::async_runtime::block_on(async {
                    use tauri_plugin_dialog::DialogExt;
                    app_handle.dialog().message(&msg).title("Crispy — Error").blocking_show();
                });
                return Err(msg.into());
            }

            if !cli_js.exists() {
                let msg = format!(
                    "Crispy daemon script not found at: {}\n\nPlease reinstall Crispy.",
                    cli_js.display()
                );
                tauri::async_runtime::block_on(async {
                    use tauri_plugin_dialog::DialogExt;
                    app_handle.dialog().message(&msg).title("Crispy — Error").blocking_show();
                });
                return Err(msg.into());
            }

            // Create the main window with desktop mode flag
            let window = tauri::WebviewWindowBuilder::new(
                &app_handle,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(WINDOW_INIT_SCRIPT)
            .title("Crispy")
            .inner_size(1200.0, 800.0)
            .min_inner_size(600.0, 400.0)
            .center()
            .on_navigation(|url| {
                if is_local_url(url.as_str()) {
                    true
                } else {
                    let _ = open::that(url.as_str());
                    false
                }
            })
            .build()?;

            // Spawn daemon in background
            let handle_for_spawn = app_handle.clone();
            let window_clone = window.clone();
            tauri::async_runtime::spawn(async move {
                let port_config = read_port_config();
                match start_or_attach_daemon(&node_bin, &cli_js, port_config.native_port).await {
                    Ok((port, we_own, pid)) => {
                        // Update state
                        {
                            let state = handle_for_spawn.state::<Mutex<AppState>>();
                            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                            s.primary_daemon = Some(DaemonState {
                                pid,
                                port,
                                we_own,
                                environment: DaemonEnv::Native,
                                wsl_distro: None,
                            });
                        }

                        // Navigate to daemon
                        if let Ok(url) = Url::parse(&format!("http://localhost:{}", port)) {
                            let _ = window_clone.navigate(url);
                        }

                        // Build tray after daemon is ready
                        if let Err(e) = build_tray(&handle_for_spawn, we_own) {
                            log::error!("Failed to build tray: {}", e);
                        }

                        // Start background monitors
                        start_health_monitor(handle_for_spawn.clone());
                        start_update_checker(handle_for_spawn.clone());

                        // Start WSL daemon detection (Windows only, no-op elsewhere)
                        start_wsl_daemon_manager(handle_for_spawn);
                    }
                    Err(e) => {
                        log::error!("Daemon startup failed: {}", e);
                        use tauri_plugin_dialog::DialogExt;
                        handle_for_spawn
                            .dialog()
                            .message(&format!("Failed to start Crispy daemon:\n\n{}", e))
                            .title("Crispy — Startup Error")
                            .blocking_show();
                    }
                }
            });

            Ok(())
        })
        .on_menu_event(handle_menu_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    // Only hide the main window (tray persists) — let dialogs close normally
                    if label == "main" {
                        api.prevent_close();
                        if let Some(w) = app.get_webview_window(&label) {
                            let _ = w.hide();
                        }
                    }
                }
                RunEvent::ExitRequested { api, .. } => {
                    // Only prevent exit when window is hidden — allow explicit quit
                    let state = app.state::<Mutex<AppState>>();
                    let quitting = state.lock().unwrap_or_else(|e| e.into_inner()).is_quitting;
                    if !quitting {
                        api.prevent_exit();
                    }
                }
                RunEvent::Exit => {
                    shutdown_daemon(app);
                }
                _ => {}
            }
        });
}
