import type { ToolDef } from './tools.js';
import { snapshot } from '../quant/indicators.js';
import { backtest, STRATEGIES, type StrategyName } from '../quant/backtest.js';
import { candles, INTERVALS, lastPrice, product } from '../quant/market.js';
import {
  addPrediction, dueOtherPredictions, duePricePredictions, placeTrade, portfolio, positions, recentTrades, resolvePrediction, scorecard,
} from '../quant/ledger.js';

/**
 * Tools for research on crypto markets, paper trading, and a scorecard that lets any bot learn
 * from how its past calls turned out. No tool here touches real money.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const json = (v: unknown) => JSON.stringify(v, null, 1);
const HOUR = 3_600_000;

const symbolProp = { type: 'string', description: 'Coin or pair, e.g. BTC, ETH, SOL-USD.' };
const intervalProp = { type: 'string', enum: Object.keys(INTERVALS), description: 'Candle size. Default 1d.' };

/** Check due price predictions against live prices. Returns how many were settled. */
async function settleDuePrices(botId: string) {
  const due = duePricePredictions(botId);
  const settled: unknown[] = [];
  const cache: Record<string, number> = {};
  for (const p of due) {
    try {
      cache[p.product] ??= (await lastPrice(p.product)).price;
      const end = cache[p.product];
      const correct = p.direction === 'up' ? end > p.start_price : end < p.start_price;
      resolvePrediction(botId, p.id, correct, { endPrice: end });
      settled.push({ claim: p.claim, product: p.product, direction: p.direction, start: p.start_price, end, result: correct ? 'right' : 'wrong', confidence: p.confidence });
    } catch { /* price unavailable: try again at the next review */ }
  }
  return settled;
}

