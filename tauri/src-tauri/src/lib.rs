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
    new MutationObserver(function() {
        ipc.invoke('set_window_title', { title: document.title }).catch(function() {});
    }).observe(document.querySelector('title') || document.head, {
        subtree: true, childList: true, characterData: true
    });
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
}

struct AppState {
    primary_daemon: Option<DaemonState>,
    #[allow(dead_code)]
    wsl_daemon: Option<DaemonState>,   // Phase C: WSL remote daemon
    is_quitting: bool,
    /// WSL distro name if detected but crispy-code not installed.
    /// Cleared after install succeeds. Queryable by webview on demand.
    wsl_needs_install: Option<String>,
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
) -> Result<(u16, bool, Option<u32>), String> {
    // Check for an existing healthy daemon
    if let Some(port) = read_port_file() {
        if check_health(port).await {
            return Ok((port, false, read_pid_file()));
        }
    }

    // Clean up stale files
    cleanup_stale_run_files();

    // Spawn new daemon
    let pid = spawn_daemon(node_bin, cli_js)?;

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

/// Query WSL state — returns distro name if WSL needs install, null otherwise.
/// Called by WorkspacePicker on mount so it doesn't depend on event timing.
#[tauri::command]
fn get_wsl_status(app: AppHandle) -> Option<String> {
    let state = app.state::<Mutex<AppState>>();
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    s.wsl_needs_install.clone()
}

/// Create a new Crispy window pointed at the same daemon.
/// Called from menu, tray, keyboard shortcut, or webview split button.
#[tauri::command]
fn create_window(app: AppHandle) -> Result<(), String> {
    spawn_new_window(&app)
}

/// Shared window creation logic — used by Tauri command, menu handler, and tray.
/// Opens a new window pointed at the same workspace as the currently focused window.
fn spawn_new_window(app: &AppHandle) -> Result<(), String> {
    let port = {
        let state = app.state::<Mutex<AppState>>();
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.primary_daemon.as_ref().map_or(0, |d| d.port)
    };
    if port == 0 {
        return Err("No daemon running".into());
    }

    // Grab the focused window's URL to preserve the workspace path.
    // e.g. http://localhost:3456/dev-crispy/ → new window opens same workspace.
    let current_path = focused_window(app)
        .and_then(|w| w.url().ok())
        .and_then(|u| {
            let path = u.path().to_string();
            if path.len() > 1 { Some(path) } else { None }
        })
        .unwrap_or_default();

    let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("window-{}", n);

    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
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
        .map_err(|e| format!("Failed to create window: {}", e))?;

    // Navigate to same workspace as the focused window
    let target = format!("http://localhost:{}{}", port, current_path);
    if let Ok(url) = Url::parse(&target) {
        let _ = window.navigate(url);
    }

    Ok(())
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
        "new_session" | "toggle_sidebar" | "settings" | "zoom_in" | "zoom_out" | "zoom_reset" => {
            if let Some(window) = focused_window(app) {
                dispatch_menu_action(&window, id);
            }
        }
        "new_window" => {
            if let Err(e) = spawn_new_window(app) {
                log::error!("Failed to create new window: {}", e);
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

    let quit_item = MenuItemBuilder::with_id("tray_quit", "Quit").build(app)
        .map_err(|e| format!("Failed to build menu item: {}", e))?;

    let tray_menu = tauri::menu::MenuBuilder::new(app)
        .item(&open_item)
        .item(&new_window_item)
        .item(&daemon_item)
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
                    if let Err(e) = spawn_new_window(app) {
                        log::error!("Tray new window failed: {}", e);
                    }
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

/// Result of WSL detection: distro name and whether crispy-code is installed.
#[allow(dead_code)]
struct WslDetection {
    distro: String,
    crispy_installed: bool,
    daemon_port: Option<u16>,
}

/// Detect the default WSL distro and check if crispy-code is available.
#[cfg(windows)]
fn detect_wsl() -> Option<WslDetection> {
    // Run `wsl.exe -l -v` to list distros
    let output = Command::new("wsl.exe")
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
    let which_result = Command::new("wsl.exe")
        .args(["-d", &distro, "-e", "bash", "-lc",
               "which crispy-code 2>/dev/null || test -x ~/.crispy/bin/crispy-code"])
        .output()
        .ok();
    let crispy_installed = which_result
        .map(|o| o.status.success())
        .unwrap_or(false);

    // If installed, check for running daemon
    let daemon_port = if crispy_installed {
        Command::new("wsl.exe")
            .args(["-d", &distro, "-e", "cat", &format!("{}/.crispy/run/crispy.port", "~")])
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

    Some(WslDetection { distro, crispy_installed, daemon_port })
}

/// Spawn a crispy-code daemon inside WSL.
#[cfg(windows)]
async fn spawn_wsl_daemon(distro: &str) -> Result<u16, String> {
    let _child = Command::new("wsl.exe")
        .args([
            "-d", distro,
            "-e", "bash", "-lc",
            "export PATH=$HOME/.crispy/bin:$PATH; crispy-code _daemon --host 0.0.0.0",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn WSL daemon: {}", e))?;

    // Poll for port file (up to 15s)
    for _ in 0..75 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let output = Command::new("wsl.exe")
            .args(["-d", distro, "-e", "cat", "/tmp/.crispy-port-check"])
            .output();

        // Try reading port file via wsl.exe
        if let Ok(out) = Command::new("wsl.exe")
            .args(["-d", distro, "-e", "bash", "-c",
                   "cat ~/.crispy/run/crispy.port 2>/dev/null"])
            .output()
        {
            if out.status.success() {
                if let Ok(port) = String::from_utf8_lossy(&out.stdout).trim().parse::<u16>() {
                    // Verify health before returning
                    if check_health(port).await {
                        return Ok(port);
                    }
                }
            }
        }
        // Suppress unused variable warning
        let _ = output;
    }

    Err("WSL daemon did not start within 15 seconds".into())
}

/// Start WSL daemon detection and management after primary daemon is ready.
#[cfg(windows)]
fn start_wsl_daemon_manager(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Short delay to let the primary daemon stabilize
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        // Read WSL settings
        // TODO: read from %APPDATA%\Crispy\settings.json for wslEnabled/wslDistro

        let detection = detect_wsl();
        let detection = match detection {
            Some(d) => d,
            None => {
                log::info!("No WSL detected or WSL not available");
                return;
            }
        };

        log::info!("WSL detected: distro={}, crispy_installed={}", detection.distro, detection.crispy_installed);

        if !detection.crispy_installed {
            // Store in AppState so webview can query via get_wsl_status command
            {
                let state = app_handle.state::<Mutex<AppState>>();
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.wsl_needs_install = Some(detection.distro.clone());
            }
            // Also fire event for any already-loaded pages
            let script = format!(
                "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') {{ window.__CRISPY_MENU_ACTION__('wsl_detected:{}:not_installed'); }}",
                detection.distro
            );
            eval_all_windows(&app_handle, &script);
            return;
        }

        // Try to connect to existing daemon or spawn a new one
        let port = if let Some(port) = detection.daemon_port {
            if check_health(port).await {
                log::info!("WSL daemon already running on port {}", port);
                port
            } else {
                match spawn_wsl_daemon(&detection.distro).await {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("Failed to spawn WSL daemon: {}", e);
                        return;
                    }
                }
            }
        } else {
            match spawn_wsl_daemon(&detection.distro).await {
                Ok(p) => p,
                Err(e) => {
                    log::error!("Failed to spawn WSL daemon: {}", e);
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
            });
        }

        // Notify webview about WSL daemon availability
        let script = format!(
            "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') {{ window.__CRISPY_MENU_ACTION__('wsl_daemon_ready:{}:{}'); }}",
            detection.distro, port
        );
        eval_all_windows(&app_handle, &script);

        log::info!("WSL daemon ready at port {} (distro: {})", port, detection.distro);
    });
}

/// Stub for non-Windows platforms.
#[cfg(not(windows))]
fn start_wsl_daemon_manager(_app_handle: AppHandle) {
    // WSL detection only runs on Windows
}

/// Tauri command: install crispy-code in WSL (called from install card UI).
#[cfg(windows)]
#[tauri::command]
async fn install_crispy_in_wsl(distro: String) -> Result<String, String> {
    let output = tokio::process::Command::new("wsl.exe")
        .args([
            "-d", &distro,
            "-e", "bash", "-lc",
            "mkdir -p ~/.crispy/bin && npm install --prefix ~/.crispy crispy-code 2>&1 && ln -sf ~/.crispy/node_modules/.bin/crispy-code ~/.crispy/bin/crispy-code 2>&1",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run install command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!("Install failed (exit {}):\n{}", output.status, stdout))
    }
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

    // Spawn new one
    match start_or_attach_daemon(&node_bin, &cli_js).await {
        Ok((port, we_own, pid)) => {
            {
                let state = app.state::<Mutex<AppState>>();
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.primary_daemon = Some(DaemonState {
                    pid,
                    port,
                    we_own,
                    environment: DaemonEnv::Native,
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

    if let Some(ref d) = s.primary_daemon {
        if d.we_own {
            if let Some(pid) = d.pid {
                kill_daemon_graceful(pid);
            }
        }
    }

    // Shutdown WSL daemon if we own it
    // WSL processes can't be killed via Windows taskkill — use wsl.exe
    #[cfg(windows)]
    if let Some(ref d) = s.wsl_daemon {
        if d.we_own && d.port > 0 {
            // Send shutdown request via HTTP
            let port = d.port;
            let _ = std::thread::spawn(move || {
                let _ = Command::new("wsl.exe")
                    .args(["-e", "bash", "-c",
                           &format!("kill $(cat ~/.crispy/run/crispy.pid 2>/dev/null) 2>/dev/null")])
                    .status();
                // Suppress unused variable
                let _ = port;
            }).join();
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
        .invoke_handler(tauri::generate_handler![set_window_title, create_window, get_wsl_status, install_crispy_in_wsl])
        .manage(Mutex::new(AppState {
            primary_daemon: None,
            wsl_daemon: None,
            is_quitting: false,
            wsl_needs_install: None,
        }))
        .setup(|app| {
            let app_handle = app.handle().clone();

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
                match start_or_attach_daemon(&node_bin, &cli_js).await {
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
                    // Hide window instead of closing — tray persists
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.hide();
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
