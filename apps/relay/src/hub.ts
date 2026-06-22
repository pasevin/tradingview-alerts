/**
 * In-memory registry of live app WebSocket connections, keyed by account id.
 * On connect we flush any durably-queued alerts; while connected, alerts are
 * pushed straight through; on disconnect, new alerts fall back to the DB queue.
 */
import type { WebSocket } from "@fastify/websocket";
import type { Alert, ServerMessage } from "@tvalert/protocol";
import { queue } from "./db.js";

class ConnectionHub {
  private readonly sockets = new Map<string, Set<WebSocket>>();

  add(accountId: string, socket: WebSocket): void {
    const set = this.sockets.get(accountId) ?? new Set();
    set.add(socket);
    this.sockets.set(accountId, set);
  }

  remove(accountId: string, socket: WebSocket): void {
    const set = this.sockets.get(accountId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(accountId);
  }

  isOnline(accountId: string): boolean {
    return (this.sockets.get(accountId)?.size ?? 0) > 0;
  }

  get connectionCount(): number {
    let total = 0;
    for (const set of this.sockets.values()) total += set.size;
    return total;
  }

  send(accountId: string, message: ServerMessage): boolean {
    const set = this.sockets.get(accountId);
    if (!set || set.size === 0) return false;
    const data = JSON.stringify(message);
    for (const socket of set) socket.send(data);
    return true;
  }

  /**
   * Deliver an alert. If the account is online it goes over the wire; otherwise
   * it is persisted so it survives until the app reconnects.
   */
  deliverAlert(accountId: string, alert: Alert): void {
    // Send both nested (protocol) and flat (legacy app) formats for compatibility.
    // Old app clients read v.get("raw") at top level; new clients read v.alert.
    const sent = this.send(accountId, {
      type: "alert",
      alert,
      raw: alert.raw,
    } as unknown as ServerMessage);
    if (!sent) queue.push(accountId, alert);
  }

  /** Flush durable backlog in order, then a welcome, on a fresh connection. */
  flushBacklog(accountId: string, pro: boolean): void {
    this.send(accountId, {
      type: "welcome",
      pro,
      serverTime: Date.now(),
    });
    for (const alert of queue.drain(accountId)) {
      this.send(accountId, { type: "alert", alert });
    }
  }
}

export const hub = new ConnectionHub();
