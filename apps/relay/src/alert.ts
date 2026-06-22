/**
 * Turn a raw TradingView webhook body into a canonical Alert. TradingView
 * sends whatever the user typed in the alert "message" box — often plain text,
 * sometimes JSON. We keep the original in `raw` and extract a symbol/message
 * best-effort so the UI always has something sensible to show.
 *
 * Special handling for prefixed payloads (e.g. "VOLATILITY_SPIKE {json}"):
 * the prefix identifies a structured alert type; the JSON after it carries
 * the fields. We parse both and format a human-readable message.
 */
import { nanoid } from "nanoid";
import type { Alert } from "@tvalert/protocol";

const SYMBOL_RE = /\b([A-Z]{2,10}(?:USDT?|PERP)?)\b/;

function formatTimeframe(tf: string): string {
  const map: Record<string, string> = {
    "1": "1m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "120": "2h", "240": "4h", "D": "1D", "W": "1W",
  };
  return map[tf] ?? tf;
}

function formatVolatilityMessage(obj: Record<string, unknown>): string {
  const tf = formatTimeframe(String(obj.timeframe ?? ""));
  const roc = Number(obj.roc_value ?? 0);
  const zScore = Number(obj.z_score ?? 0);
  const volRatio = obj.volume_ratio != null ? Number(obj.volume_ratio) : null;

  const parts: string[] = [
    `Vol Spike · ${tf} · ROC ${roc.toFixed(2)}% · Z ${zScore.toFixed(1)}σ`,
  ];
  if (volRatio !== null) {
    parts.push(`Vol ${volRatio.toFixed(1)}x`);
  }
  return parts.join(" · ");
}

export function parseAlert(rawBody: string): Alert {
  const raw = rawBody.trim();
  let message = raw;
  let symbol: string | undefined;

  // Prefixed payloads: "PREFIX {json}" — structured alert types from custom
  // Pine Scripts. The prefix routes parsing; the JSON carries the fields.
  const prefixMatch = raw.match(/^([A-Z_]+)\s+(\{.*\})$/s);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    const jsonStr = prefixMatch[2]!;
    try {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>;

      if (prefix === "VOLATILITY_SPIKE") {
        symbol = (obj.symbol as string) ?? undefined;
        message = formatVolatilityMessage(obj);
        // Build clean JSON for the app's local parser (which reads `raw` and
        // re-parses it). Include `message` so the app displays it directly
        // instead of the raw payload.
        const cleanRaw = JSON.stringify({ ...obj, message, ticker: symbol });
        return { id: nanoid(), receivedAt: Date.now(), symbol, message, raw: cleanRaw };
      } else {
        // Unknown prefix — extract best-effort fields from JSON
        symbol = (obj.symbol as string) ?? (obj.ticker as string) ?? undefined;
        message = (obj.message as string) ?? raw;
      }

      if (!symbol) {
        const match = SYMBOL_RE.exec(message);
        symbol = match?.[1];
      }

      return { id: nanoid(), receivedAt: Date.now(), symbol, message, raw };
    } catch {
      // JSON parse failed — fall through to default handling
    }
  }

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
