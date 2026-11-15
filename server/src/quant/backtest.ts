import { ema, macd, rsi, sma, type Candle } from './indicators.js';

/**
 * A long-only backtester. A strategy says, for each candle, whether it wants to be in the market
 * after that candle closes. Orders fill at the NEXT candle's open, so a signal never trades on the
 * price that produced it. Fees are charged on every entry and exit.
 *
 * Results are reported separately for the first 70% of the history (in-sample) and the last 30%
 * (out-of-sample): a strategy that only works in-sample was probably fitted to noise.
 */

export type StrategyName = 'sma_cross' | 'ema_cross' | 'rsi_reversion' | 'breakout' | 'macd_cross';

export const STRATEGIES: Record<StrategyName, { about: string; defaults: Record<string, number> }> = {
  sma_cross: { about: 'In while the fast simple moving average is above the slow one.', defaults: { fast: 20, slow: 50 } },
  ema_cross: { about: 'In while the fast exponential moving average is above the slow one.', defaults: { fast: 12, slow: 26 } },
  rsi_reversion: { about: 'Buy when RSI drops below `buy_below`, sell when it rises above `sell_above`.', defaults: { period: 14, buy_below: 30, sell_above: 55 } },
  breakout: { about: 'Buy on a close above the highest close of the last `lookback` candles, sell on a close below the lowest close of the last `exit_lookback`.', defaults: { lookback: 20, exit_lookback: 10 } },
  macd_cross: { about: 'In while the MACD line is above its signal line.', defaults: { fast: 12, slow: 26, signal: 9 } },
};

/** Whether the strategy wants to hold after each candle closes. `null` = no opinion yet (warm-up). */
export function signals(name: StrategyName, cs: Candle[], p: Record<string, number>): (boolean | null)[] {
  const closes = cs.map((c) => c.c);
  const out: (boolean | null)[] = new Array(cs.length).fill(null);
  switch (name) {
    case 'sma_cross':
    case 'ema_cross': {
      const f = (name === 'sma_cross' ? sma : ema)(closes, p.fast), s = (name === 'sma_cross' ? sma : ema)(closes, p.slow);
      for (let i = 0; i < cs.length; i++) if (f[i] != null && s[i] != null) out[i] = (f[i] as number) > (s[i] as number);
      return out;
    }
    case 'macd_cross': {
      const m = macd(closes, p.fast, p.slow, p.signal);
      for (let i = 0; i < cs.length; i++) if (m.line[i] != null && m.signal[i] != null) out[i] = (m.line[i] as number) > (m.signal[i] as number);
      return out;
    }
    case 'rsi_reversion': {
      const r = rsi(closes, p.period);
      let holding = false;
      for (let i = 0; i < cs.length; i++) {
        const v = r[i];
        if (v == null) continue;
        if (!holding && v < p.buy_below) holding = true;
        else if (holding && v > p.sell_above) holding = false;
        out[i] = holding;
      }
      return out;
    }
    case 'breakout': {
      let holding = false;
      const warm = Math.max(p.lookback, p.exit_lookback);
      for (let i = warm; i < cs.length; i++) {
        const hi = Math.max(...closes.slice(i - p.lookback, i));
        const lo = Math.min(...closes.slice(i - p.exit_lookback, i));
        if (!holding && closes[i] > hi) holding = true;
        else if (holding && closes[i] < lo) holding = false;
        out[i] = holding;
      }
      return out;
    }
  }
}

export interface Trade { entry_time: string; entry: number; exit_time: string; exit: number; return_pct: number; open?: boolean }

