/**
 * The menu-bar popover surface: connection status header, recent alerts list,
 * and a Pro upsell when the relay is gating delivery. Deliberately compact —
 * this is a glanceable panel, not a full window.
 */
import type { JSX } from "react";
import { Bell, BellOff, Cloud, CloudOff, Crown } from "lucide-react";
import { useRelay } from "./useRelay.js";
import { clsx } from "clsx";

// In a real build these come from persisted settings; hardcoded for the demo.
const RELAY_WS = "wss://tvalert-relay.fly.dev";
const TOKEN = "demo-token";

function relativeTime(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

export function Popover(): JSX.Element {
  const { state, pro, alerts } = useRelay(RELAY_WS, TOKEN);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-black/10 bg-white/80 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/80">
      <header className="flex items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/5">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-semibold">TradingView Alerts</span>
        </div>
        <StatusPill state={state} pro={pro} />
      </header>

      <main className="flex-1 overflow-y-auto">
        {alerts.length === 0 ? (
          <EmptyState state={state} />
        ) : (
          <ul className="divide-y divide-black/5 dark:divide-white/5">
            {alerts.map((a) => (
              <li key={a.id} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {a.symbol ?? "Alert"}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-400">
                    {relativeTime(a.receivedAt)}
                  </span>
                </div>
                <p className="truncate text-xs text-zinc-500">{a.message}</p>
              </li>
            ))}
          </ul>
        )}
      </main>

      {!pro && <UpsellFooter />}
    </div>
  );
}

function StatusPill({
  state,
  pro,
}: {
  state: ReturnType<typeof useRelay>["state"];
  pro: boolean;
}): JSX.Element {
  const online = state === "online";
  return (
    <span
      className={clsx(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
        online
          ? "bg-green-500/10 text-green-600"
          : "bg-zinc-500/10 text-zinc-500",
      )}
    >
      {online ? <Cloud className="h-3 w-3" /> : <CloudOff className="h-3 w-3" />}
      {online ? (pro ? "Pro" : "Connected") : "Connecting…"}
    </span>
  );
}

function EmptyState({
  state,
}: {
  state: ReturnType<typeof useRelay>["state"];
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-zinc-400">
      {state === "online" ? (
        <Bell className="h-8 w-8" />
      ) : (
        <BellOff className="h-8 w-8" />
      )}
      <p className="text-sm">No alerts yet</p>
      <p className="text-xs">Paste your webhook URL into TradingView to start.</p>
    </div>
  );
}

function UpsellFooter(): JSX.Element {
  return (
    <footer className="flex items-center gap-2 border-t border-black/5 bg-amber-500/5 px-4 py-2.5 dark:border-white/5">
      <Crown className="h-4 w-4 text-amber-500" />
      <span className="text-xs text-zinc-600 dark:text-zinc-300">
        Upgrade to Pro for an always-on hosted relay.
      </span>
    </footer>
  );
}
