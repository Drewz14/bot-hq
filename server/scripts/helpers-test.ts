/**
 * Offline test of helper access: invites, sign-in, what a helper can and can't reach, routine runs,
 * reviews, redaction and removal. Uses a throwaway database and calls the routes in-process.
 *
 *   cd server
 *   npx tsx scripts/helpers-test.ts
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helpers-test-'));
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'), XAI_API_KEY: 'test', COMPOSIO_API_KEY: 'test', ORGO_API_KEY: 'test',
  ORGO_COMPUTER_ID: '00000000-0000-0000-0000-000000000000', SESSION_SECRET: 'test-secret-test-secret-test-secret',
  DEV_LOGIN: '1', ALLOWED_EMAILS: 'scientist@lab.org',
});

const { Hono } = await import('hono');
const { db, now } = await import('../src/db.js');
const { initSubagents } = await import('../src/agent/subagents.js');
const { initRooms } = await import('../src/agent/rooms.js');
initSubagents();
initRooms();
const { api } = await import('../src/routes.js');
const { helperApi, helpersApi } = await import('../src/routes-helpers.js');
const { toolMap } = await import('../src/agent/tools.js');
const { redact } = await import('../src/helpers.js');

const app = new Hono();
app.route('/api/helper', helperApi);
app.route('/api/helpers', helpersApi);
app.route('/api', api);

// An owner with two bots and a routine on each, made directly so no agent engine starts.
db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES ('usr_owner','scientist@lab.org','Dr Lee','owner',?)").run(now());
for (const [id, name] of [['bot_bio', 'BioBot'], ['bot_quant', 'Quant']])
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, 'usr_owner', name, now(), now());
db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES ('rt_bio','bot_bio','Score new variants','SECRET PROMPT with patient cohort details','0 9 * * 1',?)").run(now());
db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES ('rt_quant','bot_quant','Rebalance','x','0 9 * * 1',?)").run(now());
db.prepare("INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES ('owner_tok','usr_owner',?,?)").run(now(), now() + 1e9);

const as = (cookie?: string) => async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
};
const owner = as('grokbot_session=owner_tok');
const anon = as();

let passed = 0;
const test = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };

await test('a stranger cannot sign in (not on the allowed list, not invited)', async () => {
  const r = await anon('POST', '/api/auth/dev', { email: 'volunteer@gmail.com' });
  assert.equal(r.status, 403);
});

await test('owner invites a helper to one bot', async () => {
  const bad = await owner('POST', '/api/helpers/invite', { email: 'volunteer@gmail.com', botIds: ['bot_someone_elses'] });
  assert.equal(bad.status, 400);
  const self = await owner('POST', '/api/helpers/invite', { email: 'scientist@lab.org', botIds: ['bot_bio'] });
  assert.equal(self.status, 400);
  const r = await owner('POST', '/api/helpers/invite', { email: 'Volunteer@Gmail.com', botIds: ['bot_bio'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.botIds, ['bot_bio']);
});

let helper: ReturnType<typeof as>;
await test('the invited helper can sign in, gets a helper account and no bot', async () => {
  const before = (db.prepare('SELECT COUNT(*) n FROM bots').get() as any).n;
  const r = await anon('POST', '/api/auth/dev', { email: 'volunteer@gmail.com', name: 'Sam' });
  assert.equal(r.status, 200);
  const cookie = r.setCookie!.split(';')[0];
  helper = as(cookie);
  const me = await helper('GET', '/api/auth/me');
  assert.equal(me.json.user.role, 'helper');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM bots').get() as any).n, before);
});

await test('a helper is locked out of everything owners use', async () => {
  for (const [m, u] of [['GET', '/api/bots'], ['GET', '/api/bots/bot_bio/rows'], ['POST', '/api/bots/bot_bio/messages'], ['GET', '/api/helpers'], ['GET', '/api/bots/bot_bio/memories'], ['GET', '/api/computer']] as const) {
    const r = await helper(m, u, m === 'POST' ? { text: 'hi' } : undefined);
    assert.ok(r.status === 403 || r.status === 404, `${m} ${u} gave ${r.status}`);
    assert.notEqual(r.status, 200);
  }
});

await test('an owner is kept off the helper page', async () => {
  assert.equal((await owner('GET', '/api/helper/home')).status, 403);
});

await test('helper sees the bot but no routines until the owner approves one', async () => {
  const r = await helper('GET', '/api/helper/home');
  assert.equal(r.status, 200);
  assert.equal(r.json.projects.length, 1);
  assert.equal(r.json.projects[0].bot.name, 'BioBot');
  assert.equal(r.json.projects[0].owner, 'Dr Lee');
  assert.equal(r.json.projects[0].routines.length, 0);
  const run = await helper('POST', '/api/helper/routines/rt_bio/run');
  assert.equal(run.status, 403);
});

await test('owner marks a routine safe; helper can run it but never sees its instructions', async () => {
  assert.equal((await owner('POST', '/api/helpers/routines/rt_bio', { forHelpers: true })).status, 200);
  assert.equal((await owner('POST', '/api/helpers/routines/rt_quant', { forHelpers: true })).status, 200);
  const r = await helper('GET', '/api/helper/home');
  assert.deepEqual(r.json.projects[0].routines.map((x: any) => x.name), ['Score new variants']);
  assert.ok(!JSON.stringify(r.json).includes('SECRET PROMPT'));
  // A bot the helper wasn't invited to stays off limits, even with an approved routine.
  assert.equal((await helper('POST', '/api/helper/routines/rt_quant/run')).status, 403);
  const run = await helper('POST', '/api/helper/routines/rt_bio/run');
  assert.equal(run.status, 200);
  const ev = db.prepare("SELECT body FROM rows WHERE bot_id='bot_bio' AND body LIKE '%helper-run%'").get() as any;
  assert.match(ev.body, /Sam \(helper\) started routine/);
});

await test('helper runs are capped each day', async () => {
  for (let i = 0; i < 9; i++) assert.equal((await helper('POST', '/api/helper/routines/rt_bio/run')).status, 200);
  const r = await helper('POST', '/api/helper/routines/rt_bio/run');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /today/);
});

await test('personal details are blanked out', () => {
  const r = redact('Patient MRN: 88123-A, DOB 1961-04-02, call (555) 123-4567 or jo@x.com, lives at 12 Oak Street. SSN 123-45-6789. Variant rs123 raised expression 2.3x.');
  for (const leak of ['88123', '1961-04-02', '555', 'jo@x.com', 'Oak Street', '123-45-6789']) assert.ok(!r.text.includes(leak), leak);
  assert.match(r.text, /rs123 raised expression 2\.3x/);
  assert.equal(r.count, 6);
});

let resultId = '';
await test('a bot shares a result; it is redacted and shown to the helper', async () => {
  const share = toolMap.get('share_with_helpers')!;
  assert.ok(share.approval, 'sharing asks the owner first');
  assert.match(share.approval!({ title: 'Week 3: T cells' }), /^Helpers: share “Week 3 – T cells” with your helpers$/);
  const out = JSON.parse((await share.impl({ title: 'Week 3', body: 'Strong effect in T cells. Contact jo@x.com.' }, { userId: 'usr_owner', botId: 'bot_bio', enqueueBotMessage: () => {}, depth: 0 })).output);
  assert.equal(out.redactions, 1);
  resultId = out.id;
  const home = await helper('GET', '/api/helper/home');
  const res = home.json.projects[0].results[0];
  assert.equal(res.title, 'Week 3');
  assert.ok(!res.body.includes('jo@x.com'));
});

await test('helper reviews; the bot reads it; the owner sees it in the log', async () => {
  assert.equal((await helper('POST', `/api/helper/results/${resultId}/review`, { verdict: 'maybe' })).status, 400);
  assert.equal((await helper('POST', `/api/helper/results/${resultId}/review`, { verdict: 'disagree', note: 'B cells look stronger in fig 2' })).status, 200);
  const reviews = JSON.parse((await toolMap.get('read_helper_reviews')!.impl({}, { userId: 'usr_owner', botId: 'bot_bio', enqueueBotMessage: () => {}, depth: 0 })).output);
  assert.equal(reviews.reviews[0].verdict, 'disagree');
  assert.equal(reviews.reviews[0].helper, 'Sam');
  const ov = await owner('GET', '/api/helpers');
  assert.equal(ov.json.helpers[0].joined, true);
  assert.equal(ov.json.results[0].reviews.disagree, 1);
  assert.ok(ov.json.log.some((l: any) => l.action === 'ran routine'));
  assert.ok(ov.json.log.some((l: any) => l.action === 'reviewed'));
});

await test('removing a helper signs them out at once', async () => {
  assert.equal((await owner('DELETE', '/api/helpers/people/volunteer@gmail.com')).status, 200);
  assert.equal((await helper('GET', '/api/helper/home')).status, 401);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM helper_reviews').get() as any).n, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
process.exit(0);