export interface Stats {
  from: string;
  to: string;
  candles: number;
  total_return_pct: number;
  buy_and_hold_pct: number;
  max_drawdown_pct: number;
  trades: number;
  win_rate_pct: number | null;
  avg_trade_pct: number | null;
  time_in_market_pct: number;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const r2 = (v: number) => Number(v.toFixed(2));

/** Simulate the strategy over candles [from, to) given precomputed signals. */
function simulate(cs: Candle[], sig: (boolean | null)[], from: number, to: number, feeBps: number) {
  const fee = feeBps / 10_000;
  let equity = 1, peak = 1, maxDd = 0, inBars = 0;
  let holding = false, entry = 0, entryT = 0, units = 0;
  const trades: Trade[] = [];
  for (let i = from; i < to; i++) {
    const c = cs[i];
    // The decision made at the previous close fills at this candle's open.
    const want = i > from ? sig[i - 1] === true : false;
    if (want && !holding) {
      holding = true; entry = c.o; entryT = c.t;
      units = (equity * (1 - fee)) / c.o;
    } else if (!want && holding) {
      holding = false;
      equity = units * c.o * (1 - fee);
      trades.push({ entry_time: iso(entryT), entry, exit_time: iso(c.t), exit: c.o, return_pct: r2((c.o / entry) * (1 - fee) ** 2 * 100 - 100) });
    }
    const mark = holding ? units * c.c : equity;
    if (holding) inBars++;
    peak = Math.max(peak, mark);
    maxDd = Math.max(maxDd, 1 - mark / peak);
  }
  const lastC = cs[to - 1];
  if (holding) {
    equity = units * lastC.c * (1 - fee);
    trades.push({ entry_time: iso(entryT), entry, exit_time: iso(lastC.t), exit: lastC.c, return_pct: r2((lastC.c / entry) * (1 - fee) ** 2 * 100 - 100), open: true });
  }
  const wins = trades.filter((t) => t.return_pct > 0).length;
  const stats: Stats = {
    from: iso(cs[from].t),
    to: iso(lastC.t),
    candles: to - from,
    total_return_pct: r2((equity - 1) * 100),
    buy_and_hold_pct: r2((lastC.c / cs[from].o - 1) * 100),
    max_drawdown_pct: r2(maxDd * 100),
    trades: trades.length,
    win_rate_pct: trades.length ? r2((wins / trades.length) * 100) : null,
    avg_trade_pct: trades.length ? r2(trades.reduce((a, t) => a + t.return_pct, 0) / trades.length) : null,
    time_in_market_pct: r2((inBars / (to - from)) * 100),
  };
  return { stats, trades };
}

export function backtest(name: StrategyName, cs: Candle[], params: Record<string, number> = {}, feeBps = 60) {
  if (!STRATEGIES[name]) throw new Error(`Unknown strategy "${name}". Choose one of: ${Object.keys(STRATEGIES).join(', ')}`);
  if (cs.length < 60) throw new Error('Need at least 60 candles to backtest.');
  const p = { ...STRATEGIES[name].defaults, ...params };
  for (const [k, v] of Object.entries(p)) if (!Number.isFinite(v) || v <= 0) throw new Error(`Parameter ${k} must be a positive number.`);
  const sig = signals(name, cs, p);
  const split = Math.floor(cs.length * 0.7);
  const all = simulate(cs, sig, 0, cs.length, feeBps);
  const inS = simulate(cs, sig, 0, split, feeBps);
  const outS = simulate(cs, sig, split, cs.length, feeBps);

  const warnings: string[] = [];
  if (all.stats.trades < 10) warnings.push(`Only ${all.stats.trades} trades: too few to tell skill from luck.`);
  if (inS.stats.total_return_pct > inS.stats.buy_and_hold_pct && outS.stats.total_return_pct < outS.stats.buy_and_hold_pct)
    warnings.push('Beat buy-and-hold in-sample but not out-of-sample: likely overfitted.');
  if (outS.stats.total_return_pct < 0) warnings.push('Lost money on the out-of-sample period.');
  if (all.stats.max_drawdown_pct > 40) warnings.push(`Max drawdown of ${all.stats.max_drawdown_pct}% would be hard to sit through.`);

  return {
    strategy: name,
    params: p,
    fee_bps_per_side: feeBps,
    rules: STRATEGIES[name].about + ' Fills at the next candle open; long only.',
    full: all.stats,
    in_sample: inS.stats,
    out_of_sample: outS.stats,
    verdict: warnings.length ? 'Not proven. See warnings.' : 'Held up out-of-sample. Paper trade it before trusting it.',
    warnings,
    last_trades: all.trades.slice(-10),
  };
}
