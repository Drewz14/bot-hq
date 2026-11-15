import { useCallback, useEffect, useState } from 'react';
import { helpersApi, type HelpersOverview } from '../../lib/helpersApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { ConfirmButton, Switch } from './ui';
import '../../styles/helpers.css';

/** Settings → Helpers: invite people with limited access, choose what they may run, see what they did. */
export function HelpersSection({ PageHead }: { PageHead: (p: { title: string; sub?: string }) => JSX.Element }) {
  const bots = useStore((s) => s.bots).filter((b) => (b as { kind?: string }).kind !== 'room');
  const [data, setData] = useState<HelpersOverview | null>(null);
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => helpersApi.overview().then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const invite = async () => {
    setMsg('');
    try {
      await helpersApi.invite(email, picked);
      setMsg(`Invited ${email.trim()}. They can sign in at this app’s address with that email.`);
      setEmail(''); setPicked([]); load();
    } catch (e: any) { setMsg(e.message); }
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <>
      <PageHead title="Helpers" sub="Invite people to help with your research bots. Helpers only see results a bot shares (you approve each share), can review them, and can run the routines you allow. They never see chats, memory, files, screens or settings." />

      <section className="cfg-section">
        <div className="cfg-section__label">Invite a helper</div>
        <div className="cfg-card helpers__invite">
          <input className="text-input" type="email" placeholder="their@email.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Helper email" />
          <div className="helpers__bots" role="group" aria-label="Bots they can help with">
            {bots.map((b) => (
              <label key={b.id} className={`helpers__bot${picked.includes(b.id) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={picked.includes(b.id)} onChange={() => toggle(b.id)} /> {b.name}
              </label>
            ))}
          </div>
          <div className="helpers__row">
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={!email.includes('@') || !picked.length} onClick={invite}>Invite</button>
            {msg && <span className="helper__note" role="status">{msg}</span>}
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">People</div>
        <div className="cfg-card">
          {!data ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : data.helpers.length === 0 ? <div className="cfg-empty cfg-empty--flat">No helpers yet.</div> : data.helpers.map((h) => (
            <div key={h.email} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{h.name ?? h.email}{' '}{h.joined ? <span className="cfg-chip">Signed in</span> : <span className="cfg-chip cfg-chip--muted">Invited</span>}</div>
                <div className="cfg-row__sub">{h.name ? `${h.email} · ` : ''}Helps with {h.bots.map((b) => b.name).join(', ')}</div>
              </div>
              <ConfirmButton confirmLabel="Remove" onConfirm={() => helpersApi.remove(h.email).then(load)}>Remove</ConfirmButton>
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Routines helpers can run</div>
        <p className="helpers__hint">Helpers see only the routine’s name, never its instructions. Each helper can start up to {data?.runsPerDay ?? 10} runs a day, and each run uses your model credits.</p>
        <div className="cfg-card">
          {!data ? null : data.routines.length === 0 ? <div className="cfg-empty cfg-empty--flat">Your bots have no routines yet.</div> : data.routines.map((r) => (
            <div key={r.id} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{r.name}</div>
                <div className="cfg-row__sub">{r.botName}</div>
              </div>
              <Switch label={`Let helpers run ${r.name}`} on={r.forHelpers} onChange={(v) => helpersApi.setRoutine(r.id, v).then(load)} />
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Shared results</div>
        <div className="cfg-card">
          {!data ? null : data.results.length === 0 ? <div className="cfg-empty cfg-empty--flat">Nothing shared yet. A bot shares with the share_with_helpers tool, after you approve it.</div> : data.results.map((r) => (
            <div key={r.id} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{r.title}</div>
                <div className="cfg-row__sub">
                  {r.botName} · {relativeShort(r.createdAt)} · {r.reviews.agree} agree, {r.reviews.disagree} disagree, {r.reviews.unsure} unsure
                  {r.redactions ? ` · ${r.redactions} personal detail${r.redactions === 1 ? '' : 's'} blanked out` : ''}
                </div>
              </div>
              <ConfirmButton confirmLabel="Unshare" onConfirm={() => helpersApi.deleteResult(r.id).then(load)}>Unshare</ConfirmButton>
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Activity</div>
        <div className="cfg-card">
          {!data ? null : data.log.length === 0 ? <div className="cfg-empty cfg-empty--flat">No activity yet.</div> : data.log.map((l, i) => (
            <div key={i} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{l.email} {l.action}</div>
                <div className="cfg-row__sub">{l.detail ? `${l.detail} · ` : ''}{relativeShort(l.at)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
