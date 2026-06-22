// Thin typed wrapper over Tauri's invoke + event APIs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Settings {
  port: number;
  notifications: boolean;
  sound: boolean;
  badge: boolean;
  relayBaseUrl: string;
  relayToken: string | null;
  cloudEnabled: boolean;
  sessionToken: string | null;
  accountEmail: string | null;
  pro: boolean;
  alertSound: string;
}

export interface Alert {
  id: string;
  receivedAt: number;
  ticker?: string;
  message: string;
  price?: string;
  raw: string;
  read: boolean;
}

export interface ServerStatus {
  running: boolean;
  port: number;
  endpoints: string[];
}

export interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  relayBaseUrl: string;
  token: string | null;
  hookUrl: string | null;
  error?: string;
}

export interface AuthStatus {
  signedIn: boolean;
  email: string | null;
  pro: boolean;
  portalUrl: string | null;
  hookUrl: string | null;
  pending: boolean;
  pendingEmail: string | null;
  authRequired: boolean;
  error?: string;
}

export const ALERT_SOUNDS = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass",
  "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi",
  "Submarine", "Tink",
] as const;

export type AlertSound = (typeof ALERT_SOUNDS)[number];

export interface AppInfo {
  version: string;
  lastUpdateCheck: number | null;
  lastUpdatedAt: number | null;
}

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (patch: Partial<Settings>) =>
    invoke<Settings>("set_settings", { patch }),
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  listAlerts: () => invoke<Alert[]>("list_alerts"),
  markAllRead: () => invoke<Alert[]>("mark_all_read"),
  deleteAlert: (id: string) => invoke<Alert[]>("delete_alert", { id }),
  clearAlerts: () => invoke<Alert[]>("clear_alerts"),
  getServerStatus: () => invoke<ServerStatus>("get_server_status"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  quit: () => invoke<void>("quit"),
  playSound: (name: string) => invoke<void>("play_sound", { name }),
  checkForUpdates: () => invoke<void>("check_for_updates"),
  installUpdate: () => invoke<void>("install_update"),

  // Relay / auth / billing
  relayGetStatus: () => invoke<RelayStatus>("relay_get_status"),
  authGetStatus: () => invoke<AuthStatus>("auth_get_status"),
  relaySetEnabled: (enabled: boolean) =>
    invoke<RelayStatus>("relay_set_enabled", { enabled }),
  relaySetBaseUrl: (url: string) =>
    invoke<RelayStatus>("relay_set_base_url", { url }),
  authRequestLink: (email: string) =>
    invoke<void>("auth_request_link", { email }),
  authCancel: () => invoke<AuthStatus>("auth_cancel"),
  authSignOut: () => invoke<AuthStatus>("auth_sign_out"),
  billingOpenCheckout: (plan: "monthly" | "yearly") =>
    invoke<void>("billing_open_checkout", { plan }),
  billingOpenPortal: () => invoke<void>("billing_open_portal"),
};

export function onEvent<T>(
  name: string,
  cb: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (e) => cb(e.payload));
}
