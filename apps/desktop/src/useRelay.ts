/**
 * React hook owning the relay WebSocket: connect, validate every inbound
 * frame against the shared protocol schema, auto-reconnect with backoff, and
 * keep a heartbeat so dead sockets are detected promptly.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import {
  ServerMessageSchema,
  WS_PATH,
  type Alert,
  type ServerMessage,
} from "@tvalert/protocol";

export type ConnectionState = "connecting" | "online" | "offline";

interface UseRelayResult {
  state: ConnectionState;
  pro: boolean;
  alerts: Alert[];
}

export function useRelay(baseWsUrl: string, token: string): UseRelayResult {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [pro, setPro] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);

  const handle = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "welcome":
        setPro(msg.pro);
        break;
      case "alert":
        setAlerts((prev) => [msg.alert, ...prev].slice(0, 200));
        break;
      case "entitlement":
        setPro(msg.pro);
        break;
      case "limit":
        // Surfaced as an upsell row by the UI; nothing to store.
        break;
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const connect = (): void => {
      if (closed) return;
      setState("connecting");
      const ws = new WebSocket(`${baseWsUrl}${WS_PATH}?token=${token}`);
      socketRef.current = ws;

      ws.onopen = () => {
        backoffRef.current = 1000;
        setState("online");
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 25_000);
      };

      ws.onmessage = (event) => {
        const parsed = ServerMessageSchema.safeParse(
          JSON.parse(event.data as string),
        );
        if (parsed.success) handle(parsed.data);
      };

      ws.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        setState("offline");
        if (!closed) {
          const delay = Math.min(backoffRef.current, 30_000);
          backoffRef.current *= 2;
          setTimeout(connect, delay);
        }
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      socketRef.current?.close();
    };
  }, [baseWsUrl, token, handle]);

  return { state, pro, alerts };
}
