/**
 * IPC facade. Glaze exposed an Electron-style `ipcMain.handle(channel, fn)`.
 * Tauri's model is inverted — the frontend invokes Rust `#[tauri::command]`s —
 * so for a JS-to-JS request/response bridge we layer a thin protocol over
 * Tauri events: the caller emits `<channel>:req` with a correlation id and
 * listens once for `<channel>:res:<id>`.
 *
 * This keeps every existing `ipcMain.handle("get-alerts", …)` call site intact.
 */
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

type Handler = (payload: unknown) => unknown | Promise<unknown>;

interface RequestEnvelope {
  id: string;
  payload: unknown;
}

class IpcMainFacade {
  private readonly unlisteners = new Map<string, Promise<UnlistenFn>>();

  handle(channel: string, handler: Handler): void {
    this.removeHandler(channel);
    const unlisten = listen<RequestEnvelope>(`${channel}:req`, async (event) => {
      const { id, payload } = event.payload;
      try {
        const result = await handler(payload);
        await emit(`${channel}:res:${id}`, { ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emit(`${channel}:res:${id}`, { ok: false, error: message });
      }
    });
    this.unlisteners.set(channel, unlisten);
  }

  removeHandler(channel: string): void {
    const pending = this.unlisteners.get(channel);
    if (pending) {
      void pending.then((fn) => fn());
      this.unlisteners.delete(channel);
    }
  }
}

export const ipcMain = new IpcMainFacade();
