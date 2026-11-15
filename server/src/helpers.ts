import { db, now } from './db.js';
import { newId } from './lib/ids.js';

/**
 * Helpers: people a scientist (an owner) invites to help with some of their bots, with limited access.
 *
 * A helper can:
 * - see the results a bot chose to share with helpers (each share needs the owner's OK unless they
 *   always allow it, and obvious personal details are blanked out first),
 * - review those results (agree / disagree / unsure, with a note) so the bot can learn from them,
 * - run the routines the owner marked as safe for helpers, a limited number of times a day.
 *
 * A helper cannot see a bot's chat, memory, files, screen, settings, or a routine's instructions,
 * and gets no bots of their own. Everything a helper does is written to the owner's audit log.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS helper_access (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, email, bot_id)
);
CREATE INDEX IF NOT EXISTS helper_access_email ON helper_access(email);
CREATE TABLE IF NOT EXISTS helper_results (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS helper_results_bot ON helper_results(bot_id, created_at);
CREATE TABLE IF NOT EXISTS helper_reviews (
  result_id TEXT NOT NULL REFERENCES helper_results(id) ON DELETE CASCADE,
  helper_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (result_id, helper_id)
);
CREATE TABLE IF NOT EXISTS helper_audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  helper_email TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS helper_audit_owner ON helper_audit(owner_id, created_at);
`);

/** Routine runs a helper may start in 24 hours, across all owners. Each run costs model usage. */
export const HELPER_RUNS_PER_DAY = 10;
export const VERDICTS = ['agree', 'disagree', 'unsure'] as const;
export type Verdict = (typeof VERDICTS)[number];

const DAY = 86_400_000;
const norm = (email: string) => String(email ?? '').trim().toLowerCase();

export function isInvitedHelper(email: string): boolean {
  return !!db.prepare('SELECT 1 FROM helper_access WHERE email=? LIMIT 1').get(norm(email));
}

export function audit(ownerId: string, helperEmail: string, action: string, detail = '') {
  db.prepare('INSERT INTO helper_audit(id,owner_id,helper_email,action,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(newId('ha'), ownerId, norm(helperEmail), action, detail.slice(0, 500), now());
}

// ---------- blanking out personal details ----------

const PATTERNS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id number]'],
  [/\b(?:MRN|medical record(?: number)?|patient id|chart(?: number)?)\s*[:#]?\s*[A-Z0-9-]{4,}/gi, '[record number]'],
  [/\b(?:DOB|date of birth|born)\s*[:#]?\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/gi, '[date of birth]'],
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]'],
  [/\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\b\.?/g, '[address]'],
];

/**
 * Blank out details that identify a person. This is a safety net, not a guarantee: the bot is told
 * to share only de-identified results, and the owner approves each share.
 */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = String(text ?? '');
  for (const [re, label] of PATTERNS) out = out.replace(re, () => { count++; return label; });
  return { text: out, count };
}

// ---------- what bots share ----------

export function shareResult(botId: string, title: string, body: string) {
  const t = redact(String(title).slice(0, 200));
  const b = redact(String(body).slice(0, 20_000));
  const id = newId('hr');
  db.prepare('INSERT INTO helper_results(id,bot_id,title,body,redactions,created_at) VALUES (?,?,?,?,?,?)').run(id, botId, t.text, b.text, t.count + b.count, now());
  return { id, redactions: t.count + b.count, helpers: (db.prepare('SELECT COUNT(DISTINCT email) n FROM helper_access WHERE bot_id=?').get(botId) as any).n as number };
}

export function reviewsFor(botId: string, resultId?: string) {
  const rows = db.prepare(`
    SELECT r.id result_id, r.title, v.verdict, v.note, v.created_at, u.name helper
    FROM helper_reviews v JOIN helper_results r ON r.id=v.result_id JOIN users u ON u.id=v.helper_id
    WHERE r.bot_id=? ${resultId ? 'AND r.id=?' : ''} ORDER BY v.created_at DESC LIMIT 100`).all(...(resultId ? [botId, resultId] : [botId])) as any[];
  return rows.map((r) => ({ result_id: r.result_id, result: r.title, helper: r.helper, verdict: r.verdict, note: r.note, when: new Date(r.created_at).toISOString() }));
}

// ---------- the owner's side ----------

export function invite(ownerId: string, email: string, botIds: string[]) {
  const e = norm(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('That does not look like an email address.');
  const owner = db.prepare('SELECT email FROM users WHERE id=?').get(ownerId) as any;
  if (owner && norm(owner.email) === e) throw new Error('You can’t invite yourself.');
  const existing = db.prepare('SELECT role FROM users WHERE lower(email)=?').get(e) as any;
  if (existing && existing.role !== 'helper') throw new Error('That person already has a full account here.');
  const own = db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").all(ownerId).map((b: any) => b.id as string);
  const ids = [...new Set(botIds)].filter((id) => own.includes(id));
  if (!ids.length) throw new Error('Pick at least one of your bots.');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM helper_access WHERE owner_id=? AND email=?').run(ownerId, e);
    for (const id of ids) db.prepare('INSERT INTO helper_access(owner_id,email,bot_id,created_at) VALUES (?,?,?,?)').run(ownerId, e, id, now());
  });
  tx();
  audit(ownerId, e, 'invited', `bots: ${ids.length}`);
  return { email: e, botIds: ids };
}

