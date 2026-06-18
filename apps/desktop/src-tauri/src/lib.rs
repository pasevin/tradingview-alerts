// Tauri 2 app entry. Menu-bar (Accessory) app with a click-toggle popover,
// native vibrancy, a local webhook HTTP server, persistent settings + alerts,
// and commands the frontend uses to drive it all. No Glaze runtime.
mod relay;
mod store;
mod webhook;

use relay::{AuthStatus, RelayClient, RelayStatus};
use std::sync::Arc;
use store::{Alert, Settings, SettingsPatch, Store};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_updater::UpdaterExt;
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

/// Shared tokio runtime for relay async work (the webhook server owns its own).
struct Runtime(tokio::runtime::Runtime);

/// Holds the shutdown sender for the running webhook server (if any).
struct WebhookHandle(std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>);

impl WebhookHandle {
    fn new() -> Self { WebhookHandle(std::sync::Mutex::new(None)) }
    fn set(&self, tx: tokio::sync::oneshot::Sender<()>) {
        *self.0.lock().unwrap() = Some(tx);
    }
    fn stop(&self) {
        // dropping the sender signals shutdown
        let _ = self.0.lock().unwrap().take();
    }
}

/// Start or stop the local webhook server based on relay+Pro state.
/// Rule: stop when cloud is connected AND Pro; start (or keep running) otherwise.
/// Uses the store's persisted state — no async required.
pub fn sync_webhook_server(app: &AppHandle) {
    let store = app.state::<Arc<Store>>();
    let handle = app.state::<WebhookHandle>();
    let settings = store.get_settings();

    // Read cloud connection state from the relay status event payload if available,
    // otherwise infer from persisted settings: signed-in Pro user with cloud enabled.
    // Conservative: only stop if we have a session + pro + cloud enabled.
    let cloud_healthy = settings.session_token.is_some()
        && settings.pro
        && settings.cloud_enabled;

    let should_run = !cloud_healthy;
    let currently_running = store.is_server_running();

    match (should_run, currently_running) {
        (true, false) => {
            let port = settings.port;
            let tx = webhook::start_server(app.clone(), port);
            handle.set(tx);
            eprintln!("[webhook] started on port {port}");
        }
        (false, true) => {
            handle.stop();
            eprintln!("[webhook] stopped — cloud Pro active");
        }
        _ => {}
    }
}

// ── Server status (mirrors the original ServerStatus shape) ───────────
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    running: bool,
    port: u16,
    endpoints: Vec<String>,
}

fn server_status(running: bool, port: u16) -> ServerStatus {
    ServerStatus {
        running,
        port,
        endpoints: vec![format!("http://localhost:{port}/webhook")],
    }
}

// ── Tauri commands (the IPC surface the UI calls) ─────────────────────
#[tauri::command]
fn get_settings(store: tauri::State<Arc<Store>>) -> Settings {
    store.get_settings()
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    store: tauri::State<Arc<Store>>,
    patch: SettingsPatch,
) -> Settings {
    let updated = store.set_settings(patch);
    let _ = app.emit("settings:changed", &updated);
    refresh_tray(&app);
    updated
}

#[tauri::command]
fn list_alerts(store: tauri::State<Arc<Store>>) -> Vec<Alert> {
    store.list_alerts()
}

#[tauri::command]
fn mark_all_read(app: AppHandle, store: tauri::State<Arc<Store>>) -> Vec<Alert> {
    let alerts = store.mark_all_read();
    let _ = app.emit("alerts:changed", serde_json::json!({ "unreadCount": 0 }));
    refresh_tray(&app);
    alerts
}

#[tauri::command]
fn delete_alert(app: AppHandle, store: tauri::State<Arc<Store>>, id: String) -> Vec<Alert> {
    let alerts = store.delete_alert(&id);
    let unread = store.unread_count();
    let _ = app.emit("alerts:changed", serde_json::json!({ "unreadCount": unread }));
    refresh_tray(&app);
    alerts
}

