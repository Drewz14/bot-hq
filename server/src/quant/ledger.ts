import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';

/**
 * Two things each bot keeps so it can learn from results:
 * - a paper-trading account (fake money, real prices), and
 * - a scorecard of predictions it made, checked later against what happened.
 * Nothing here can move real money.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS paper_accounts (
  bot_id TEXT PRIMARY KEY,
  cash REAL NOT NULL,
  start_cash REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_positions (
  bot_id TEXT NOT NULL,
  product TEXT NOT NULL,
  qty REAL NOT NULL,
  cost REAL NOT NULL,
  PRIMARY KEY (bot_id, product)
);
CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  product TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  realized REAL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_trades_bot ON paper_trades(bot_id, created_at);
CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  claim TEXT NOT NULL,
  product TEXT,
  direction TEXT,
  start_price REAL,
  confidence REAL NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  end_price REAL,
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS predictions_bot ON predictions(bot_id, status, due_at);
`);

export const START_CASH = 10_000;
export const FEE_RATE = 0.006; // 0.6% a side, about what a retail crypto exchange charges

const r = (v: number, d = 2) => Number(v.toFixed(d));

export function account(botId: string) {
  let a = db.prepare('SELECT * FROM paper_accounts WHERE bot_id=?').get(botId) as any;
  if (!a) {
    db.prepare('INSERT INTO paper_accounts(bot_id,cash,start_cash,created_at) VALUES (?,?,?,?)').run(botId, START_CASH, START_CASH, now());
    a = db.prepare('SELECT * FROM paper_accounts WHERE bot_id=?').get(botId);
  }
  return a as { bot_id: string; cash: number; start_cash: number; created_at: number };
}

export function positions(botId: string) {
  return db.prepare('SELECT product, qty, cost FROM paper_positions WHERE bot_id=? AND qty > 0 ORDER BY product').all(botId) as { product: string; qty: number; cost: number }[];
}

/** Fill a paper order at `price`. Buys spend `usd` (fee included); sells give up `fraction` (0–1] of the position. */
export const placeTrade = db.transaction((botId: string, product: string, side: 'buy' | 'sell', price: number, opts: { usd?: number; fraction?: number; reason?: string }) => {
  const a = account(botId);
  const pos = db.prepare('SELECT qty, cost FROM paper_positions WHERE bot_id=? AND product=?').get(botId, product) as { qty: number; cost: number } | undefined;
  let qty: number, fee: number, realized: number | null = null;
  if (side === 'buy') {
    const usd = Number(opts.usd);
    if (!(usd > 0)) throw new Error('Give a positive usd amount to buy.');
    if (usd > a.cash + 1e-9) throw new Error(`Not enough paper cash: $${r(a.cash)} available.`);
    fee = usd * FEE_RATE;
    qty = (usd - fee) / price;
    db.prepare('UPDATE paper_accounts SET cash = cash - ? WHERE bot_id=?').run(usd, botId);
    db.prepare(`INSERT INTO paper_positions(bot_id,product,qty,cost) VALUES (?,?,?,?)
      ON CONFLICT(bot_id,product) DO UPDATE SET qty = qty + excluded.qty, cost = cost + excluded.cost`).run(botId, product, qty, usd);
  } else {
    if (!pos || pos.qty <= 0) throw new Error(`No ${product} position to sell.`);
    const f = opts.fraction == null ? 1 : Number(opts.fraction);
    if (!(f > 0 && f <= 1)) throw new Error('fraction must be between 0 and 1.');
    qty = pos.qty * f;
    const gross = qty * price;
    fee = gross * FEE_RATE;
    const costPart = pos.cost * f;
    realized = gross - fee - costPart;
    db.prepare('UPDATE paper_accounts SET cash = cash + ? WHERE bot_id=?').run(gross - fee, botId);
    if (f >= 1) db.prepare('DELETE FROM paper_positions WHERE bot_id=? AND product=?').run(botId, product);
    else db.prepare('UPDATE paper_positions SET qty = qty - ?, cost = cost - ? WHERE bot_id=? AND product=?').run(qty, costPart, botId, product);
  }
  const id = newId('pt');
  db.prepare('INSERT INTO paper_trades(id,bot_id,product,side,qty,price,fee,realized,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, botId, product, side, qty, price, fee, realized, opts.reason ?? null, now());
  return { id, product, side, qty: r(qty, 8), price, fee: r(fee), realized_pnl: realized == null ? null : r(realized), cash_left: r(account(botId).cash) };
});

/** The account marked to the given prices. */
export function portfolio(botId: string, prices: Record<string, number>) {
  const a = account(botId);
  const held = positions(botId).map((p) => {
    const price = prices[p.product];
    const value = price ? p.qty * price : null;
    return {
      product: p.product,
      qty: r(p.qty, 8),
      avg_cost: r(p.cost / p.qty, 4),
      price: price ?? null,
      value: value == null ? null : r(value),
      unrealized_pnl: value == null ? null : r(value - p.cost),
      unrealized_pct: value == null ? null : r((value / p.cost - 1) * 100),
    };
  });
  const invested = held.reduce((s, h) => s + (h.value ?? 0), 0);
  const equity = a.cash + invested;
  const realized = (db.prepare('SELECT COALESCE(SUM(realized),0) s, COUNT(*) n FROM paper_trades WHERE bot_id=?').get(botId) as any);
  const closed = db.prepare("SELECT realized FROM paper_trades WHERE bot_id=? AND side='sell'").all(botId) as { realized: number }[];
  return {
    cash: r(a.cash),
    positions: held,
    equity: r(equity),
    total_return_pct: r((equity / a.start_cash - 1) * 100),
    realized_pnl: r(realized.s),
    trades: realized.n,
    closed_trades: closed.length,
    win_rate_pct: closed.length ? r((closed.filter((c) => c.realized > 0).length / closed.length) * 100) : null,
    started: new Date(a.created_at).toISOString().slice(0, 10),
    note: 'Paper money. Fees of 0.6% a side are included.',
  };
}

export function recentTrades(botId: string, limit = 20) {
  return (db.prepare('SELECT * FROM paper_trades WHERE bot_id=? ORDER BY created_at DESC LIMIT ?').all(botId, limit) as any[]).map((t) => ({
    when: new Date(t.created_at).toISOString(), product: t.product, side: t.side, qty: r(t.qty, 8), price: t.price,
    realized_pnl: t.realized == null ? null : r(t.realized), reason: t.reason,
  }));
}

export function resetAccount(botId: string) {
  db.prepare('DELETE FROM paper_positions WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM paper_trades WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM paper_accounts WHERE bot_id=?').run(botId);
  return account(botId);
}

// ---------- scorecard ----------

export interface NewPrediction {
  kind: 'price' | 'research' | 'other';
  claim: string;
  confidence: number;
  dueAt: number;
  product?: string;
  direction?: 'up' | 'down';
  startPrice?: number;
}

export function addPrediction(botId: string, p: NewPrediction) {
  const id = newId('pr');
  db.prepare('INSERT INTO predictions(id,bot_id,kind,claim,product,direction,start_price,confidence,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, botId, p.kind, p.claim, p.product ?? null, p.direction ?? null, p.startPrice ?? null, p.confidence, p.dueAt, now());
  return id;
}

/** Price predictions whose time is up, ready to be checked against the market. */
export function duePricePredictions(botId: string, at = now()) {
  return db.prepare("SELECT * FROM predictions WHERE bot_id=? AND status='open' AND kind='price' AND due_at<=?").all(botId, at) as any[];
}

/** Other predictions whose time is up: the bot has to judge these itself. */
export function dueOtherPredictions(botId: string, at = now()) {
  return (db.prepare("SELECT * FROM predictions WHERE bot_id=? AND status='open' AND kind!='price' AND due_at<=? ORDER BY due_at").all(botId, at) as any[])
    .map((p) => ({ id: p.id, kind: p.kind, claim: p.claim, confidence: p.confidence, made: new Date(p.created_at).toISOString().slice(0, 10) }));
}

export function resolvePrediction(botId: string, id: string, correct: boolean, opts: { endPrice?: number; note?: string } = {}) {
  const res = db.prepare("UPDATE predictions SET status=?, end_price=?, note=COALESCE(?, note), resolved_at=? WHERE id=? AND bot_id=? AND status='open'")
    .run(correct ? 'right' : 'wrong', opts.endPrice ?? null, opts.note ?? null, now(), id, botId);
  return res.changes > 0;
}

/** Hit rate, Brier score and calibration by confidence, over resolved predictions. */
export function scorecard(botId: string) {
  const rows = db.prepare("SELECT kind, confidence, status FROM predictions WHERE bot_id=? AND status IN ('right','wrong')").all(botId) as { kind: string; confidence: number; status: string }[];
  const open = (db.prepare("SELECT COUNT(*) n FROM predictions WHERE bot_id=? AND status='open'").get(botId) as any).n as number;
  const summarize = (xs: typeof rows) => {
    if (!xs.length) return null;
    const hits = xs.filter((x) => x.status === 'right').length;
    const brier = xs.reduce((s, x) => s + (x.confidence - (x.status === 'right' ? 1 : 0)) ** 2, 0) / xs.length;
    return { resolved: xs.length, right: hits, hit_rate_pct: r((hits / xs.length) * 100), brier_score: r(brier, 3) };
  };
  const buckets = [[0, 0.6], [0.6, 0.75], [0.75, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
    const xs = rows.filter((x) => x.confidence >= lo && x.confidence < hi);
    const hits = xs.filter((x) => x.status === 'right').length;
    return { confidence: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, predictions: xs.length, actually_right_pct: xs.length ? r((hits / xs.length) * 100) : null };
  }).filter((b) => b.predictions > 0);
  const lessons = db.prepare("SELECT claim, status, note FROM predictions WHERE bot_id=? AND status IN ('right','wrong') AND note IS NOT NULL ORDER BY resolved_at DESC LIMIT 10").all(botId);
  return {
    overall: summarize(rows),
    by_kind: Object.fromEntries(['price', 'research', 'other'].map((k) => [k, summarize(rows.filter((x) => x.kind === k))]).filter(([, v]) => v)),
    calibration: buckets,
    open_predictions: open,
    recent_lessons: lessons,
    how_to_read: 'Brier score: 0 is perfect, 0.25 is a coin flip; lower is better. Calibration: when you say 80%, you should be right about 80% of the time.',
  };
}
