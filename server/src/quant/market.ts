import type { Candle } from './indicators.js';

/**
 * Crypto prices from Coinbase Exchange's public market-data API. It needs no key and serves
 * US users. Products are pairs such as BTC-USD or ETH-USD.
 */

const BASE = 'https://api.exchange.coinbase.com';
const HEADERS = { 'User-Agent': 'bot-hq', Accept: 'application/json' };

export const INTERVALS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };

/** "btc", "BTC/USD", "btc-usd" → "BTC-USD". */
export function product(symbol: string): string {
  const s = String(symbol ?? '').trim().toUpperCase().replace(/[/_ ]/g, '-');
  if (!/^[A-Z0-9]{2,10}(-[A-Z]{3,5})?$/.test(s)) throw new Error(`"${symbol}" is not a symbol like BTC or ETH-USD.`);
  return s.includes('-') ? s : `${s}-USD`;
}

async function get(path: string): Promise<any> {
  const res = await fetch(BASE + path, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new Error('Coinbase does not list that pair.');
  if (!res.ok) throw new Error(`Coinbase answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function lastPrice(symbol: string): Promise<{ product: string; price: number; time: string }> {
  const p = product(symbol);
  const t = await get(`/products/${p}/ticker`);
  const price = Number(t.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`No price for ${p}.`);
  return { product: p, price, time: t.time ?? new Date().toISOString() };
}

/** Up to `limit` most recent candles, oldest first. Coinbase serves 300 per request, so this pages back. */
export async function candles(symbol: string, interval = '1d', limit = 365): Promise<Candle[]> {
  const p = product(symbol);
  const g = INTERVALS[interval];
  if (!g) throw new Error(`Interval must be one of ${Object.keys(INTERVALS).join(', ')}.`);
  const want = Math.max(30, Math.min(Math.floor(limit), 1500));
  const byTime = new Map<number, Candle>();
  let end = Math.floor(Date.now() / 1000);
  for (let page = 0; page < 6 && byTime.size < want; page++) {
    const start = end - g * 300;
    const rows: number[][] = await get(`/products/${p}/candles?granularity=${g}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
    if (!Array.isArray(rows) || !rows.length) break;
    // Each row is [time, low, high, open, close, volume].
    for (const [t, l, h, o, c, v] of rows) byTime.set(t * 1000, { t: t * 1000, o, h, l, c, v });
    end = start;
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-want);
}