#[tauri::command]
fn clear_alerts(app: AppHandle, store: tauri::State<Arc<Store>>) -> Vec<Alert> {
    let alerts = store.clear_alerts();
    let _ = app.emit("alerts:changed", serde_json::json!({ "unreadCount": 0 }));
    refresh_tray(&app);
    alerts
}

#[tauri::command]
fn get_server_status(store: tauri::State<Arc<Store>>) -> ServerStatus {
    server_status(store.is_server_running(), store.get_settings().port)
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn play_sound(name: String) {
    webhook::play_sound(&name);
}

/// Check for updates and emit an event with the result.
/// Called from both the tray menu and the `check_for_updates` command.
async fn run_update_check(app: &AppHandle) {
    let _ = app.emit("update:checking", ());
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let _ = app.emit("update:available", serde_json::json!({
                    "version": update.version,
                    "currentVersion": update.current_version,
                    "body": update.body,
                }));
            }
            Ok(None) => {
                let _ = app.emit("update:not-available", ());
            }
            Err(e) => {
                let _ = app.emit("update:error", e.to_string());
            }
        },
        Err(e) => {
            let _ = app.emit("update:error", e.to_string());
        }
    }
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) {
    run_update_check(&app).await;
}

#[tauri::command]
async fn install_update(app: AppHandle) {
    let _ = app.emit("update:installing", ());
    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = updater.check().await {
            let _ = update.download_and_install(|_, _| {}, || {}).await;
        }
    }
}

// ── Relay / auth / billing commands ───────────────────────────────────
#[tauri::command]
fn relay_get_status(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
) -> RelayStatus {
    rt.0.block_on(relay.get_relay_status())
}

#[tauri::command]
fn auth_get_status(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
) -> AuthStatus {
    rt.0.block_on(relay.get_auth_status())
}

#[tauri::command]
fn relay_set_enabled(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
    enabled: bool,
) -> RelayStatus {
    let relay = relay.inner().clone();
    rt.0.block_on(async move { relay.set_enabled(enabled).await })
}

#[tauri::command]
fn relay_set_base_url(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
    url: String,
) -> RelayStatus {
    let relay = relay.inner().clone();
    rt.0.block_on(async move { relay.set_base_url(url).await })
}

#[tauri::command]
fn auth_request_link(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
    email: String,
) -> Result<(), String> {
    let relay = relay.inner().clone();
    rt.0.block_on(async move { relay.request_link(email).await })
}

#[tauri::command]
fn auth_cancel(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
) -> AuthStatus {
    rt.0.block_on(async {
        relay.cancel().await;
        relay.get_auth_status().await
    })
}

#[tauri::command]
fn auth_sign_out(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
) -> AuthStatus {
    rt.0.block_on(async {
        relay.sign_out().await;
        relay.get_auth_status().await
    })
}

#[tauri::command]
fn billing_open_checkout(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
    plan: String,
) -> Result<(), String> {
    let plan = if plan == "yearly" { "yearly" } else { "monthly" };
    rt.0.block_on(relay.open_checkout(plan))
}

#[tauri::command]
fn billing_open_portal(
    rt: tauri::State<Runtime>,
    relay: tauri::State<Arc<RelayClient>>,
) -> Result<(), String> {
    rt.0.block_on(relay.open_portal())
}

// ── Tray icon helpers ─────────────────────────────────────────────────
// ── Tray icon images embedded at compile time ─────────────────────────
// include_bytes! guarantees correct path in both dev and release bundle.
static TRAY_ICON: &[u8] = include_bytes!("../icons/tray-icon.png");
static TRAY_ICON_BADGE: &[u8] = include_bytes!("../icons/tray-icon-badge.png");

