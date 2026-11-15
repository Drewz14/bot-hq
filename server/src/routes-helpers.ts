import { Hono } from 'hono';
import { requireHelper, requireUser, type AuthVars } from './lib/auth.js';
import { appendRow } from './store.js';
import { runRoutine } from './routines.js';
import { audit, checkHelperRun, deleteResult, helperHome, invite, ownerOverview, removeHelper, review, setRoutineForHelpers } from './helpers.js';

/** The owner's side: who helps, with which bots, which routines they may run, what was shared. */
export const helpersApi = new Hono<AuthVars>();
helpersApi.use('*', requireUser);

helpersApi.get('/', (c) => c.json(ownerOverview(c.get('user').id)));

helpersApi.post('/invite', async (c) => {
  const { email, botIds } = await c.req.json<{ email: string; botIds: string[] }>();
  try {
    return c.json({ ok: true, ...invite(c.get('user').id, email, Array.isArray(botIds) ? botIds : []) });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

helpersApi.delete('/people/:email', (c) => (removeHelper(c.get('user').id, c.req.param('email')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));

helpersApi.post('/routines/:id', async (c) => {
  const { forHelpers } = await c.req.json<{ forHelpers: boolean }>();
  return setRoutineForHelpers(c.get('user').id, c.req.param('id'), !!forHelpers) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

helpersApi.delete('/results/:id', (c) => (deleteResult(c.get('user').id, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));

/** The helper's side. Only what helperHome returns ever leaves here. */
export const helperApi = new Hono<AuthVars>();
helperApi.use('*', requireHelper);

helperApi.get('/home', (c) => {
  const u = c.get('user');
  return c.json(helperHome(u.id, u.email));
});

helperApi.post('/routines/:id/run', (c) => {
  const u = c.get('user');
  const ok = checkHelperRun(u.email, c.req.param('id'));
  if ('error' in ok) return c.json({ error: ok.error }, 403);
  audit(ok.ownerId, u.email, 'ran routine', ok.name);
  appendRow(ok.botId, 'event', { type: 'event', event: 'helper-run', text: `${u.name} (helper) started routine: ${ok.name}` });
  runRoutine(c.req.param('id'));
  return c.json({ ok: true });
});

helperApi.post('/results/:id/review', async (c) => {
  const u = c.get('user');
  const { verdict, note } = await c.req.json<{ verdict: string; note?: string }>();
  try {
    return review(u.id, u.email, c.req.param('id'), verdict, note ?? '') ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
