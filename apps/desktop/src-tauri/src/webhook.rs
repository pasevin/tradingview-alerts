// Alert parsing + dispatch pipeline and the local webhook HTTP server.
// Ports alert-dispatch.ts + webhook-server.ts from the original Electron app.
use crate::store::{Alert, Store};
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Best-effort extraction of a TradingView symbol from arbitrary alert text.
pub fn extract_symbol(text: &str) -> Option<String> {
    let t = text.trim();
    // EXCHANGE:SYMBOL (e.g. BINANCE:BTCUSDT, NASDAQ:AAPL)
    if let Some(m) = regex_lite_exchange(t) {
        return Some(m);
    }
    // crypto/FX pair (e.g. BTCUSDT, EURUSD)
    if let Some(m) = regex_lite_pair(t) {
        return Some(m);
    }
    // single ticker token
    if is_single_ticker(t) {
        return Some(t.to_string());
    }
    None
}

// Lightweight hand-rolled matchers (avoid pulling a regex crate).
fn regex_lite_exchange(t: &str) -> Option<String> {
    for token in t.split(|c: char| c.is_whitespace() || c == ',' || c == ';') {
        if let Some(colon) = token.find(':') {
            let (ex, sym) = token.split_at(colon);
            let sym = &sym[1..];
            let ex_ok = (2..=8).contains(&ex.len()) && ex.chars().all(|c| c.is_ascii_uppercase());
            let sym_ok = (1..=15).contains(&sym.len())
                && sym
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '!');
            if ex_ok && sym_ok {
                return Some(format!("{ex}:{sym}"));
            }
        }
    }
    None
}

