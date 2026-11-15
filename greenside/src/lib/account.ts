// Optional cross-device profile. Account = { id, secret, name } kept in localStorage; the id+secret
// authenticate every call. Rounds sync both ways (merge by code, newest wins). Entry stays
// account-free — nothing here runs unless the golfer chooses to create or link an account.

export type Account = { id: string; secret: string; name: string; username?: string };

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

// Deleted-round tombstones: codes the user removed, so a cloud sync can't resurrect them.
function loadTombstones(): string[] { try { return JSON.parse(localStorage.getItem("gs:deleted") || "[]"); } catch { return []; } }
export function deleteRound(code: string) {
  try { const t = loadTombstones(); if (!t.includes(code)) { t.push(code); localStorage.setItem("gs:deleted", JSON.stringify(t.slice(-300))); } } catch { /* */ }
  saveLocalRounds(loadLocalRounds().filter((r) => r && r.code !== code));
  if (getAccount()) fetch("/api/account/round", { method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => {});
}

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

// Ryder Cup membership. Mirrors the device's gs:cups list to the account so cups follow the login
// across devices. Each entry: { code, name, ts }.
function loadLocalCups(): any[] { try { return JSON.parse(localStorage.getItem("gs:cups") || "[]"); } catch { return []; } }
function saveLocalCups(cs: any[]) { try { localStorage.setItem("gs:cups", JSON.stringify(cs.slice(0, 60))); } catch { /* */ } }

export function addAccountCup(code: string, name: string) {
  if (!getAccount() || !code) return;
  fetch("/api/account/cup", { method: "PUT", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ code, name }) }).catch(() => {});
}
export function removeAccountCup(code: string) {
  if (!getAccount() || !code) return;
  fetch("/api/account/cup", { method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => {});
}

// Merge cloud cups into the local list (newest ts per code wins), write back, and push up any the
// cloud is missing. Returns the merged list so callers can refresh their view.
function mergeCups(local: any[], cloud: any[]): any[] {
  const map: Record<string, any> = {};
  for (const c of [...(cloud || []), ...(local || [])]) {
    if (!c || !c.code) continue;
    const cur = map[c.code];
    if (!cur || (c.ts || 0) >= (cur.ts || 0)) map[c.code] = { code: String(c.code), name: c.name || cur?.name || "Ryder Cup", ts: c.ts || cur?.ts || Date.now() };
  }
  return Object.values(map).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
}

// Pull the cloud profile, merge its rounds into local, push back anything the cloud is missing.
export async function syncDown(): Promise<{ name: string; friends: any[] } | null> {
  const a = getAccount(); if (!a) return null;
  try {
    const r = await fetch("/api/account/me", { headers: authHeaders() });
    if (!r.ok) return null;
    const d = await r.json();
    const local = loadLocalRounds();
    const tomb = loadTombstones();
    const merged = mergeRounds(local, d.rounds || []).filter((r) => !tomb.includes(r.code));
    saveLocalRounds(merged);
    const cloudByCode: Record<string, any> = Object.fromEntries((d.rounds || []).map((x: any) => [x.code, x]));
    for (const rr of merged) { const c = cloudByCode[rr.code]; if (!c || (rr.savedAt || 0) > (c.savedAt || 0)) pushRound(rr); }
    // Re-send deletes for any tombstoned round the cloud still has (e.g. a delete that didn't land).
    for (const code of tomb) { if (cloudByCode[code]) fetch("/api/account/round", { method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => {}); }
    // Cups: merge the cloud list with this device's, write back, and push up any the cloud lacks.
    const localCups = loadLocalCups();
    const mergedCups = mergeCups(localCups, d.cups || []);
    saveLocalCups(mergedCups);
    const cloudCupCodes = new Set((d.cups || []).map((c: any) => c.code));
    for (const c of mergedCups) { if (!cloudCupCodes.has(c.code)) addAccountCup(c.code, c.name); }
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

// ---- Username + password ----
export async function usernameAvailable(u: string): Promise<{ valid: boolean; available: boolean }> {
  try { const r = await fetch("/api/account/username-available?u=" + encodeURIComponent(u)); return await r.json(); } catch { return { valid: false, available: false }; }
}

// Create a brand-new account from a unique username + password.
export async function signup(username: string, password: string, name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/account/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, name }) });
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.error || "Couldn't create that account." };
    setAccount({ id: d.accountId, secret: d.secret, name: d.name || name || "", username: d.username });
    for (const rr of loadLocalRounds()) pushRound(rr); // seed the cloud with this device's rounds
    return { ok: true };
  } catch { return { ok: false, error: "Couldn't reach the server." }; }
}

// Sign in on any device with username + password; pulls the account's data down.
export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/account/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.error || "Wrong username or password." };
    setAccount({ id: d.accountId, secret: d.secret, name: "", username: d.username });
    await syncDown();
    return { ok: true };
  } catch { return { ok: false, error: "Couldn't reach the server." }; }
}

// Attach a username + password to the current (passwordless) account so it can sign in elsewhere.
export async function setCredentials(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const a = getAccount(); if (!a) return { ok: false, error: "Not signed in." };
  try {
    const r = await fetch("/api/account/set-credentials", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.error || "Couldn't set that username." };
    setAccount({ ...a, username: d.username });
    return { ok: true };
  } catch { return { ok: false, error: "Couldn't reach the server." }; }
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