export const QUANT_TOOLS: ToolDef[] = [
  {
    name: 'market_data',
    description: 'Live crypto prices with technical analysis: price, % change, moving averages (20/50/200), trend, RSI, MACD, Bollinger bands, ATR, recent high and low. Free Coinbase data. Set include_candles to also get the last 30 candles.',
    parameters: obj({ symbol: symbolProp, interval: intervalProp, include_candles: { type: 'boolean' } }, ['symbol']),
    activity: 'working',
    label: 'Checking the market',
    impl: async (a) => {
      const cs = await candles(a.symbol, a.interval || '1d', 260);
      if (!cs.length) return { output: 'No candles came back for that pair.' };
      const out: Record<string, unknown> = { product: product(a.symbol), interval: a.interval || '1d', as_of: new Date(cs[cs.length - 1].t).toISOString(), ...snapshot(cs) };
      if (a.include_candles) out.candles = cs.slice(-30).map((c) => ({ time: new Date(c.t).toISOString(), open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
      return { output: json(out), summary: `Checked ${product(a.symbol)}` };
    },
  },
  {
    name: 'backtest_strategy',
    description: `Test a trading rule on past prices before trusting it. Strategies: ${Object.entries(STRATEGIES).map(([k, v]) => `${k} (${v.about} Defaults ${JSON.stringify(v.defaults)})`).join('; ')}. Use strategy "all" to compare every one with default settings. Results come split into in-sample (first 70%) and out-of-sample (last 30%): only trust a rule that also works out-of-sample, and don't keep tweaking parameters until it looks good, because that just fits noise.`,
    parameters: obj({
      symbol: symbolProp,
      strategy: { type: 'string', enum: [...Object.keys(STRATEGIES), 'all'] },
      params: { type: 'object', additionalProperties: { type: 'number' }, description: 'Override default parameters.' },
      interval: intervalProp,
      candles: { type: 'number', description: 'How much history, 100–1500 candles. Default 1000.' },
      fee_bps: { type: 'number', description: 'Fee per side in basis points. Default 60 (0.6%).' },
    }, ['symbol', 'strategy']),
    activity: 'working',
    label: 'Backtesting',
    impl: async (a) => {
      const cs = await candles(a.symbol, a.interval || '1d', Math.max(100, Number(a.candles) || 1000));
      const fee = Number.isFinite(a.fee_bps) && a.fee_bps >= 0 ? a.fee_bps : 60;
      if (a.strategy === 'all') {
        const rows = (Object.keys(STRATEGIES) as StrategyName[]).map((s) => {
          const r = backtest(s, cs, {}, fee);
          return { strategy: s, full_return_pct: r.full.total_return_pct, out_of_sample_pct: r.out_of_sample.total_return_pct, out_of_sample_buy_hold_pct: r.out_of_sample.buy_and_hold_pct, max_drawdown_pct: r.full.max_drawdown_pct, trades: r.full.trades, verdict: r.verdict };
        });
        return { output: json({ product: product(a.symbol), candles: cs.length, from: new Date(cs[0].t).toISOString().slice(0, 10), results: rows }), summary: `Compared strategies on ${product(a.symbol)}` };
      }
      const r = backtest(a.strategy, cs, a.params ?? {}, fee);
      return { output: json({ product: product(a.symbol), ...r }), summary: `Backtested ${a.strategy} on ${product(a.symbol)}` };
    },
  },
  {
    name: 'paper_trade',
    description: 'Buy or sell with PAPER money (a practice account that starts at $10,000) at the live price, with fees. Use this to prove a strategy before anyone risks real money. Always give the reason. Buy with `usd`; sell with `fraction` of the position (1 = all). Also log a prediction for the trade with log_prediction so it counts on your scorecard.',
    parameters: obj({
      symbol: symbolProp,
      side: { type: 'string', enum: ['buy', 'sell'] },
      usd: { type: 'number', description: 'Dollars to spend, for a buy.' },
      fraction: { type: 'number', description: 'Share of the position to sell, 0–1. Default 1.' },
      reason: { type: 'string', description: 'Why, in a sentence: the signal and the plan.' },
    }, ['symbol', 'side', 'reason']),
    activity: 'working',
    label: 'Paper trading',
    impl: async (a, ctx) => {
      const { product: p, price } = await lastPrice(a.symbol);
      const t = placeTrade(ctx.botId, p, a.side, price, { usd: a.usd, fraction: a.fraction, reason: a.reason });
      return { output: json(t), summary: `Paper ${a.side} ${p} at $${price}` };
    },
  },
  {
    name: 'paper_portfolio',
    description: 'Your paper-trading account: cash, positions at live prices, total return, win rate, and (with show_trades) your recent trades and the reasons you gave.',
    parameters: obj({ show_trades: { type: 'boolean' } }),
    activity: 'working',
    label: 'Checking the portfolio',
    impl: async (a, ctx) => {
      const prices: Record<string, number> = {};
      for (const p of positions(ctx.botId)) {
        try { prices[p.product] = (await lastPrice(p.product)).price; } catch { /* shown without a price */ }
      }
      const out: Record<string, unknown> = portfolio(ctx.botId, prices);
      if (a.show_trades) out.recent_trades = recentTrades(ctx.botId);
      return { output: json(out), summary: 'Checked the paper portfolio' };
    },
  },
  {
    name: 'log_prediction',
    description: 'Write down a prediction so it can be checked later; this is how you get better over time. kind "price": give symbol and direction and it is scored automatically against the market when due. kind "research" or "other": any claim you can later judge right or wrong (e.g. "gene X variants will show stronger effects in T cells than B cells"). Confidence is 0–1: be honest, since calibration is scored.',
    parameters: obj({
      kind: { type: 'string', enum: ['price', 'research', 'other'] },
      claim: { type: 'string', description: 'The prediction in one sentence.' },
      confidence: { type: 'number', description: '0.5 = coin flip, 0.9 = very sure.' },
      due_in_hours: { type: 'number', description: 'When to check it. e.g. 24, 168 (a week).' },
      symbol: symbolProp,
      direction: { type: 'string', enum: ['up', 'down'] },
    }, ['kind', 'claim', 'confidence', 'due_in_hours']),
    activity: 'remembering',
    label: 'Logging a prediction',
    impl: async (a, ctx) => {
      const conf = Number(a.confidence);
      if (!(conf >= 0 && conf <= 1)) return { output: 'confidence must be between 0 and 1.' };
      const hours = Number(a.due_in_hours);
      if (!(hours > 0 && hours <= 24 * 366)) return { output: 'due_in_hours must be between 0 and a year.' };
      let startPrice: number | undefined, prod: string | undefined;
      if (a.kind === 'price') {
        if (!a.symbol || !a.direction) return { output: 'A price prediction needs symbol and direction.' };
        const lp = await lastPrice(a.symbol);
        startPrice = lp.price; prod = lp.product;
      }
      const id = addPrediction(ctx.botId, { kind: a.kind, claim: String(a.claim).slice(0, 1000), confidence: conf, dueAt: Date.now() + hours * HOUR, product: prod, direction: a.direction, startPrice });
      return { output: json({ ok: true, id, start_price: startPrice ?? null, due: new Date(Date.now() + hours * HOUR).toISOString() }), summary: 'Logged a prediction' };
    },
  },
  {
    name: 'review_scorecard',
    description: 'Review how your past predictions turned out. Settles due price predictions against live prices, then shows hit rate, Brier score, calibration, and research predictions that are due for you to judge with resolve_prediction. Afterwards, save the lessons (what worked, what to stop doing) to your memory. Good to run as a weekly routine.',
    parameters: obj({}),
    activity: 'remembering',
    label: 'Reviewing the scorecard',
    impl: async (_a, ctx) => {
      const settled = await settleDuePrices(ctx.botId);
      const out = { just_settled: settled, needs_your_judgment: dueOtherPredictions(ctx.botId), ...scorecard(ctx.botId) };
      return { output: json(out), summary: 'Reviewed the scorecard' };
    },
  },
  {
    name: 'resolve_prediction',
    description: 'Mark a research or other prediction right or wrong once you know, with the lesson learned. Price predictions are settled automatically by review_scorecard.',
    parameters: obj({ id: { type: 'string' }, correct: { type: 'boolean' }, lesson: { type: 'string', description: 'What this teaches you, in a sentence.' } }, ['id', 'correct', 'lesson']),
    activity: 'remembering',
    label: 'Scoring a prediction',
    impl: async (a, ctx) => {
      const ok = resolvePrediction(ctx.botId, String(a.id), Boolean(a.correct), { note: String(a.lesson ?? '').slice(0, 1000) });
      return { output: ok ? 'Scored. Save the lesson to your memory too.' : 'No open prediction of yours has that id.', summary: ok ? 'Scored a prediction' : undefined };
    },
  },
];