fn load_tray_icon(_app: &AppHandle, name: &str) -> Option<tauri::image::Image<'static>> {
    let bytes: &'static [u8] = match name {
        "tray-icon-badge.png" => TRAY_ICON_BADGE,
        _ => TRAY_ICON,
    };
    tauri::image::Image::from_bytes(bytes).ok()
}


pub fn refresh_tray(app: &AppHandle) {
    let store = app.state::<Arc<Store>>();
    let settings = store.get_settings();
    let unread = store.unread_count();
    let has_unread = settings.badge && unread > 0;

    if let Some(tray) = app.tray_by_id("main") {
        let icon_name = if has_unread { "tray-icon-badge.png" } else { "tray-icon.png" };
        if let Some(icon) = load_tray_icon(app, icon_name) {
            let _ = tray.set_icon(Some(icon));
        }
        let title = if has_unread { unread.to_string() } else { String::new() };
        let _ = tray.set_title(Some(title));
    }
}

// ── Popover show/hide ─────────────────────────────────────────────────
fn toggle_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("popover") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.move_window(Position::TrayCenter);
            let _ = win.show();
            let _ = win.set_focus();
            // Mark all alerts read when the user opens the popover.
            let store = app.state::<Arc<Store>>();
            store.mark_all_read();
            let _ = app.emit("alerts:changed", serde_json::json!({ "unreadCount": 0 }));
            refresh_tray(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let quit = MenuItem::with_id(app, "quit", "Quit TradingView Alerts", true, None::<&str>)?;
    let settings_item =
        MenuItem::with_id(app, "settings", "Settings…", true, Some("Cmd+,"))?;
    let check_updates_item =
        MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings_item, &check_updates_item, &quit])?;

    // SF Symbol "bell" rendered at 44px via Swift — white, no template flag.
    let tray_icon = tauri::image::Image::from_bytes(TRAY_ICON)
        .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

    TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => {
                toggle_popover(app);
                let _ = app.emit("navigate", "settings");
            }
            "check_updates" => {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    run_update_check(&app2).await;
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popover(tray.app_handle());
            }
        })
        .build(app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            list_alerts,
            mark_all_read,
            delete_alert,
            clear_alerts,
            get_server_status,
            open_url,
            quit,
            play_sound,
            check_for_updates,
            install_update,
            relay_get_status,
            auth_get_status,
            relay_set_enabled,
            relay_set_base_url,
            auth_request_link,
            auth_cancel,
            auth_sign_out,
            billing_open_checkout,
            billing_open_portal,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Persistent store in the OS app-data dir.
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("tvalert"));
            let store = Arc::new(Store::load(data_dir));
            app.manage(store.clone());

            // Shared tokio runtime + relay client (cloud path).
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime");
            let relay = Arc::new(RelayClient::new(handle.clone(), store.clone()));
            {
                let relay = relay.clone();
                rt.block_on(async move { relay.init().await });
            }
            app.manage(Runtime(rt));
            app.manage(relay);
            app.manage(WebhookHandle::new());

            // Menu-bar-only: no Dock icon, no app menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Native macOS vibrancy on the (transparent) popover window.
            #[cfg(target_os = "macos")]
            if let Some(popover) = app.get_webview_window("popover") {
                apply_vibrancy(
                    &popover,
                    NSVisualEffectMaterial::Popover,
                    Some(NSVisualEffectState::Active),
                    Some(12.0),
                )
                .expect("failed to apply vibrancy to popover window");
            }

            let _tray = build_tray(&handle)?;
            refresh_tray(&handle);

            // Start local webhook server (unless cloud Pro is already active).
            sync_webhook_server(&handle);

            // Re-evaluate webhook whenever relay or auth state changes.
            let h1 = handle.clone();
            handle.listen_any("relay:status-changed", move |_| { sync_webhook_server(&h1); });
            let h2 = handle.clone();
            handle.listen_any("auth:changed", move |_| { sync_webhook_server(&h2); });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Dismiss the popover on focus loss — click anywhere outside closes it.
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "popover" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
