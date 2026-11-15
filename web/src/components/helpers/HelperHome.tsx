import { useCallback, useEffect, useState } from 'react';
import { BotAvatar } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { helpersApi, type HelperHome as Home, type HelperProject, type Verdict } from '../../lib/helpersApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { Markdown } from '../Markdown';
import '../../styles/config.css';
import '../../styles/helpers.css';

const VERDICTS: { value: Verdict; label: string }[] = [
  { value: 'agree', label: 'Looks right' },
  { value: 'disagree', label: 'Looks wrong' },
  { value: 'unsure', label: 'Not sure' },
];

/** What a helper sees: the bots they were invited to help, shared results to review, and approved routines. */
export function HelperHome() {
  const user = useStore((s) => s.user);
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => helpersApi.home().then(setHome).catch((e) => setError(String(e.message ?? e))), []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  return (
    <div className="helper">
      <header className="helper__top">
        <div>
          <div className="helper__eyebrow">Helper</div>
          <h1 className="helper__title">Hi {user?.name ?? 'there'}</h1>
        </div>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={async () => { await configApi.logout().catch(() => {}); location.reload(); }}>Sign out</button>
      </header>
      <p className="helper__intro">
        You’re helping with research bots. Review the results they share, and run the jobs you’ve been allowed to run.
        You only see what a bot chose to share: never its chats, files or private data.
      </p>
      {error && <div className="helper__error" role="alert">{error}</div>}
      {!home ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : home.projects.length === 0 ? (
        <div className="cfg-empty cfg-empty--flat">Nobody has invited you to a bot yet, or your access was removed.</div>
      ) : (
        <>
          <div className="helper__runs">{home.runsLeftToday} of {home.runsPerDay} runs left today</div>
          {home.projects.map((p) => <Project key={p.bot.id} p={p} canRun={home.runsLeftToday > 0} onChange={load} />)}
        </>
      )}
    </div>
  );
}

function Project({ p, canRun, onChange }: { p: HelperProject; canRun: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const run = async (id: string) => {
    setBusy(id); setNote('');
    try { await helpersApi.run(id); setNote('Started. The bot will share results when it’s done.'); onChange(); }
    catch (e: any) { setNote(e.message); }
    finally { setBusy(null); }
  };
  return (
    <section className="helper__project">
      <div className="helper__bot">
        <BotAvatar shape={p.bot.avatarShape} color={p.bot.avatarColor} size={36} />
        <div>
          <div className="helper__bot-name">{p.bot.name}</div>
          <div className="helper__bot-sub">{p.bot.label ? `${p.bot.label} · ` : ''}run by {p.owner}</div>
        </div>
      </div>

      {p.routines.length > 0 && (
        <div className="cfg-card helper__card">
          <div className="helper__card-title">Jobs you can run</div>
          {p.routines.map((r) => (
            <div key={r.id} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{r.name}</div>
                <div className="cfg-row__sub">{r.lastRunAt ? `Last run ${relativeShort(r.lastRunAt)}` : 'Not run yet'}</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={!canRun || busy === r.id} onClick={() => run(r.id)}>{busy === r.id ? 'Starting…' : 'Run'}</button>
            </div>
          ))}
          {note && <div className="helper__note" role="status">{note}</div>}
        </div>
      )}

      <div className="helper__card-title helper__card-title--outside">Results to review</div>
      {p.results.length === 0 ? <div className="cfg-empty cfg-empty--flat">Nothing shared yet.</div> : p.results.map((r) => <Result key={r.id} r={r} onChange={onChange} />)}
    </section>
  );
}

function Result({ r, onChange }: { r: HelperProject['results'][number]; onChange: () => void }) {
  const [open, setOpen] = useState(!r.myReview);
  const [verdict, setVerdict] = useState<Verdict | null>(r.myReview?.verdict ?? null);
  const [text, setText] = useState(r.myReview?.note ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle');
  const save = async () => {
    if (!verdict) return;
    setState('saving');
    try { await helpersApi.review(r.id, verdict, text); setState('saved'); onChange(); }
    catch (e: any) { setState(e.message); }
  };
  return (
    <article className="cfg-card helper__result">
      <button type="button" className="helper__result-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="helper__result-title">{r.title}</span>
        <span className="helper__result-meta">{r.myReview ? <span className="cfg-chip">Reviewed</span> : <span className="cfg-chip cfg-chip--muted">Needs review</span>} {relativeShort(r.createdAt)}</span>
      </button>
      {open && (
        <div className="helper__result-body">
          <div className="helper__md"><Markdown text={r.body} /></div>
          <div className="helper__verdicts" role="radiogroup" aria-label="Your verdict">
            {VERDICTS.map((v) => (
              <button key={v.value} type="button" role="radio" aria-checked={verdict === v.value} className={`helper__verdict helper__verdict--${v.value}${verdict === v.value ? ' is-on' : ''}`} onClick={() => setVerdict(v.value)}>{v.label}</button>
            ))}
          </div>
          <textarea className="text-input helper__textarea" placeholder="What did you notice? (optional)" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          <div className="helper__actions">
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={!verdict || state === 'saving'} onClick={save}>{state === 'saving' ? 'Saving…' : r.myReview ? 'Update review' : 'Send review'}</button>
            {state === 'saved' && <span className="helper__note">Thanks, the bot will read this.</span>}
            {state !== 'idle' && state !== 'saving' && state !== 'saved' && <span className="helper__error">{state}</span>}
          </div>
        </div>
      )}
    </article>
  );
}
