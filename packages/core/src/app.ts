/**
 * App lifecycle facade.
 *
 * Mirrors the handful of Glaze `app` members the desktop backend relied on, so
 * `main/index.ts` keeps reading `app.on("ready", …)` / `app.dock?.hide()`
 * unchanged. The macOS "accessory" (no-dock) policy is declared statically in
 * tauri.conf.json; `dock.hide()` is therefore a no-op kept only for source
 * compatibility with the original Glaze code path.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";

type AppEvent = "ready" | "before-quit" | "activate";

class AppFacade {
  private readyResolved = false;
  private readonly handlers = new Map<AppEvent, Array<() => void>>();

  /**
   * Tauri has no global "ready" the way Electron does — the webview is alive by
   * the time module code runs. We resolve `ready` on the next microtask so
   * listeners registered synchronously at import time still fire.
   */
  on(event: AppEvent, handler: () => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    if (event === "ready" && !this.readyResolved) {
      queueMicrotask(() => {
        this.readyResolved = true;
        for (const h of this.handlers.get("ready") ?? []) h();
      });
    }
    return this;
  }

  /** Kept for Glaze source compatibility; no-op under the accessory policy. */
  readonly dock = {
    hide: (): void => {},
    show: (): void => {},
  };

  async quit(): Promise<void> {
    for (const h of this.handlers.get("before-quit") ?? []) h();
    await exit(0);
  }

  async hide(): Promise<void> {
    await getCurrentWindow().hide();
  }
}

export const app = new AppFacade();
