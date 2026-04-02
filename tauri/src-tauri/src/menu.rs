//! Native menu bar — platform-standard menus for Crispy desktop.
//!
//! macOS: App menu + File/Edit/View/Window/Help
//! Windows/Linux: File/Edit/View/Window/Help (no app-name menu)

use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Wry,
};

/// Build the platform-appropriate menu bar.
pub fn build_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    let menu = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, "Crispy")
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu.item(&app_menu)
    };

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new_session", "New Session")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("new_window", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("switch_workspace", "Switch Workspace")
                .build(app)?,
        )
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // View menu removed — sidebar/zoom controls live in the webview UI

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .item(&MenuItemBuilder::with_id("bring_all_front", "Bring All to Front").build(app)?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("open_docs", "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("open_discord", "Discord").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("open_log", "Open Log File").build(app)?)
        .build()?;

    menu.item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}