export function removeHelper(ownerId: string, email: string) {
  const e = norm(email);
  const n = db.prepare('DELETE FROM helper_access WHERE owner_id=? AND email=?').run(ownerId, e).changes;
  if (!n) return false;
  // Their reviews of this owner's results go too, and so does their sign-in if nobody else invited them.
  db.prepare(`DELETE FROM helper_reviews WHERE helper_id IN (SELECT id FROM users WHERE lower(email)=?)
    AND result_id IN (SELECT r.id FROM helper_results r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=?)`).run(e, ownerId);
  if (!isInvitedHelper(e)) db.prepare("DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email)=? AND role='helper')").run(e);
  audit(ownerId, e, 'removed');
  return true;
}

export function setRoutineForHelpers(ownerId: string, routineId: string, on: boolean) {
  const r = db.prepare('SELECT r.id FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(routineId, ownerId);
  if (!r) return false;
  db.prepare('UPDATE routines SET helper_runnable=? WHERE id=?').run(on ? 1 : 0, routineId);
  return true;
}

export function deleteResult(ownerId: string, resultId: string) {
  return db.prepare('DELETE FROM helper_results WHERE id=? AND bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(resultId, ownerId).changes > 0;
}

export function ownerOverview(ownerId: string) {
  const access = db.prepare(`SELECT a.email, a.bot_id, b.name bot_name, u.name helper_name, u.id helper_id
    FROM helper_access a JOIN bots b ON b.id=a.bot_id LEFT JOIN users u ON lower(u.email)=a.email AND u.role='helper'
    WHERE a.owner_id=? ORDER BY a.created_at`).all(ownerId) as any[];
  const helpers = new Map<string, { email: string; name: string | null; joined: boolean; bots: { id: string; name: string }[] }>();
  for (const a of access) {
    const h = helpers.get(a.email) ?? { email: a.email as string, name: (a.helper_name ?? null) as string | null, joined: !!a.helper_id, bots: [] as { id: string; name: string }[] };
    h.bots.push({ id: a.bot_id, name: a.bot_name });
    helpers.set(a.email, h);
  }
  const routines = (db.prepare(`SELECT r.id, r.name, r.bot_id, b.name bot_name, COALESCE(r.helper_runnable,0) h
    FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY b.name, r.name`).all(ownerId) as any[])
    .map((r) => ({ id: r.id, name: r.name, botId: r.bot_id, botName: r.bot_name, forHelpers: !!r.h }));
  const results = (db.prepare(`SELECT r.id, r.title, r.bot_id, b.name bot_name, r.redactions, r.created_at,
      SUM(v.verdict='agree') agree, SUM(v.verdict='disagree') disagree, SUM(v.verdict='unsure') unsure
    FROM helper_results r JOIN bots b ON b.id=r.bot_id LEFT JOIN helper_reviews v ON v.result_id=r.id
    WHERE b.user_id=? GROUP BY r.id ORDER BY r.created_at DESC LIMIT 50`).all(ownerId) as any[])
    .map((r) => ({ id: r.id, title: r.title, botName: r.bot_name, redactions: r.redactions, createdAt: r.created_at, reviews: { agree: r.agree ?? 0, disagree: r.disagree ?? 0, unsure: r.unsure ?? 0 } }));
  const log = (db.prepare('SELECT helper_email, action, detail, created_at FROM helper_audit WHERE owner_id=? ORDER BY created_at DESC LIMIT 50').all(ownerId) as any[])
    .map((l) => ({ email: l.helper_email, action: l.action, detail: l.detail, at: l.created_at }));
  return { helpers: [...helpers.values()], routines, results, log, runsPerDay: HELPER_RUNS_PER_DAY };
}

// ---------- the helper's side ----------

/** The bots a helper was invited to, grouped with what they may see and do. Nothing else. */
export function helperHome(helperId: string, email: string) {
  const e = norm(email);
  const bots = db.prepare(`SELECT DISTINCT b.id, b.name, b.label, b.avatar_shape, b.avatar_color, u.name owner_name
    FROM helper_access a JOIN bots b ON b.id=a.bot_id JOIN users u ON u.id=a.owner_id WHERE a.email=? ORDER BY b.name`).all(e) as any[];
  const projects = bots.map((b) => ({
    bot: { id: b.id, name: b.name, label: b.label, avatarShape: b.avatar_shape, avatarColor: b.avatar_color },
    owner: b.owner_name,
    routines: (db.prepare('SELECT id, name, last_run_at FROM routines WHERE bot_id=? AND helper_runnable=1 ORDER BY name').all(b.id) as any[])
      .map((r) => ({ id: r.id, name: r.name, lastRunAt: r.last_run_at })),
    results: (db.prepare(`SELECT r.id, r.title, r.body, r.created_at, v.verdict, v.note FROM helper_results r
      LEFT JOIN helper_reviews v ON v.result_id=r.id AND v.helper_id=? WHERE r.bot_id=? ORDER BY r.created_at DESC LIMIT 30`).all(helperId, b.id) as any[])
      .map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at, myReview: r.verdict ? { verdict: r.verdict, note: r.note } : null })),
  }));
  return { projects, runsLeftToday: runsLeft(e), runsPerDay: HELPER_RUNS_PER_DAY };
}