fn regex_lite_pair(t: &str) -> Option<String> {
    const QUOTES: [&str; 9] = ["USDT", "USDC", "BUSD", "USD", "PERP", "BTC", "ETH", "EUR", "GBP"];
    for token in t.split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit())) {
        if (4..=12).contains(&token.len()) && token.chars().all(|c| c.is_ascii_uppercase()) {
            for q in QUOTES {
                if token.ends_with(q) && token.len() > q.len() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn is_single_ticker(t: &str) -> bool {
    let len = t.len();
    if !(2..=12).contains(&len) {
        return false;
    }
    let mut chars = t.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_uppercase() {
        return false;
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.')
}

pub struct ParsedAlert {
    pub ticker: Option<String>,
    pub message: String,
    pub price: Option<String>,
}

/// Parse a raw webhook body into structured fields (JSON or plain text).
pub fn parse_alert(raw: &str) -> ParsedAlert {
    let trimmed = raw.trim();
    let mut ticker: Option<String> = None;
    let mut message = trimmed.to_string();
    let mut price: Option<String> = None;

    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(obj) = v.as_object() {
            if let Some(t) = obj.get("ticker").and_then(|x| x.as_str()) {
                ticker = Some(t.to_string());
            } else if let Some(t) = obj.get("symbol").and_then(|x| x.as_str()) {
                ticker = Some(t.to_string());
            }
            if let Some(m) = obj.get("message").and_then(|x| x.as_str()) {
                message = m.to_string();
            } else if let Some(m) = obj.get("text").and_then(|x| x.as_str()) {
                message = m.to_string();
            }
            if let Some(p) = obj.get("price").and_then(|x| x.as_str()) {
                price = Some(p.to_string());
            } else if let Some(p) = obj.get("price").and_then(|x| x.as_f64()) {
                price = Some(format_price(p));
            }
        }
    }

    if ticker.is_none() {
        ticker = extract_symbol(&message);
    }

    ParsedAlert {
        ticker,
        message,
        price,
    }
}

fn format_price(p: f64) -> String {
    if p.fract() == 0.0 {
        format!("{}", p as i64)
    } else {
        // strip trailing zeros
        let s = format!("{p}");
        s
    }
}

/// Full pipeline: parse, store, notify, beep, emit to UI, refresh tray.
pub fn dispatch_alert(app: &AppHandle, raw: &str, source: &str) {
    let parsed = parse_alert(raw);
    dispatch_parsed_alert(app, raw, source, Some(&parsed.message), parsed.ticker.as_deref());
}

/// Dispatch an alert where the relay has already parsed the message and symbol.
/// Skips local re-parsing so the relay's formatting is preserved.
pub fn dispatch_parsed_alert(
    app: &AppHandle,
    raw: &str,
    source: &str,
    message: Option<&str>,
    symbol: Option<&str>,
) {
    let store = app.state::<Arc<Store>>();
    let settings = store.get_settings();

    // If the relay provided message/symbol, use them directly.
    // Otherwise fall back to local parsing of the raw body.
    let (ticker, display_message) = if message.is_some() || symbol.is_some() {
        let ticker = symbol.map(|s| s.to_string());
        let msg = message.unwrap_or(raw.trim()).to_string();
        // Try to extract ticker from message if not provided
        let ticker = ticker.or_else(|| extract_symbol(&msg));
        (ticker, msg)
    } else {
        let parsed = parse_alert(raw);
        (parsed.ticker, parsed.message)
    };

    let alert = Alert {
        id: uuid::Uuid::new_v4().to_string(),
        received_at: now_ms(),
        ticker: ticker.clone(),
        message: display_message.clone(),
        price: None,
        raw: raw.trim().to_string(),
        read: false,
    };

    println!(
        "[alert:received] source={source} id={} ticker={:?}",
        alert.id, alert.ticker
    );

    store.add_alert(alert.clone());
    let unread = store.unread_count();

    if settings.notifications {
        let title = match &ticker {
            Some(t) => format!("Alert: {t}"),
            None => "TradingView Alert".to_string(),
        };
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(&display_message)
            .show();
    }

    if settings.sound {
        play_sound(&settings.alert_sound);
    }

    // Emit to any open windows (popover / settings) so the list updates live.
    let _ = app.emit("alerts:new", serde_json::json!({ "alert": alert, "unreadCount": unread }));

    // Refresh the tray badge.
    crate::refresh_tray(app);
}

/// Play a named macOS system sound. Called from dispatch and from the test command.
pub fn play_sound(name: &str) {
    // Sanitize: only allow known sound names to prevent path injection.
    const VALID: &[&str] = &[
        "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass",
        "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi",
        "Submarine", "Tink",
    ];
    let sound = if VALID.contains(&name) { name } else { "Glass" };
    let path = format!("/System/Library/Sounds/{sound}.aiff");
    std::thread::spawn(move || {
        let _ = std::process::Command::new("afplay").arg(path).spawn();
    });
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Local webhook HTTP server (axum on a tokio runtime) ───────────────
#[derive(Clone)]
struct WebhookState {
    app: AppHandle,
}

async fn handle_webhook(State(state): State<WebhookState>, body: String) -> impl IntoResponse {
    const MAX: usize = 64 * 1024;
    if body.len() > MAX {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(serde_json::json!({ "ok": false, "error": "Payload too large" })));
    }
    dispatch_alert(&state.app, &body, "local");
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

/// Spawn the webhook server on its own tokio runtime in a background thread.
/// Returns a sender that can be dropped/sent to shut the server down gracefully.
pub fn start_server(app: AppHandle, port: u16) -> tokio::sync::oneshot::Sender<()> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[webhook] runtime build failed: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let state = WebhookState { app: app.clone() };
            let router = Router::new()
                .route("/webhook", post(handle_webhook))
                .route("/", post(handle_webhook))
                .route("/health", get(handle_health))
                .with_state(state);

            let addr = format!("0.0.0.0:{port}");
            match tokio::net::TcpListener::bind(&addr).await {
                Ok(listener) => {
                    println!("[server:start] port={port}");
                    app.state::<Arc<crate::store::Store>>().set_server_running(true);
                    let _ = app.emit("server:status-changed", serde_json::json!({ "running": true, "port": port }));
                    let serve = axum::serve(listener, router);
                    tokio::select! {
                        res = serve => {
                            if let Err(e) = res {
                                eprintln!("[webhook] serve error: {e}");
                            }
                        }
                        _ = rx => {
                            println!("[server:stop] port={port} (shutdown signal)");
                        }
                    }
                    app.state::<Arc<crate::store::Store>>().set_server_running(false);
                    let _ = app.emit("server:status-changed", serde_json::json!({ "running": false, "port": port }));
                }
                Err(e) => {
                    eprintln!("[webhook] bind failed on {addr}: {e}");
                    app.state::<Arc<crate::store::Store>>().set_server_running(false);
                    let _ = app.emit("server:status-changed", serde_json::json!({ "running": false, "port": port, "error": e.to_string() }));
                }
            }
        });
    });
    tx
}
