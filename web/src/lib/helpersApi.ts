import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export type Verdict = 'agree' | 'disagree' | 'unsure';

export interface HelperProject {
  bot: { id: string; name: string; label: string; avatarShape: string; avatarColor: string };
  owner: string;
  routines: { id: string; name: string; lastRunAt: number | null }[];
  results: { id: string; title: string; body: string; createdAt: number; myReview: { verdict: Verdict; note: string } | null }[];
}
export interface HelperHome { projects: HelperProject[]; runsLeftToday: number; runsPerDay: number }

export interface HelpersOverview {
  helpers: { email: string; name: string | null; joined: boolean; bots: { id: string; name: string }[] }[];
  routines: { id: string; name: string; botId: string; botName: string; forHelpers: boolean }[];
  results: { id: string; title: string; botName: string; redactions: number; createdAt: number; reviews: Record<Verdict, number> }[];
  log: { email: string; action: string; detail: string; at: number }[];
  runsPerDay: number;
}

export const helpersApi = {
  // the helper's side
  home: () => req<HelperHome>('GET', '/helper/home'),
  run: (routineId: string) => req<{ ok: true }>('POST', `/helper/routines/${routineId}/run`),
  review: (resultId: string, verdict: Verdict, note: string) => req<{ ok: true }>('POST', `/helper/results/${resultId}/review`, { verdict, note }),
  // the owner's side
  overview: () => req<HelpersOverview>('GET', '/helpers'),
  invite: (email: string, botIds: string[]) => req<{ ok: true }>('POST', '/helpers/invite', { email, botIds }),
  remove: (email: string) => req<{ ok: true }>('DELETE', `/helpers/people/${encodeURIComponent(email)}`),
  setRoutine: (id: string, forHelpers: boolean) => req<{ ok: true }>('POST', `/helpers/routines/${id}`, { forHelpers }),
  deleteResult: (id: string) => req<{ ok: true }>('DELETE', `/helpers/results/${id}`),
};
