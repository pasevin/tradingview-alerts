// Persistent settings + alert storage, JSON-backed in the app data dir.
// Ports the original Electron settings-store.ts / alert-store.ts behaviour.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_ALERTS: usize = 200;

// ── Settings ──────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub port: u16,
    pub notifications: bool,
    pub sound: bool,
    pub badge: bool,
    pub relay_base_url: String,
    pub relay_token: Option<String>,
    pub cloud_enabled: bool,
    // Account (magic-link auth)
    pub session_token: Option<String>,
    pub account_email: Option<String>,
    pub pro: bool,
    // Alert sound
    pub alert_sound: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            port: 8765,
            notifications: true,
            sound: true,
            badge: true,
            relay_base_url: "https://alert-watcher-relay.fly.dev".to_string(),
            relay_token: None,
            cloud_enabled: false,
            session_token: None,
            account_email: None,
            pro: false,
            alert_sound: "Glass".to_string(),
        }
    }
}

/// Partial update payload from the frontend. Every field optional.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub port: Option<u16>,
    pub notifications: Option<bool>,
    pub sound: Option<bool>,
    pub badge: Option<bool>,
    pub relay_base_url: Option<String>,
    pub cloud_enabled: Option<bool>,
    pub alert_sound: Option<String>,
}

// ── Alert ─────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: String,
    pub received_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticker: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<String>,
    pub raw: String,
    pub read: bool,
}

// ── Store ─────────────────────────────────────────────────────────────
pub struct Store {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    alerts: Mutex<Vec<Alert>>,
    server_running: std::sync::atomic::AtomicBool,
}

impl Store {
    /// Load (or initialize) settings + alerts from `data_dir`.
    pub fn load(data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);

        let mut settings = std::fs::read_to_string(data_dir.join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();

        // One-time migration: upgrade the old dead default relay to the live one.
        if settings.relay_base_url == "https://tvalert-relay.fly.dev" {
            settings.relay_base_url = Settings::default().relay_base_url;
        }

        let alerts = std::fs::read_to_string(data_dir.join("alerts.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Alert>>(&s).ok())
            .unwrap_or_default();

        Store {
            data_dir,
            settings: Mutex::new(settings),
            alerts: Mutex::new(alerts),
            server_running: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn set_server_running(&self, running: bool) {
        self.server_running
            .store(running, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn is_server_running(&self) -> bool {
        self.server_running
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn persist_settings(&self, s: &Settings) {
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(self.data_dir.join("settings.json"), json);
        }
    }

    fn persist_alerts(&self, a: &[Alert]) {
        if let Ok(json) = serde_json::to_string_pretty(a) {
            let _ = std::fs::write(self.data_dir.join("alerts.json"), json);
        }
    }

    // ── Settings API ──────────────────────────────────────────────────
    pub fn get_settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, patch: SettingsPatch) -> Settings {
        let mut s = self.settings.lock().unwrap();
        if let Some(v) = patch.port {
            s.port = v;
        }
        if let Some(v) = patch.notifications {
            s.notifications = v;
        }
        if let Some(v) = patch.sound {
            s.sound = v;
        }
        if let Some(v) = patch.badge {
            s.badge = v;
        }
        if let Some(v) = patch.relay_base_url {
            s.relay_base_url = v;
        }
        if let Some(v) = patch.cloud_enabled {
            s.cloud_enabled = v;
        }
        if let Some(v) = patch.alert_sound {
            s.alert_sound = v;
        }
        self.persist_settings(&s);
        s.clone()
    }

    /// Direct account-field writes (used by the relay client, not the UI patch).
    pub fn set_account(
        &self,
        session_token: Option<String>,
        account_email: Option<String>,
        pro: bool,
    ) -> Settings {
        let mut s = self.settings.lock().unwrap();
        s.session_token = session_token;
        s.account_email = account_email;
        s.pro = pro;
        self.persist_settings(&s);
        s.clone()
    }

    pub fn set_relay_token(&self, token: Option<String>) {
        let mut s = self.settings.lock().unwrap();
        s.relay_token = token;
        self.persist_settings(&s);
    }

    pub fn set_pro(&self, pro: bool) -> Settings {
        let mut s = self.settings.lock().unwrap();
        s.pro = pro;
        self.persist_settings(&s);
        s.clone()
    }

    // ── Alert API ─────────────────────────────────────────────────────
    pub fn list_alerts(&self) -> Vec<Alert> {
        self.alerts.lock().unwrap().clone()
    }

    pub fn add_alert(&self, alert: Alert) -> Vec<Alert> {
        let mut a = self.alerts.lock().unwrap();
        a.insert(0, alert);
        a.truncate(MAX_ALERTS);
        self.persist_alerts(&a);
        a.clone()
    }

    pub fn mark_all_read(&self) -> Vec<Alert> {
        let mut a = self.alerts.lock().unwrap();
        for alert in a.iter_mut() {
            alert.read = true;
        }
        self.persist_alerts(&a);
        a.clone()
    }

    pub fn delete_alert(&self, id: &str) -> Vec<Alert> {
        let mut a = self.alerts.lock().unwrap();
        a.retain(|alert| alert.id != id);
        self.persist_alerts(&a);
        a.clone()
    }

    pub fn clear_alerts(&self) -> Vec<Alert> {
        let mut a = self.alerts.lock().unwrap();
        a.clear();
        self.persist_alerts(&a);
        a.clone()
    }

    pub fn unread_count(&self) -> usize {
        self.alerts.lock().unwrap().iter().filter(|a| !a.read).count()
    }
}