function runsLeft(email: string) {
  const used = (db.prepare("SELECT COUNT(*) n FROM helper_audit WHERE helper_email=? AND action='ran routine' AND created_at>?").get(norm(email), now() - DAY) as any).n as number;
  return Math.max(0, HELPER_RUNS_PER_DAY - used);
}

/** Checks a helper may run this routine now. Returns the owner, or an error message. */
export function checkHelperRun(email: string, routineId: string): { ownerId: string; botId: string; name: string } | { error: string } {
  const e = norm(email);
  const r = db.prepare(`SELECT r.id, r.name, r.bot_id, a.owner_id FROM routines r JOIN helper_access a ON a.bot_id=r.bot_id AND a.email=?
    WHERE r.id=? AND r.helper_runnable=1`).get(e, routineId) as any;
  if (!r) return { error: 'You can’t run that routine.' };
  if (runsLeft(e) <= 0) return { error: `You’ve used today’s ${HELPER_RUNS_PER_DAY} runs. Try again tomorrow.` };
  return { ownerId: r.owner_id, botId: r.bot_id, name: r.name };
}

export function review(helperId: string, email: string, resultId: string, verdict: string, note: string) {
  if (!VERDICTS.includes(verdict as Verdict)) throw new Error('Pick agree, disagree or unsure.');
  const r = db.prepare(`SELECT r.id, r.title, a.owner_id FROM helper_results r JOIN helper_access a ON a.bot_id=r.bot_id AND a.email=? WHERE r.id=?`).get(norm(email), resultId) as any;
  if (!r) return false;
  db.prepare(`INSERT INTO helper_reviews(result_id,helper_id,verdict,note,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(result_id,helper_id) DO UPDATE SET verdict=excluded.verdict, note=excluded.note, created_at=excluded.created_at`)
    .run(resultId, helperId, verdict, redact(String(note ?? '').slice(0, 2000)).text, now());
  audit(r.owner_id, email, 'reviewed', `${verdict}: ${r.title}`);
  return true;
}
