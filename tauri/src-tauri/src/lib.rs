//! Crispy Desktop — Tauri v2 shell for the Crispy daemon.
//!
//! Lifecycle: splash → spawn bundled node + daemon → wait for health →
//! navigate webview to localhost:{port}. Tray icon persists when window
//! is closed; "Quit" from tray kills the daemon (if we own it) and exits.

mod menu;

use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{
    menu::{MenuEvent, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WebviewWindow, WindowEvent,
};

// ============================================================================
// State
// ============================================================================

struct AppState {
    we_own_daemon: bool,
    daemon_pid: Option<u32>,
    daemon_port: u16,
    is_quitting: bool,
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
            if let Some(window) = app.get_webview_window("main") {
                dispatch_menu_action(&window, id);
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
            if let Some(window) = app.get_webview_window("main") {
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
                (s.we_own_daemon, s.daemon_port)
            };

            if we_own && port > 0 && !check_health(port).await {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.eval(
                        "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') { window.__CRISPY_MENU_ACTION__('daemon_crashed'); }"
                    );
                }
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
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let version = update.version.clone();
                                let script = format!(
                                    "if (typeof window.__CRISPY_MENU_ACTION__ === 'function') {{ window.__CRISPY_MENU_ACTION__('update_available:{}'); }}",
                                    version
                                );
                                let _ = window.eval(&script);
                            }
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
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
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
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {}", e))?;

    Ok(())
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
                s.we_own_daemon = we_own;
                s.daemon_pid = pid;
                s.daemon_port = port;
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = Url::parse(&format!("http://localhost:{}", port)) {
                    let _ = window.navigate(url);
                }
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
            let state = app.state::<Mutex<AppState>>();
            {
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.daemon_port = port;
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = Url::parse(&format!("http://localhost:{}", port)) {
                    let _ = window.navigate(url);
                }
            }
        }
    }
}

fn shutdown_daemon(app: &AppHandle) {
    let state = app.state::<Mutex<AppState>>();
    let (we_own, pid) = {
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        (s.we_own_daemon, s.daemon_pid)
    };

    if we_own {
        if let Some(pid) = pid {
            kill_daemon(pid);

            // Wait up to 5s for process to exit
            for _ in 0..50 {
                if !is_process_alive(pid) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            // Force kill (SIGKILL on Unix) if still alive
            if is_process_alive(pid) {
                kill_daemon_signal(pid, true);
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
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(AppState {
            we_own_daemon: false,
            daemon_pid: None,
            daemon_port: 0,
            is_quitting: false,
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
            .initialization_script("window.__CRISPY_DESKTOP__ = true;")
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
                            s.we_own_daemon = we_own;
                            s.daemon_pid = pid;
                            s.daemon_port = port;
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
                        start_update_checker(handle_for_spawn);
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
                } if label == "main" => {
                    // Hide window instead of closing — tray persists
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
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
