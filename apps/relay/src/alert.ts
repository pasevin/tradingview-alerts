/**
 * Turn a raw TradingView webhook body into a canonical Alert. TradingView
 * sends whatever the user typed in the alert "message" box — often plain text,
 * sometimes JSON. We keep the original in `raw` and extract a symbol/message
 * best-effort so the UI always has something sensible to show.
 */
import { nanoid } from "nanoid";
import type { Alert } from "@tvalert/protocol";

const SYMBOL_RE = /\b([A-Z]{2,10}(?:USDT?|PERP)?)\b/;

export function parseAlert(rawBody: string): Alert {
  const raw = rawBody.trim();
  let message = raw;
  let symbol: string | undefined;

  // JSON bodies: lift common TradingView fields if present.
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      symbol =
        (obj.ticker as string) ??
        (obj.symbol as string) ??
        undefined;
      message =
        (obj.message as string) ??
        (obj.alert as string) ??
        raw;
    } catch {
      // Not valid JSON after all; fall through to text handling.
    }
  }

  if (!symbol) {
    const match = SYMBOL_RE.exec(message);
    symbol = match?.[1];
  }

  return {
    id: nanoid(),
    receivedAt: Date.now(),
    symbol,
    message,
    raw,
  };
}
