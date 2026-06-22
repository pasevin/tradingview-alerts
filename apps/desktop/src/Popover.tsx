/**
 * Menu-bar popover — native macOS context-menu aesthetic.
 * Dark translucent surface (vibrancy from Rust), tight rows, SF-style type.
 * Two views: main (status + alerts + actions) and settings.
 */
import {
  useCallback,
  useEffect,
  useState,
  type JSX,
} from "react";
import { clsx } from "clsx";
import { Switch } from "./Switch.js";
import {
  api,
  onEvent,
  type Alert,
  type Settings,
  type ServerStatus,
  type RelayStatus,
  type AuthStatus,
  type AppInfo,
  ALERT_SOUNDS,
} from "./api.js";
import { getLogoUrl, onLogoReady } from "./logoCache.js";

type View = "main" | "settings";

function relativeTime(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function Popover(): JSX.Element {
  const [view, setView] = useState<View>("main");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "installing">("idle");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    api.listAlerts().then(setAlerts);
    api.getSettings().then(setSettings);
    api.getServerStatus().then(setStatus);
    api.relayGetStatus().then(setRelay);
    api.authGetStatus().then(setAuth);
    api.getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    const unsubs = [
      onEvent<{ alert: Alert }>("alerts:new", () => api.listAlerts().then(setAlerts)),
      onEvent<unknown>("alerts:changed", () => api.listAlerts().then(setAlerts)),
      onEvent<Settings>("settings:changed", setSettings),
      onEvent<ServerStatus>("server:status-changed", setStatus),
      onEvent<RelayStatus>("relay:status-changed", setRelay),
      onEvent<AuthStatus>("auth:changed", setAuth),
      onEvent<string>("navigate", (v) => setView(v === "settings" ? "settings" : "main")),
      onEvent<void>("update:checking", () => setUpdateState("checking")),
      onEvent<void>("update:not-available", () => setUpdateState("idle")),
      onEvent<void>("update:installing", () => setUpdateState("installing")),
      onEvent<void>("update:installed", () => setUpdateState("idle")),
      onEvent<string>("update:error", () => setUpdateState("idle")),
      onEvent<{ version: string; body?: string }>("update:available", (info) => {
        setUpdateInfo(info);
        setUpdateState("idle");
      }),
    ];
    return () => unsubs.forEach((p) => p.then((fn) => fn()));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden text-[13px] text-white/90">
      {view === "main" ? (
        <MainView
          alerts={alerts}
          setAlerts={setAlerts}
          settings={settings}
          status={status}
          relay={relay}
          auth={auth}
          updateInfo={updateInfo}
          updateState={updateState}
          onInstallUpdate={() => { setUpdateState("installing"); api.installUpdate(); }}
          onSettings={() => setView("settings")}
        />
      ) : (
        <SettingsView
          settings={settings}
          setSettings={setSettings}
          status={status}
          relay={relay}
          setRelay={setRelay}
          auth={auth}
          setAuth={setAuth}
          appInfo={appInfo}
          updateInfo={updateInfo}
          updateState={updateState}
          onInstallUpdate={() => { setUpdateState("installing"); api.installUpdate(); }}
          onCheckUpdates={() => { setUpdateState("checking"); api.checkForUpdates(); }}
          onBack={() => setView("main")}
        />
      )}
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────

function MainView({
  alerts,
  setAlerts,
  settings,
  status,
  relay,
  auth,
  updateInfo,
  updateState,
  onInstallUpdate,
  onSettings,
}: {
  alerts: Alert[];
  setAlerts: (a: Alert[]) => void;
  settings: Settings | null;
  status: ServerStatus | null;
  relay: RelayStatus | null;
  auth: AuthStatus | null;
  updateInfo: { version: string; body?: string } | null;
  updateState: "idle" | "checking" | "installing";
  onInstallUpdate: () => void;
  onSettings: () => void;
}): JSX.Element {
  const [, setLogoTick] = useState(0);
  useEffect(() => onLogoReady(() => setLogoTick((n) => n + 1)), []);

  const openChart = useCallback((a: Alert) => {
    if (a.ticker) api.openUrl(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(a.ticker.trim())}`);
  }, []);

  const relayEnabled = relay?.enabled ?? false;
  const relayConnected = relayEnabled && (relay?.connected ?? false);
  const serverRunning = status?.running ?? false;

  return (
    <>
      {/* ── Header card ── */}
      <div className="border-b border-white/8 px-3 py-2.5">
        {auth?.signedIn ? (
          <>
            {/* Account row */}
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="person.circle" className="text-white/50" />
                <span className="text-[13px] font-medium text-white/90">{auth.email}</span>
              </div>
              <span className={clsx(
                "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                auth.pro
                  ? "bg-amber-500/20 text-amber-300"
                  : "bg-white/8 text-white/35"
              )}>
                {auth.pro ? "Pro" : "Free"}
              </span>
            </div>
            {/* Status pills row */}
            <div className="flex items-center gap-1.5">
              <StatusPill
                icon={relayConnected ? "cloud.fill" : "cloud"}
                label={relayConnected ? "Cloud" : !relayEnabled ? "Cloud off" : "Connecting…"}
                ok={relayConnected}
              />
              {/* Only show local server pill when it's the active path AND broken */}
              {!serverRunning && !relayConnected && (
                <StatusPill
                  icon="exclamationmark.triangle"
                  label="Server down"
                  ok={false}
                  warn
                />
              )}
            </div>
          </>
        ) : (
          /* Not signed in — single compact row */
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <StatusPill
                icon={relayConnected ? "cloud.fill" : "cloud"}
                label={relayConnected ? "Cloud" : !relayEnabled ? "Cloud off" : "Not signed in"}
                ok={relayConnected}
              />
              <StatusPill
                icon={serverRunning ? "antenna" : "exclamationmark.triangle"}
                label={serverRunning ? `Local :${status?.port}` : "Server down"}
                ok={serverRunning}
                warn={!serverRunning}
              />
            </div>
            <button
              onClick={onSettings}
              className="text-[11px] text-blue-400/80 hover:text-blue-300"
            >
              Sign in →
            </button>
          </div>
        )}
      </div>

      {/* ── Update banner ── */}
      {updateInfo && (
        <div className="flex items-center justify-between border-b border-white/8 bg-blue-500/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <Icon name="arrow.left" className="rotate-90 text-blue-400" />
            <span className="text-[12px] text-blue-300">
              v{updateInfo.version} available
            </span>
          </div>
          <button
            onClick={onInstallUpdate}
            disabled={updateState === "installing"}
            className="rounded bg-blue-500/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {updateState === "installing" ? "Installing…" : "Update Now"}
          </button>
        </div>
      )}

      {/* ── Alert list ── */}
      <div className="flex-1 overflow-y-auto">
        {alerts.length > 0 && (
          <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium text-white/40">
            Recent Alerts
          </div>
        )}
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-10 text-white/30">
            <Icon name="bell" className="h-8 w-8 text-white/20" />
            <span className="mt-1 text-xs">No alerts yet</span>
            <span className="text-[11px]">Paste your webhook URL into TradingView</span>
          </div>
        ) : (
          <ul>
            {alerts.map((a) => {
              const logoUrl = getLogoUrl(a.ticker);
              return (
                <li key={a.id}>
                  <button
                    onClick={() => openChart(a)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-white/8 active:bg-white/12"
                  >
                    {/* Logo — slightly smaller than row height */}
                    <span className="shrink-0">
                      {logoUrl ? (
                        <img src={logoUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10">
                          <Icon name="bell" className="text-white/40" />
                        </span>
                      )}
                    </span>
                    {/* Text */}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1">
                        <span className="truncate font-semibold">
                          {a.ticker ?? "Alert"}
                        </span>
                        {a.ticker && <span className="shrink-0 text-white/50">↗</span>}
                      </span>
                      <span className="flex items-baseline gap-1 text-[11px] text-white/50">
                        <span className="truncate">{a.message}{a.price ? ` · $${a.price}` : ""}</span>
                        <span className="shrink-0">· {relativeTime(a.receivedAt)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Footer actions ── */}
      <div className="border-t border-white/8">
        {alerts.length > 0 && (
          <>
            <ActionRow
              icon={<Icon name="trash" className="text-white/50" />}
              label="Clear All Alerts"
              onClick={() => api.clearAlerts().then(setAlerts)}
            />
            <div className="border-t border-white/8" />
          </>
        )}
        <ActionRow
          icon={<Icon name="gear" className="text-white/50" />}
          label="Settings…"
          shortcut="⌘,"
          onClick={onSettings}
        />
        <div className="border-t border-white/8" />
        <ActionRow
          icon={<Icon name="arrow.up.circle" className={updateInfo ? "text-blue-400" : "text-white/50"} />}
          label={
            updateState === "checking" ? "Checking…" :
            updateState === "installing" ? "Installing…" :
            updateInfo ? `v${updateInfo.version} available` :
            "Check for Updates…"
          }
          onClick={updateInfo ? onInstallUpdate : () => api.checkForUpdates()}
        />
        <div className="border-t border-white/8" />
        <ActionRow
          icon={<Icon name="power" className="text-white/50" />}
          label="Quit TradingView Alerts"
          shortcut="⌘Q"
          onClick={() => api.quit()}
        />
      </div>
    </>
  );
}

// ── Shared row primitives ──────────────────────────────────────────────

function StatusPill({
  icon,
  label,
  ok,
  warn = false,
}: {
  icon: IconName;
  label: string;
  ok: boolean;
  warn?: boolean;
}): JSX.Element {
  return (
    <span
      className={clsx(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
        ok
          ? "bg-green-500/15 text-green-300"
          : warn
          ? "bg-yellow-500/15 text-yellow-300/80"
          : "bg-white/8 text-white/35",
      )}
    >
      <Icon
        name={icon}
        className={clsx(
          "h-[11px] w-[11px]",
          ok ? "text-green-400" : warn ? "text-yellow-400/80" : "text-white/30",
        )}
      />
      {label}
    </span>
  );
}


function Row({
  icon,
  label,
  muted = false,
}: {
  icon: JSX.Element;
  label: React.ReactNode;
  muted?: boolean;
}): JSX.Element {
  return (
    <div className="flex cursor-default select-none items-center gap-2.5 px-3 py-1">
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className={clsx("text-[13px]", muted ? "text-white/35" : "text-white/75")}>
        {label}
      </span>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: JSX.Element;
  label: string;
  shortcut?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 hover:bg-white/8 active:bg-white/12"
    >
      <span className="shrink-0 w-4 flex justify-center">{icon}</span>
      <span className="flex-1 text-left text-white/90">{label}</span>
      {shortcut && <span className="text-[12px] text-white/30">{shortcut}</span>}
    </button>
  );
}

// ── SVG icon set — consistent 14×14, SF Symbol-inspired stroke icons ──
type IconName =
  | "person.circle"
  | "cloud"
  | "cloud.fill"
  | "antenna"
  | "exclamationmark.triangle"
  | "bell"
  | "trash"
  | "gear"
  | "power"
  | "arrow.left"
  | "arrow.up.circle"
  | "checkmark.circle";

function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}): JSX.Element {
  const paths: Record<IconName, JSX.Element> = {
    "person.circle": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <circle cx="7" cy="7" r="6" />
        <circle cx="7" cy="5.5" r="1.8" />
        <path d="M3.2 11.5a3.8 3.8 0 0 1 7.6 0" />
      </svg>
    ),
    "cloud": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M3.5 10a2.5 2.5 0 0 1 0-5 3 3 0 0 1 5.9-.5A2 2 0 0 1 10.5 8.5" />
        <path d="M3.5 10h7a1.5 1.5 0 0 0 0-3h-.5" />
      </svg>
    ),
    "cloud.fill": (
      <svg viewBox="0 0 14 14" fill="currentColor">
        <path d="M9 4a3 3 0 0 0-5.83 1A2.5 2.5 0 0 0 3.5 10h7a2 2 0 0 0 0-4H10A3 3 0 0 0 9 4z" />
      </svg>
    ),
    "antenna": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <line x1="7" y1="6" x2="7" y2="13" />
        <path d="M4.5 8.5a3.5 3.5 0 0 1 0-5" />
        <path d="M9.5 8.5a3.5 3.5 0 0 0 0-5" />
        <path d="M3 10a5.5 5.5 0 0 1 0-7" />
        <path d="M11 10a5.5 5.5 0 0 0 0-7" />
        <circle cx="7" cy="5.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
    "exclamationmark.triangle": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 1.5 L12.5 12 H1.5 Z" />
        <line x1="7" y1="5.5" x2="7" y2="8.5" />
        <circle cx="7" cy="10" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    ),
    "bell": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M7 1.5a4 4 0 0 1 4 4v3l1 1.5H2L3 8.5v-3a4 4 0 0 1 4-4z" />
        <path d="M5.5 11a1.5 1.5 0 0 0 3 0" />
      </svg>
    ),
    "trash": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1.5,3.5 12.5,3.5" />
        <path d="M4.5 3.5V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" />
        <rect x="2.5" y="3.5" width="9" height="9" rx="1" />
        <line x1="5.5" y1="6" x2="5.5" y2="10" />
        <line x1="8.5" y1="6" x2="8.5" y2="10" />
      </svg>
    ),
    "gear": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <circle cx="7" cy="7" r="2" />
        <path d="M7 1.5v1M7 11.5v1M1.5 7h1M11.5 7h1M3.1 3.1l.7.7M10.2 10.2l.7.7M3.1 10.9l.7-.7M10.2 3.8l.7-.7" />
      </svg>
    ),
    "power": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M7 1.5v5" />
        <path d="M4.3 3.3a5 5 0 1 0 5.4 0" />
      </svg>
    ),
    "arrow.left": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 7H3" />
        <path d="M6 4l-3 3 3 3" />
      </svg>
    ),
    "arrow.up.circle": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="5.5" />
        <path d="M7 9.5V5" />
        <path d="M5 7l2-2 2 2" />
      </svg>
    ),
    "checkmark.circle": (
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <circle cx="7" cy="7" r="5.5" />
        <path d="M4.5 7l2 2 3-3" />
      </svg>
    ),
  };

  return (
    <span className={clsx("inline-flex h-[14px] w-[14px] shrink-0", className)}>
      {paths[name]}
    </span>
  );
}

// ── Settings view ──────────────────────────────────────────────────────

function SettingsView({
  settings,
  setSettings,
  status,
  relay,
  setRelay,
  auth,
  setAuth,
  appInfo,
  updateInfo,
  updateState,
  onInstallUpdate,
  onCheckUpdates,
  onBack,
}: {
  settings: Settings | null;
  setSettings: (s: Settings) => void;
  status: ServerStatus | null;
  relay: RelayStatus | null;
  setRelay: (r: RelayStatus) => void;
  auth: AuthStatus | null;
  setAuth: (a: AuthStatus) => void;
  appInfo: AppInfo | null;
  updateInfo: { version: string; body?: string } | null;
  updateState: "idle" | "checking" | "installing";
  onInstallUpdate: () => void;
  onCheckUpdates: () => void;
  onBack: () => void;
}): JSX.Element {
  const [portInput, setPortInput] = useState("");
  const [relayUrlInput, setRelayUrlInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [linkStatus, setLinkStatus] = useState<
    { kind: "idle" | "sending" | "sent" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => { if (settings) setPortInput(String(settings.port)); }, [settings]);
  useEffect(() => { if (relay) setRelayUrlInput(relay.relayBaseUrl); }, [relay]);

  const localUrl = status?.endpoints?.[0] ?? `http://localhost:${settings?.port}/webhook`;

  const savePort = useCallback(() => {
    const port = parseInt(portInput, 10);
    if (isNaN(port) || port < 1 || port > 65535) return;
    api.setSettings({ port }).then(setSettings);
  }, [portInput, setSettings]);

  const toggle = useCallback(
    (field: "notifications" | "sound" | "badge", value: boolean) => {
      api.setSettings({ [field]: value }).then(setSettings);
    },
    [setSettings],
  );

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const requestLink = useCallback(() => {
    const email = emailInput.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setLinkStatus({ kind: "error", message: "Enter a valid email address." });
      return;
    }
    setLinkStatus({ kind: "sending" });
    api.relaySetEnabled(true).then(setRelay).catch(() => {}).finally(() => {
      api.authRequestLink(email)
        .then(() => { setLinkStatus({ kind: "sent" }); return api.authGetStatus().then(setAuth); })
        .catch((e) => setLinkStatus({ kind: "error", message: String(e) }));
    });
  }, [emailInput, setAuth, setRelay]);

  if (!settings) return <div className="flex-1 p-4 text-white/40">Loading…</div>;

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2">
        <button onClick={onBack} className="flex items-center gap-1 text-white/50 hover:text-white/90">
          <Icon name="arrow.left" className="text-white/50" />
          <span className="text-[13px]">Back</span>
        </button>
        <span className="flex-1 text-center text-[13px] font-medium text-white/80">Settings</span>
        <span className="w-12" />{/* balance */}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Account section */}
        <Section title="Account">
          <AccountSection
            auth={auth}
            relay={relay}
            emailInput={emailInput}
            setEmailInput={setEmailInput}
            onRequestLink={requestLink}
            linkStatus={linkStatus}
            onCancel={() => api.authCancel().then(setAuth)}
            onSignOut={() => api.authSignOut().then(setAuth)}
            onCheckout={(plan) => api.billingOpenCheckout(plan)}
            onPortal={() => api.billingOpenPortal()}
            onCopyHook={copy}
            copied={copied}
          />
        </Section>

        {/* Notifications */}
        <Section title="Notifications">
          <ToggleRow label="Native notifications" checked={settings.notifications} onChange={(v) => toggle("notifications", v)} />
          <ToggleRow label="Sound" checked={settings.sound} onChange={(v) => toggle("sound", v)} />
          <ToggleRow label="Menu-bar badge" checked={settings.badge} onChange={(v) => toggle("badge", v)} />
          {settings.sound && (
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[13px] text-white/80">Alert sound</span>
              <div className="flex items-center gap-1.5">
                <select
                  value={settings.alertSound}
                  onChange={(e) =>
                    api.setSettings({ alertSound: e.target.value }).then(setSettings)
                  }
                  className="rounded bg-white/8 px-2 py-1 text-[12px] text-white/80 outline-none focus:bg-white/12 cursor-pointer"
                >
                  {ALERT_SOUNDS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button
                  onClick={() => api.playSound(settings.alertSound)}
                  className="rounded bg-white/8 px-2 py-1 text-[12px] text-white/60 hover:bg-white/15 hover:text-white/90"
                  title="Preview sound"
                >
                  ▶
                </button>
              </div>
            </div>
          )}
        </Section>

        {/* Cloud Relay */}
        <Section title="Cloud Relay">
          <ToggleRow label="Enable cloud relay" checked={relay?.enabled ?? false} onChange={(v) => api.relaySetEnabled(v).then(setRelay)} />
        </Section>

        {/* Local Webhook */}
        <Section title="Local Webhook (Advanced)">
          {auth?.signedIn && relay?.enabled && (
            <div className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-blue-500/10 px-2.5 py-2">
              <Icon name="cloud.fill" className="mt-0.5 shrink-0 text-blue-400/80" />
              <span className="text-[11px] leading-snug text-blue-300/80">
                You're on the cloud relay — the local webhook server is paused.
                It restarts automatically if you sign out or disable cloud.
              </span>
            </div>
          )}
          <div className="px-3 pb-2">
            <div className="mb-1 text-[11px] text-white/40">Webhook URL</div>
            <div className="flex items-center gap-2 rounded bg-white/8 px-2 py-1.5">
              <span className="min-w-0 flex-1 select-all truncate font-mono text-[11px] text-white/70">{localUrl}</span>
              <button onClick={() => copy(localUrl)} className="shrink-0 text-white/40 hover:text-white/80 text-xs">
                {copied ? "✓" : "Copy"}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 pb-2">
            <span className="text-[11px] text-white/40 w-10">Port</span>
            <input
              type="text" inputMode="numeric" value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onBlur={savePort} onKeyDown={(e) => e.key === "Enter" && savePort()}
              className="w-20 rounded bg-white/8 px-2 py-1 font-mono text-[11px] text-white/80 outline-none focus:bg-white/12"
            />
            <button onClick={savePort} className="rounded bg-blue-500/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500">Save</button>
          </div>
          <div className="flex items-center gap-2 px-3 pb-2">
            <span className="text-[11px] text-white/40 w-10">Relay</span>
            <input
              type="text" value={relayUrlInput} placeholder="https://your-relay.fly.dev"
              onChange={(e) => setRelayUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && /^https?:\/\//.test(relayUrlInput.trim()) && api.relaySetBaseUrl(relayUrlInput.trim()).then(setRelay)}
              className="min-w-0 flex-1 rounded bg-white/8 px-2 py-1 font-mono text-[11px] text-white/80 outline-none focus:bg-white/12"
            />
            <button
              onClick={() => /^https?:\/\//.test(relayUrlInput.trim()) && api.relaySetBaseUrl(relayUrlInput.trim()).then(setRelay)}
              className="rounded bg-blue-500/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500"
            >Save</button>
          </div>
        </Section>

        {/* Update section */}
        <Section title="Updates">
          {updateInfo && (
            <div className="mx-3 mb-2 flex items-center justify-between rounded-md bg-blue-500/10 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <Icon name="arrow.up.circle" className="text-blue-400" />
                <span className="text-[12px] text-blue-300">
                  v{updateInfo.version} available
                </span>
              </div>
              <button
                onClick={onInstallUpdate}
                disabled={updateState === "installing"}
                className="rounded bg-blue-500/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {updateState === "installing" ? "Installing…" : "Update Now"}
              </button>
            </div>
          )}
          <ActionRow
            icon={<Icon name="arrow.up.circle" className="text-white/50" />}
            label={updateState === "checking" ? "Checking…" : "Check for Updates…"}
            onClick={onCheckUpdates}
          />
        </Section>

        {/* Version footer */}
        <div className="px-3 py-3 text-center">
          <div className="text-[11px] text-white/30">
            TradingView Alerts v{appInfo?.version ?? "—"}
          </div>
          {appInfo?.lastUpdatedAt && (
            <div className="mt-0.5 text-[10px] text-white/20">
              Updated {formatTimestamp(appInfo.lastUpdatedAt)}
            </div>
          )}
          {appInfo?.lastUpdateCheck && !appInfo.lastUpdatedAt && (
            <div className="mt-0.5 text-[10px] text-white/20">
              Last checked {formatTimestamp(appInfo.lastUpdateCheck)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="border-b border-white/8 py-2">
      <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-white/30">{title}</div>
      {children}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-[13px] text-white/80">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function AccountSection({
  auth, relay, emailInput, setEmailInput, onRequestLink, linkStatus,
  onCancel, onSignOut, onCheckout, onPortal, onCopyHook, copied,
}: {
  auth: AuthStatus | null; relay: RelayStatus | null;
  emailInput: string; setEmailInput: (v: string) => void;
  onRequestLink: () => void;
  linkStatus: { kind: "idle" | "sending" | "sent" } | { kind: "error"; message: string };
  onCancel: () => void; onSignOut: () => void;
  onCheckout: (p: "monthly" | "yearly") => void; onPortal: () => void;
  onCopyHook: (t: string) => void; copied: boolean;
}): JSX.Element {
  // Self-hosted
  if (auth?.authRequired === false) {
    return (
      <div className="px-3 pb-2">
        <div className="text-[12px] text-white/50">Self-hosted relay — no account needed.</div>
        {relay?.hookUrl && (
          <div className="mt-1.5 flex items-center gap-2 rounded bg-white/8 px-2 py-1.5">
            <span className="min-w-0 flex-1 select-all truncate font-mono text-[11px] text-white/70">{relay.hookUrl}</span>
            <button onClick={() => onCopyHook(relay.hookUrl!)} className="text-[11px] text-white/40 hover:text-white/80">{copied ? "✓" : "Copy"}</button>
          </div>
        )}
      </div>
    );
  }

  // Signed in
  if (auth?.signedIn) {
    return (
      <div className="px-3 pb-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] text-white/70">{auth.email}</span>
          <span className={clsx("flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", auth.pro ? "bg-amber-500/20 text-amber-300" : "bg-white/8 text-white/35")}>
            {auth.pro ? "Pro" : "Free"}
          </span>
        </div>
        {auth.pro && relay?.hookUrl && (
          <div className="mb-1.5 flex items-center gap-2 rounded bg-white/8 px-2 py-1.5">
            <span className="min-w-0 flex-1 select-all truncate font-mono text-[11px] text-white/70">{relay.hookUrl}</span>
            <button onClick={() => onCopyHook(relay.hookUrl!)} className="text-[11px] text-white/40 hover:text-white/80">{copied ? "✓" : "Copy"}</button>
          </div>
        )}
        {!auth.pro && (
          <div className="mb-1.5 flex gap-1.5">
            <button onClick={() => onCheckout("monthly")} className="flex-1 rounded bg-blue-500/80 py-1 text-[11px] text-white hover:bg-blue-500">$4.99/mo</button>
            <button onClick={() => onCheckout("yearly")} className="flex-1 rounded bg-amber-500/80 py-1 text-[11px] text-white hover:bg-amber-500">$40/yr · 33% off</button>
          </div>
        )}
        <div className="flex gap-2">
          {auth.pro && auth.portalUrl && <button onClick={onPortal} className="text-[11px] text-white/40 hover:text-white/70">Manage</button>}
          <button onClick={onSignOut} className="text-[11px] text-white/40 hover:text-red-400">Sign Out</button>
        </div>
      </div>
    );
  }

  // Pending
  if (auth?.pending) {
    return (
      <div className="px-3 pb-2">
        <div className="text-[12px] text-white/60">
          Check your email — link sent to <span className="font-medium text-white/80">{auth.pendingEmail}</span>.
        </div>
        <button onClick={onCancel} className="mt-1 text-[11px] text-white/40 hover:text-red-400">Cancel</button>
      </div>
    );
  }

  // Signed out
  return (
    <div className="px-3 pb-2">
      <div className="mb-2 text-[12px] text-white/50">
        Pro gives you a personal webhook URL — no tunnel needed.
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="email" value={emailInput} placeholder="you@example.com"
          onChange={(e) => setEmailInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && linkStatus.kind !== "sending" && onRequestLink()}
          className="min-w-0 flex-1 rounded bg-white/8 px-2 py-1.5 text-[12px] text-white/80 outline-none placeholder:text-white/30 focus:bg-white/12"
        />
        <button
          onClick={onRequestLink} disabled={linkStatus.kind === "sending"}
          className="shrink-0 rounded bg-blue-500/80 px-2.5 py-1.5 text-[12px] text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {linkStatus.kind === "sending" ? "Sending…" : "Send Link"}
        </button>
      </div>
      {linkStatus.kind === "sent" && <div className="mt-1 text-[11px] text-green-400">Check your email!</div>}
      {linkStatus.kind === "error" && <div className="mt-1 text-[11px] text-red-400">{linkStatus.message}</div>}
    </div>
  );
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
