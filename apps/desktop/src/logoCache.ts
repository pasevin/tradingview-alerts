// Asset logo cache for alert list icons.
// Fetches from crypto-icons CDN (crypto) and FMP (stocks), caches in memory.
// Returns a data URL once loaded; triggers a re-render via a callback.

const QUOTES = ["USDT", "USDC", "BUSD", "USD", "PERP", "EUR", "GBP", "JPY", "BTC", "ETH"];
const MIN_BYTES = 200;

interface LogoMeta {
  key: string;
  coin: string;
  stock: string;
}

function normalize(ticker: string | undefined): LogoMeta | null {
  if (!ticker) return null;
  const afterExchange = ticker.includes(":") ? (ticker.split(":").pop() ?? "") : ticker;
  const sym = afterExchange.toUpperCase().replace(/\.P$/, "").replace(/[^A-Z0-9]/g, "");
  if (!sym || sym.length > 15) return null;
  let coin = sym;
  for (const q of QUOTES) {
    if (coin.length > q.length && coin.endsWith(q)) {
      coin = coin.slice(0, -q.length);
      break;
    }
  }
  return { key: sym.toLowerCase(), coin: coin.toLowerCase(), stock: sym };
}

function candidateUrls(meta: LogoMeta): string[] {
  return [
    `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/128/color/${meta.coin}.png`,
    `https://financialmodelingprep.com/image-stock/${meta.stock}.png`,
  ];
}

// key → data URL (loaded) | null (unavailable) | undefined (in-flight)
const cache = new Map<string, string | null>();
const inflight = new Set<string>();
const callbacks = new Set<() => void>();

export function onLogoReady(cb: () => void): () => void {
  callbacks.add(cb);
  return () => callbacks.delete(cb);
}

/** Synchronously returns a cached data URL, or kicks off a fetch and returns undefined. */
export function getLogoUrl(ticker: string | undefined): string | undefined {
  const meta = normalize(ticker);
  if (!meta) return undefined;
  if (cache.has(meta.key)) return cache.get(meta.key) ?? undefined;
  if (!inflight.has(meta.key)) void fetchLogo(meta);
  return undefined;
}

async function fetchLogo(meta: LogoMeta): Promise<void> {
  inflight.add(meta.key);
  try {
    for (const url of candidateUrls(meta)) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < MIN_BYTES) continue;
        // Convert to data URL so we can use it as an <img> src.
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const mime = url.endsWith(".png") ? "image/png" : "image/jpeg";
        cache.set(meta.key, `data:${mime};base64,${b64}`);
        callbacks.forEach((cb) => cb());
        return;
      } catch {
        // try next source
      }
    }
    cache.set(meta.key, null); // unavailable
  } finally {
    inflight.delete(meta.key);
  }
}
