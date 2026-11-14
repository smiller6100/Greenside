import { getAccount } from "./account";

// Standing leagues with season standings. A league lives server-side (keyed by a short code); the
// device keeps the list of leagues it belongs to. Members are matched to a round's players by name.

export type MyLeague = { code: string; name: string; memberId: string; adminSecret?: string };

export function getLeagues(): MyLeague[] { try { return JSON.parse(localStorage.getItem("gs:leagues") || "[]"); } catch { return []; } }
export function saveLeagues(ls: MyLeague[]) { try { localStorage.setItem("gs:leagues", JSON.stringify(ls)); } catch { /* */ } }
function remember(l: MyLeague) { const ls = getLeagues().filter((x) => x.code !== l.code); ls.unshift(l); saveLeagues(ls); }
export function forgetLeague(code: string) { saveLeagues(getLeagues().filter((l) => l.code !== code)); }

export async function joinLeague(code: string, name: string): Promise<string | null> {
  try {
    const acc = getAccount();
    const r = await fetch(`/api/league/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, accountId: acc?.id }) });
    const d = await r.json();
    return d.ok ? d.memberId : null;
  } catch { return null; }
}

export async function joinLeagueByCode(code: string, name: string): Promise<MyLeague | null> {
  const info = await leagueInfo(code);
  if (!info || !info.ok) return null;
  const memberId = await joinLeague(code, name);
  if (!memberId) return null;
  const l: MyLeague = { code, name: info.name, memberId };
  remember(l);
  return l;
}

export async function createLeague(leagueName: string, playerName: string): Promise<MyLeague | null> {
  try {
    const r = await fetch("/api/league/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: leagueName }) });
    const d = await r.json();
    if (!d.ok) return null;
    const memberId = await joinLeague(d.code, playerName);
    const l: MyLeague = { code: d.code, name: leagueName, memberId: memberId || "", adminSecret: d.adminSecret };
    remember(l);
    return l;
  } catch { return null; }
}

export async function leagueInfo(code: string): Promise<any> {
  try { const r = await fetch(`/api/league/${code}/info`); return r.ok ? await r.json() : null; } catch { return null; }
}
export async function leagueStandings(code: string): Promise<any> {
  try { const r = await fetch(`/api/league/${code}/standings`); return r.ok ? await r.json() : null; } catch { return null; }
}
export async function submitToLeague(code: string, roundCode: string, date: number, entries: { name: string; netToPar: number; gross?: number }[]): Promise<number> {
  try {
    const r = await fetch(`/api/league/${code}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roundCode, date, entries }) });
    const d = await r.json();
    return d.ok ? (d.matched || 0) : -1;
  } catch { return -1; }
}
