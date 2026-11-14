// Optional cross-device profile. Account = { id, secret, name } kept in localStorage; the id+secret
// authenticate every call. Rounds sync both ways (merge by code, newest wins). Entry stays
// account-free — nothing here runs unless the golfer chooses to create or link an account.

export type Account = { id: string; secret: string; name: string };

export function getAccount(): Account | null {
  try { const a = JSON.parse(localStorage.getItem("gs:account") || "null"); return a && a.id && a.secret ? a : null; } catch { return null; }
}
export function setAccount(a: Account) { try { localStorage.setItem("gs:account", JSON.stringify(a)); } catch { /* */ } }
export function clearAccount() { try { localStorage.removeItem("gs:account"); } catch { /* */ } }
export function authHeaders(): Record<string, string> {
  const a = getAccount(); return a ? { "x-account-id": a.id, "x-account-secret": a.secret } : {};
}

function loadLocalRounds(): any[] { try { return JSON.parse(localStorage.getItem("gs:rounds") || "[]"); } catch { return []; } }
function saveLocalRounds(rs: any[]) { try { localStorage.setItem("gs:rounds", JSON.stringify(rs)); } catch { /* */ } }

// Merge two round lists by code — the newer savedAt (then endedAt) wins. Cap to 60, newest first.
export function mergeRounds(local: any[], cloud: any[]): any[] {
  const map: Record<string, any> = {};
  for (const r of [...(cloud || []), ...(local || [])]) {
    if (!r || !r.code) continue;
    const cur = map[r.code];
    const newer = !cur || (r.savedAt || 0) > (cur.savedAt || 0) || ((r.savedAt || 0) === (cur.savedAt || 0) && (r.endedAt || 0) >= (cur.endedAt || 0));
    if (newer) map[r.code] = r;
  }
  return Object.values(map).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 60);
}

export function pushRound(snap: any) {
  if (!getAccount() || !snap || !snap.code) return;
  fetch("/api/account/round", { method: "PUT", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(snap) }).catch(() => {});
}

// Pull the cloud profile, merge its rounds into local, push back anything the cloud is missing.
export async function syncDown(): Promise<{ name: string; friends: any[] } | null> {
  const a = getAccount(); if (!a) return null;
  try {
    const r = await fetch("/api/account/me", { headers: authHeaders() });
    if (!r.ok) return null;
    const d = await r.json();
    const local = loadLocalRounds();
    const merged = mergeRounds(local, d.rounds || []);
    saveLocalRounds(merged);
    const cloudByCode: Record<string, any> = Object.fromEntries((d.rounds || []).map((x: any) => [x.code, x]));
    for (const rr of merged) { const c = cloudByCode[rr.code]; if (!c || (rr.savedAt || 0) > (c.savedAt || 0)) pushRound(rr); }
    if (d.name && d.name !== a.name) setAccount({ ...a, name: d.name });
    return { name: d.name || a.name, friends: d.friends || [] };
  } catch { return null; }
}

export async function createAccount(name: string): Promise<Account | null> {
  try {
    const r = await fetch("/api/account/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (!d.ok) return null;
    const acc = { id: d.accountId, secret: d.secret, name: d.name || name };
    setAccount(acc);
    for (const rr of loadLocalRounds()) pushRound(rr); // seed the cloud with this device's rounds
    return acc;
  } catch { return null; }
}

export async function claimAccount(code: string): Promise<boolean> {
  try {
    const r = await fetch("/api/account/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!d.ok || !d.accountId) return false;
    setAccount({ id: d.accountId, secret: d.secret, name: "" });
    await syncDown();
    return true;
  } catch { return false; }
}

export async function mintLinkCode(): Promise<string | null> {
  try { const r = await fetch("/api/account/link", { method: "POST", headers: authHeaders() }); const d = await r.json(); return d.ok ? d.code : null; } catch { return null; }
}

export async function setAccountName(name: string) {
  const a = getAccount(); if (!a) return;
  setAccount({ ...a, name });
  try { await fetch("/api/account/name", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ name }) }); } catch { /* */ }
}

export async function addFriend(id: string, name: string): Promise<any[]> {
  try { const r = await fetch("/api/account/friends", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ add: { id, name } }) }); const d = await r.json(); return d.friends || []; } catch { return []; }
}
export async function removeFriend(id: string): Promise<any[]> {
  try { const r = await fetch("/api/account/friends", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ removeId: id }) }); const d = await r.json(); return d.friends || []; } catch { return []; }
}
export async function friendCard(id: string): Promise<{ name: string; rounds: any[] } | null> {
  try { const r = await fetch(`/api/account/card/${encodeURIComponent(id)}`, { headers: authHeaders() }); if (!r.ok) return null; const d = await r.json(); return d.ok ? { name: d.name, rounds: d.rounds || [] } : null; } catch { return null; }
}
