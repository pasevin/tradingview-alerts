// Cloud relay client: magic-link sign-in (poll-based), an account-bound webhook
// token, billing (checkout/portal), and a reconnecting WebSocket to the relay.
// Ports relay-client.ts. Talks to this repo's relay contract (apps/relay):
//   /health {requiresAuth}, /auth/request {pollToken}, /auth/poll {status:"ready"|...},
//   /register {token}, /me {email,pro,hookUrl}, /billing/checkout, /billing/portal,
//   WS /ws?token=…  frames: welcome | alert | entitlement | limit
use crate::store::Store;
use crate::webhook::{dispatch_alert, dispatch_parsed_alert};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_RECONNECT: u64 = 30_000;

fn trim_slash(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

fn to_ws_url(base: &str, token: &str) -> String {
    let b = trim_slash(base);
    let ws = if let Some(rest) = b.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = b.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        b
    };
    format!("{ws}/ws?token={}", urlencode(token))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub enabled: bool,
    pub connected: bool,
    pub relay_base_url: String,
    pub token: Option<String>,
    pub hook_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub pro: bool,
    pub portal_url: Option<String>,
    pub hook_url: Option<String>,
    pub pending: bool,
    pub pending_email: Option<String>,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
struct RelayState {
    base_url: String,
    enabled: bool,
    connected: bool,
    session_token: Option<String>,
    email: Option<String>,
    pro: bool,
    portal_url: Option<String>,
    token: Option<String>, // account-bound webhook token
    auth_required: bool,
    poll_token: Option<String>,
    pending_email: Option<String>,
    last_error: Option<String>,
    // generation counter — bumping it tells the live WS/poll loops to stop.
    generation: u64,
}

pub struct RelayClient {
    app: AppHandle,
    store: Arc<Store>,
    http: reqwest::Client,
    state: Mutex<RelayState>,
}

impl RelayClient {
    pub fn new(app: AppHandle, store: Arc<Store>) -> Self {
        let s = store.get_settings();
        RelayClient {
            app,
            store,
            http: reqwest::Client::new(),
            state: Mutex::new(RelayState {
                base_url: trim_slash(&s.relay_base_url),
                enabled: s.cloud_enabled,
                session_token: s.session_token.clone(),
                email: s.account_email.clone(),
                pro: s.pro,
                token: s.relay_token.clone(),
                auth_required: true,
                ..Default::default()
            }),
        }
    }

    // ── Status snapshots + emit ───────────────────────────────────────
    async fn relay_status(&self) -> RelayStatus {
        let s = self.state.lock().await;
        let hook = s
            .token
            .as_ref()
            .map(|t| format!("{}/hook/{}", trim_slash(&s.base_url), t));
        RelayStatus {
            enabled: s.enabled,
            connected: s.connected,
            relay_base_url: s.base_url.clone(),
            token: s.token.clone(),
            hook_url: hook,
            error: s.last_error.clone(),
        }
    }

    async fn auth_status(&self) -> AuthStatus {
        let s = self.state.lock().await;
        let hook = s
            .token
            .as_ref()
            .map(|t| format!("{}/hook/{}", trim_slash(&s.base_url), t));
        AuthStatus {
            signed_in: s.session_token.is_some(),
            email: s.email.clone(),
            pro: s.pro,
            portal_url: s.portal_url.clone(),
            hook_url: hook,
            pending: s.poll_token.is_some(),
            pending_email: s.pending_email.clone(),
            auth_required: s.auth_required,
            error: s.last_error.clone(),
        }
    }

    async fn emit_status(&self) {
        let _ = self.app.emit("relay:status-changed", self.relay_status().await);
    }
    async fn emit_auth(&self) {
        let _ = self.app.emit("auth:changed", self.auth_status().await);
    }

    pub async fn get_relay_status(&self) -> RelayStatus {
        self.relay_status().await
    }
    pub async fn get_auth_status(&self) -> AuthStatus {
        self.auth_status().await
    }

    // ── Health probe (detect self-host no-auth relays) ────────────────
    async fn probe_health(&self) {
        let base = self.state.lock().await.base_url.clone();
        if let Ok(res) = self.http.get(format!("{base}/health")).send().await {
            if res.status().is_success() {
                if let Ok(v) = res.json::<serde_json::Value>().await {
                    let requires = v.get("requiresAuth").and_then(|x| x.as_bool());
                    if let Some(req) = requires {
                        self.state.lock().await.auth_required = req;
                    }
                }
            }
        }
        self.emit_auth().await;
    }

    // ── Magic-link sign-in ────────────────────────────────────────────
    pub async fn request_link(self: &Arc<Self>, email: String) -> Result<(), String> {
        self.cancel().await;
        let base = self.state.lock().await.base_url.clone();
        let res = self
            .http
            .post(format!("{base}/auth/request"))
            .json(&serde_json::json!({ "email": email }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let code = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Sign-in request failed (HTTP {code}). {text}"));
        }
        let data = res
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string())?;
        let poll = data
            .get("pollToken")
            .and_then(|x| x.as_str())
            .ok_or("Relay did not return a poll token")?
            .to_string();
        {
            let mut s = self.state.lock().await;
            s.poll_token = Some(poll);
            s.pending_email = Some(email.trim().to_string());
            s.last_error = None;
        }
        self.emit_auth().await;
        self.spawn_poll();
        Ok(())
    }

    fn spawn_poll(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(POLL_INTERVAL).await;
                let poll_token = {
                    let s = this.state.lock().await;
                    match &s.poll_token {
                        Some(t) => t.clone(),
                        None => return, // cancelled / completed
                    }
                };
                let base = this.state.lock().await.base_url.clone();
                let res = this
                    .http
                    .post(format!("{base}/auth/poll"))
                    .json(&serde_json::json!({ "pollToken": poll_token }))
                    .send()
                    .await;
                let res = match res {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[relay:poll] request error: {e}");
                        continue;
                    }
                };
                let http_status = res.status();
                let body = res.text().await.unwrap_or_default();
                eprintln!("[relay:poll] http={http_status} body={body}");
                let data: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[relay:poll] json parse error: {e}");
                        continue;
                    }
                };
                let status = data.get("status").and_then(|x| x.as_str()).unwrap_or("");
                match status {
                    // "ok" = original/production relay; "ready" = this repo's relay.
                    "ok" | "ready" => {
                        let session = data
                            .get("sessionToken")
                            .and_then(|x| x.as_str())
                            .map(String::from);
                        let email = data.get("email").and_then(|x| x.as_str()).map(String::from);
                        let pro = data.get("pro").and_then(|x| x.as_bool()).unwrap_or(false);
                        {
                            let mut s = this.state.lock().await;
                            s.poll_token = None;
                            s.pending_email = None;
                            s.session_token = session.clone();
                            s.email = email.clone();
                            s.pro = pro;
                        }
                        this.store.set_account(session, email, pro);
                        this.emit_auth().await;
                        this.start().await;
                        return;
                    }
                    "expired" | "not_found" | "unknown" => {
                        let mut s = this.state.lock().await;
                        s.last_error = Some("Sign-in link expired. Please try again.".into());
                        s.poll_token = None;
                        s.pending_email = None;
                        drop(s);
                        this.emit_auth().await;
                        return;
                    }
                    _ => { /* pending — keep polling */ }
                }
            }
        });
    }

    pub async fn cancel(&self) {
        {
            let mut s = self.state.lock().await;
            s.poll_token = None;
            s.pending_email = None;
        }
        self.emit_auth().await;
    }

    pub async fn sign_out(&self) {
        let (session, base) = {
            let s = self.state.lock().await;
            (s.session_token.clone(), s.base_url.clone())
        };
        self.stop().await;
        if let Some(session) = session {
            let _ = self
                .http
                .post(format!("{base}/auth/signout"))
                .bearer_auth(session)
                .send()
                .await;
        }
        {
            let mut s = self.state.lock().await;
            s.session_token = None;
            s.email = None;
            s.pro = false;
            s.portal_url = None;
            s.token = None;
            s.poll_token = None;
            s.pending_email = None;
        }
        self.store.set_account(None, None, false);
        self.store.set_relay_token(None);
        self.emit_auth().await;
        self.emit_status().await;
    }

    // ── Billing ───────────────────────────────────────────────────────
    pub async fn open_checkout(&self, plan: &str) -> Result<(), String> {
        let (session, base) = {
            let s = self.state.lock().await;
            (s.session_token.clone(), s.base_url.clone())
        };
        let session = session.ok_or("Sign in required")?;
        let res = self
            .http
            .get(format!("{base}/billing/checkout?plan={plan}"))
            .bearer_auth(session)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Checkout unavailable (HTTP {})", res.status()));
        }
        let data = res
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string())?;
        let url = data
            .get("url")
            .and_then(|x| x.as_str())
            .ok_or("No checkout URL returned")?;
        self.open_external(url);
        Ok(())
    }

    pub async fn open_portal(&self) -> Result<(), String> {
        let (session, base) = {
            let s = self.state.lock().await;
            (s.session_token.clone(), s.base_url.clone())
        };
        let session = session.ok_or("Sign in required")?;
        let res = self
            .http
            .get(format!("{base}/billing/portal"))
            .bearer_auth(session)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Manage subscription unavailable (HTTP {})", res.status()));
        }
        let data = res
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string())?;
        let url = data
            .get("url")
            .and_then(|x| x.as_str())
            .ok_or("No portal URL returned")?;
        self.open_external(url);
        Ok(())
    }

    fn open_external(&self, url: &str) {
        use tauri_plugin_opener::OpenerExt;
        let _ = self.app.opener().open_url(url.to_string(), None::<&str>);
    }

    // ── Account refresh (/me) ─────────────────────────────────────────
    async fn fetch_account(&self) {
        let (session, base) = {
            let s = self.state.lock().await;
            (s.session_token.clone(), s.base_url.clone())
        };
        let Some(session) = session else { return };
        if let Ok(res) = self
            .http
            .get(format!("{base}/me"))
            .bearer_auth(session)
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(v) = res.json::<serde_json::Value>().await {
                    let mut s = self.state.lock().await;
                    let mut changed = false;
                    if let Some(pro) = v.get("pro").and_then(|x| x.as_bool()) {
                        if pro != s.pro {
                            s.pro = pro;
                            self.store.set_pro(pro);
                            changed = true;
                        }
                    }
                    // Production relay includes portalUrl in /me response.
                    if let Some(url) = v.get("portalUrl").and_then(|x| x.as_str()) {
                        s.portal_url = Some(url.to_string());
                        changed = true;
                    }
                    drop(s);
                    if changed {
                        self.emit_auth().await;
                    }
                }
            }
        }
    }

    // ── Webhook token + WebSocket ─────────────────────────────────────
    async fn ensure_token(&self) -> Result<String, String> {
        {
            let s = self.state.lock().await;
            if let Some(t) = &s.token {
                return Ok(t.clone());
            }
        }
        let (session, base, auth_required) = {
            let s = self.state.lock().await;
            (s.session_token.clone(), s.base_url.clone(), s.auth_required)
        };
        let mut req = self.http.post(format!("{base}/register"));
        if auth_required {
            let session = session.ok_or("Not signed in")?;
            req = req.bearer_auth(session);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        if res.status().as_u16() == 401 && auth_required {
            self.sign_out().await;
            return Err("Session expired".into());
        }
        if !res.status().is_success() {
            return Err(format!("register failed: HTTP {}", res.status()));
        }
        let data = res
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string())?;
        let token = data
            .get("token")
            .and_then(|x| x.as_str())
            .ok_or("register returned no token")?
            .to_string();
        self.state.lock().await.token = Some(token.clone());
        self.store.set_relay_token(Some(token.clone()));
        Ok(token)
    }

    fn can_connect(s: &RelayState) -> bool {
        if s.auth_required {
            s.session_token.is_some()
        } else {
            true
        }
    }

    pub async fn start(self: &Arc<Self>) {
        let my_gen = {
            let mut s = self.state.lock().await;
            s.enabled = true;
            s.generation += 1; // invalidate any prior loop
            s.generation
        };
        self.probe_health().await;
        let ok = { Self::can_connect(&*self.state.lock().await) };
        if !ok {
            self.emit_status().await;
            return;
        }
        self.spawn_ws(my_gen);
    }

    fn spawn_ws(self: &Arc<Self>, my_gen: u64) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut delay = 1000u64;
            loop {
                {
                    let s = this.state.lock().await;
                    if s.generation != my_gen || !s.enabled || !Self::can_connect(&s) {
                        return;
                    }
                }
                let token = match this.ensure_token().await {
                    Ok(t) => t,
                    Err(e) => {
                        this.state.lock().await.last_error = Some(e);
                        this.emit_status().await;
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        delay = (delay * 2).min(MAX_RECONNECT);
                        continue;
                    }
                };
                let base = this.state.lock().await.base_url.clone();
                let url = to_ws_url(&base, &token);
                match tokio_tungstenite::connect_async(&url).await {
                    Ok((mut ws, _)) => {
                        {
                            let mut s = this.state.lock().await;
                            s.connected = true;
                            s.last_error = None;
                        }
                        delay = 1000;
                        this.emit_status().await;
                        let auth_required =
                            { this.state.lock().await.auth_required };
                        if auth_required {
                            this.fetch_account().await;
                        }
                        // Heartbeat: send a Ping every 30s; if no frame
                        // (including Pong) arrives within 90s, the connection
                        // is treated as dead and we reconnect.
                        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
                        heartbeat.tick().await; // skip immediate first tick
                        let mut last_msg = tokio::time::Instant::now();
                        loop {
                            tokio::select! {
                                msg = ws.next() => match msg {
                                    Some(Ok(Message::Text(txt))) => {
                                        last_msg = tokio::time::Instant::now();
                                        this.handle_frame(&txt).await;
                                    }
                                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                                        last_msg = tokio::time::Instant::now();
                                    }
                                    Some(Ok(Message::Binary(_))) => {
                                        last_msg = tokio::time::Instant::now();
                                    }
                                    Some(Ok(Message::Frame(_))) => {
                                        last_msg = tokio::time::Instant::now();
                                    }
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                },
                                _ = heartbeat.tick() => {
                                    if last_msg.elapsed() > Duration::from_secs(90) {
                                        eprintln!("[relay:ws] heartbeat timeout — reconnecting");
                                        break;
                                    }
                                    let _ = ws.send(Message::Ping(Vec::new())).await;
                                }
                            }
                            if this.state.lock().await.generation != my_gen {
                                let _ = ws.close(None).await;
                                return;
                            }
                        }
                        this.state.lock().await.connected = false;
                        this.emit_status().await;
                    }
                    Err(e) => {
                        let mut s = this.state.lock().await;
                        s.connected = false;
                        s.last_error = Some(e.to_string());
                        drop(s);
                        this.emit_status().await;
                    }
                }
                // reconnect with backoff unless invalidated
                {
                    let s = this.state.lock().await;
                    if s.generation != my_gen || !s.enabled || !Self::can_connect(&s) {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(delay)).await;
                delay = (delay * 2).min(MAX_RECONNECT);
            }
        });
    }

    async fn handle_frame(&self, text: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ty {
            "welcome" | "entitlement" => {
                if let Some(pro) = v.get("pro").and_then(|x| x.as_bool()) {
                    let changed = {
                        let mut s = self.state.lock().await;
                        let c = s.pro != pro;
                        s.pro = pro;
                        // Capture portalUrl from entitlement frame (production relay sends it).
                        if let Some(url) = v.get("portalUrl").and_then(|x| x.as_str()) {
                            s.portal_url = Some(url.to_string());
                        }
                        c
                    };
                    if changed {
                        self.store.set_pro(pro);
                        self.emit_auth().await;
                    }
                }
            }
            "alert" => {
                // Prefer the nested alert object (new protocol) which carries
                // relay-parsed fields (symbol, message, raw). Fall back to
                // top-level raw (legacy relay) for backward compatibility.
                if let Some(alert_obj) = v.get("alert").and_then(|x| x.as_object()) {
                    let raw = alert_obj.get("raw").and_then(|x| x.as_str()).unwrap_or("");
                    let message = alert_obj.get("message").and_then(|x| x.as_str());
                    let symbol = alert_obj.get("symbol").and_then(|x| x.as_str());
                    dispatch_parsed_alert(&self.app, raw, "cloud", message, symbol);
                } else if let Some(raw) = v.get("raw").and_then(|x| x.as_str()) {
                    dispatch_alert(&self.app, raw, "cloud");
                }
            }
            "limit" => {
                // surfaced as a notification by dispatch path; emit for UI too
                if let Some(msg) = v.get("message").and_then(|x| x.as_str()) {
                    let _ = self
                        .app
                        .emit("relay:limit", serde_json::json!({ "message": msg }));
                }
            }
            _ => {}
        }
    }

    pub async fn stop(&self) {
        let mut s = self.state.lock().await;
        s.generation += 1; // invalidate live loops
        s.connected = false;
        drop(s);
        self.emit_status().await;
    }

    pub async fn set_enabled(self: &Arc<Self>, enabled: bool) -> RelayStatus {
        self.store.set_settings(crate::store::SettingsPatch {
            cloud_enabled: Some(enabled),
            ..Default::default()
        });
        self.state.lock().await.enabled = enabled;
        if enabled {
            self.start().await;
        } else {
            self.stop().await;
        }
        self.relay_status().await
    }

    pub async fn set_base_url(self: &Arc<Self>, url: String) -> RelayStatus {
        self.stop().await;
        {
            let mut s = self.state.lock().await;
            s.base_url = trim_slash(&url);
            s.token = None;
        }
        self.store.set_settings(crate::store::SettingsPatch {
            relay_base_url: Some(trim_slash(&url)),
            ..Default::default()
        });
        self.store.set_relay_token(None);
        let enabled = { self.state.lock().await.enabled };
        if enabled {
            self.start().await;
        }
        self.emit_status().await;
        self.relay_status().await
    }

    /// Called once at startup.
    pub async fn init(self: &Arc<Self>) {
        let enabled = { self.state.lock().await.enabled };
        self.emit_auth().await;
        if enabled {
            self.start().await;
        } else {
            self.emit_status().await;
        }
    }
}
