/**
 * Technical indicators over a series of closing prices (oldest first).
 * Every function returns an array the same length as its input, with `null` until there is
 * enough history, so values line up with the candles they belong to.
 */

export interface Candle {
  /** Start of the candle, ms since epoch. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Series = (number | null)[];

export function sma(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const k = 2 / (n + 1);
  let prev = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < xs.length; i++) {
    prev = xs[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(xs: number[], n = 14): Series {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

export function macd(xs: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(xs, fast), s = ema(xs, slow);
  const line: Series = xs.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
  const start = line.findIndex((v) => v != null);
  const sig: Series = new Array(xs.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start) as number[], signal);
    e.forEach((v, j) => (sig[start + j] = v));
  }
  const hist: Series = line.map((v, i) => (v != null && sig[i] != null ? v - (sig[i] as number) : null));
  return { line, signal: sig, hist };
}

export function bollinger(xs: number[], n = 20, k = 2) {
  const mid = sma(xs, n);
  const upper: Series = new Array(xs.length).fill(null);
  const lower: Series = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    const m = mid[i] as number;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (xs[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/** Average true range (Wilder). */
export function atr(cs: Candle[], n = 14): Series {
  const out: Series = new Array(cs.length).fill(null);
  if (cs.length <= n) return out;
  const tr = cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c))));
  let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
  out[n] = a;
  for (let i = n + 1; i < cs.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

const round = (v: number | null | undefined, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** A compact read-out of where the latest candle stands, for an agent to reason over. */
export function snapshot(cs: Candle[]) {
  const closes = cs.map((c) => c.c);
  const last = cs.length - 1;
  const at = (s: Series) => round(s[last]);
  const m = macd(closes);
  const b = bollinger(closes);
  const price = closes[last];
  const sma50 = sma(closes, 50)[last], sma200 = sma(closes, 200)[last];
  const ret = (k: number) => (last - k >= 0 ? round((price / closes[last - k] - 1) * 100, 2) : null);
  const window = closes.slice(-Math.min(closes.length, 20));
  return {
    price,
    change_pct: { last_1: ret(1), last_7: ret(7), last_30: ret(30) },
    sma_20: at(sma(closes, 20)),
    sma_50: round(sma50),
    sma_200: round(sma200),
    trend: sma50 == null || sma200 == null ? 'not enough history' : sma50 > sma200 ? 'up (50 above 200)' : 'down (50 below 200)',
    rsi_14: at(rsi(closes)),
    macd: { line: at(m.line), signal: at(m.signal), hist: at(m.hist) },
    bollinger_20: { upper: at(b.upper), mid: at(b.mid), lower: at(b.lower) },
    atr_14: at(atr(cs)),
    recent_high: Math.max(...window),
    recent_low: Math.min(...window),
  };
}
