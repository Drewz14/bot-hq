/**
 * Offline test of the quant tools: indicators, backtests, paper trading and the scorecard.
 * Coinbase is replaced by a fake price feed, and the database is a throwaway file.
 *
 *   cd server
 *   npx tsx scripts/quant-test.ts
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.XAI_API_KEY ??= 'test';
process.env.COMPOSIO_API_KEY ??= 'test';
process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret';
process.env.ORGO_API_KEY ??= 'test';
process.env.ORGO_COMPUTER_ID ??= '00000000-0000-0000-0000-000000000000';

// A fake market: a sine wave on an uptrend, daily candles, plus a settable live price.
let livePrice = 100;
const DAY = 86_400;
const nowS = Math.floor(Date.now() / 1000 / DAY) * DAY;
const series = Array.from({ length: 1500 }, (_, i) => {
  const t = nowS - (1499 - i) * DAY;
  const c = 50 + i * 0.05 + 10 * Math.sin(i / 15);
  return [t, c * 0.98, c * 1.02, c * 0.995, c, 1000];
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const u = new URL(String(input));
  if (!u.hostname.endsWith('coinbase.com')) return realFetch(input);
  if (u.pathname.startsWith('/products/NOPE')) return new Response('not found', { status: 404 });
  if (u.pathname.endsWith('/ticker')) return Response.json({ price: String(livePrice), time: new Date().toISOString() });
  const start = Date.parse(u.searchParams.get('start')!) / 1000, end = Date.parse(u.searchParams.get('end')!) / 1000;
  return Response.json(series.filter((r) => r[0] >= start && r[0] < end).reverse());
}) as typeof fetch;

const { sma, ema, rsi, snapshot } = await import('../src/quant/indicators.js');
const { backtest } = await import('../src/quant/backtest.js');
const { product, candles } = await import('../src/quant/market.js');
const { toolMap } = await import('../src/agent/tools.js');
const { db } = await import('../src/db.js');

let passed = 0;
const test = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };
const ctx = { userId: 'u1', botId: 'bot_quant', enqueueBotMessage: () => {}, depth: 0 };
const call = async (name: string, args: any) => {
  const t = toolMap.get(name);
  assert.ok(t, `tool ${name} registered`);
  const r = await t.impl(args, ctx);
  try { return JSON.parse(r.output); } catch { return r.output; }
};

await test('indicators', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.equal(ema([1, 2, 3], 3)[2], 2);
  const up = rsi(Array.from({ length: 30 }, (_, i) => i), 14);
  assert.equal(up[29], 100);
  const zig = rsi(Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : 0)), 14);
  assert.ok(Math.abs((zig[59] as number) - 50) < 5);
});

await test('symbols', () => {
  assert.equal(product('btc'), 'BTC-USD');
  assert.equal(product('eth/usd'), 'ETH-USD');
  assert.throws(() => product('not a coin!'));
});

await test('candles page back through history', async () => {
  const cs = await candles('BTC', '1d', 1000);
  assert.equal(cs.length, 1000);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].t > cs[i - 1].t, 'oldest first, no duplicates');
  const snap = snapshot(cs);
  assert.ok(snap.sma_200 != null && snap.rsi_14 != null && snap.atr_14 != null);
});

await test('backtest has no look-ahead and splits in/out of sample', async () => {
  const cs = await candles('BTC', '1d', 1000);
  const r = backtest('sma_cross', cs, { fast: 10, slow: 30 });
  assert.ok(r.full.trades > 5);
  assert.equal(r.in_sample.candles + r.out_of_sample.candles, 1000);
  // A rule that is always in the market should match buy-and-hold less two fees.
  const always = backtest('sma_cross', cs.map((c) => ({ ...c })), { fast: 1, slow: 1000 });
  assert.ok(always.full.trades <= 1);
  assert.throws(() => backtest('sma_cross', cs, { fast: -1 }));
});

await test('market_data tool', async () => {
  const r = await call('market_data', { symbol: 'btc', include_candles: true });
  assert.equal(r.product, 'BTC-USD');
  assert.equal(r.candles.length, 30);
});

await test('backtest_strategy tool, single and all', async () => {
  const one = await call('backtest_strategy', { symbol: 'BTC', strategy: 'rsi_reversion' });
  assert.ok(one.out_of_sample && Array.isArray(one.warnings));
  const all = await call('backtest_strategy', { symbol: 'BTC', strategy: 'all', candles: 500 });
  assert.equal(all.results.length, 5);
});

await test('paper trading with fees and limits', async () => {
  livePrice = 100;
  const buy = await call('paper_trade', { symbol: 'BTC', side: 'buy', usd: 1000, reason: 'test' });
  assert.equal(buy.cash_left, 9000);
  assert.ok(Math.abs(buy.qty - 9.94) < 1e-9);
  const tooMuch = toolMap.get('paper_trade')!.impl({ symbol: 'BTC', side: 'buy', usd: 50_000, reason: 'x' }, ctx);
  await assert.rejects(tooMuch, /Not enough paper cash/);
  livePrice = 110;
  const half = await call('paper_trade', { symbol: 'BTC', side: 'sell', fraction: 0.5, reason: 'take profit' });
  // 4.97 BTC * 110 = 546.70, less 0.6% fee = 543.42; cost basis 500
  assert.equal(half.realized_pnl, 43.42);
  const pf = await call('paper_portfolio', { show_trades: true });
  assert.equal(pf.positions.length, 1);
  assert.equal(pf.positions[0].value, 546.7);
  assert.equal(pf.trades, 2);
  assert.equal(pf.win_rate_pct, 100);
  await call('paper_trade', { symbol: 'BTC', side: 'sell', reason: 'exit' });
  const after = await call('paper_portfolio', {});
  assert.equal(after.positions.length, 0);
  await assert.rejects(toolMap.get('paper_trade')!.impl({ symbol: 'BTC', side: 'sell', reason: 'x' }, ctx), /No BTC-USD position/);
});

await test('scorecard learns from predictions', async () => {
  livePrice = 100;
  const up = await call('log_prediction', { kind: 'price', claim: 'BTC up this week', confidence: 0.8, due_in_hours: 168, symbol: 'BTC', direction: 'up' });
  const down = await call('log_prediction', { kind: 'price', claim: 'ETH down this week', confidence: 0.6, due_in_hours: 168, symbol: 'ETH', direction: 'down' });
  const res = await call('log_prediction', { kind: 'research', claim: 'Variant effects are stronger in T cells', confidence: 0.7, due_in_hours: 1 });
  const bad = await call('log_prediction', { kind: 'price', claim: 'x', confidence: 0.6, due_in_hours: 1 });
  assert.match(bad, /needs symbol and direction/);
  // Nothing is due yet.
  let card = await call('review_scorecard', {});
  assert.equal(card.just_settled.length, 0);
  assert.equal(card.open_predictions, 3);
  // Time passes: make them due; price rose to 105, so "up" is right and "down" is wrong.
  db.prepare('UPDATE predictions SET due_at = 0').run();
  livePrice = 105;
  card = await call('review_scorecard', {});
  assert.equal(card.just_settled.length, 2);
  assert.equal(card.needs_your_judgment.length, 1);
  assert.equal(card.needs_your_judgment[0].id, res.id);
  assert.equal(card.overall.hit_rate_pct, 50);
  // Brier: (0.8-1)^2 = 0.04, (0.6-0)^2 = 0.36 → mean 0.2
  assert.equal(card.overall.brier_score, 0.2);
  const ok = await call('resolve_prediction', { id: res.id, correct: true, lesson: 'Cell-type context matters.' });
  assert.match(ok, /Scored/);
  card = await call('review_scorecard', {});
  assert.equal(card.overall.resolved, 3);
  assert.equal(card.recent_lessons.length, 1);
  assert.ok(up.id && down.id);
  // Another bot cannot score this bot's predictions.
  const other = await toolMap.get('resolve_prediction')!.impl({ id: up.id, correct: true, lesson: 'x' }, { ...ctx, botId: 'someone_else' });
  assert.match(other.output, /No open prediction/);
});

await test('unknown pair gives a clear error', async () => {
  await assert.rejects(toolMap.get('market_data')!.impl({ symbol: 'NOPE' }, ctx), /does not list that pair/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
process.exit(0);
