import { useState, useEffect, useRef } from "react";
import { ChevronLeft, RotateCcw, Lock } from "lucide-react";
import { computeStandings, fmtToPar } from "../lib/golf";

// Password-gated organizer view of an outing: live pace-of-play by group plus an overall
// leaderboard. v1 — reads a round's state on a 15s poll; gated behind the admin password for now.
export default function OutingDash() {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [code, setCode] = useState("");
  const [state, setState] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<number>(0);
  const codeRef = useRef("");
  const pwRef = useRef("");

  const goHome = () => { location.hash = ""; };

  const checkPw = async () => {
    setAuthMsg("");
    try {
      const r = await fetch("/api/admin/check", { method: "POST", headers: { "x-admin-key": pw } });
      const d = await r.json();
      if (d.ok) { pwRef.current = pw; setAuthed(true); }
      else setAuthMsg(d.configured === false ? "Admin password isn't set up yet." : "Wrong password.");
    } catch { setAuthMsg("Couldn't reach the server."); }
  };

  const load = async (c: string) => {
    const cc = c.trim().toUpperCase();
    if (!cc) return;
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/round/${cc}`);
      if (!r.ok) { setErr("No round found for that code."); setState(null); }
      else { setState(await r.json()); setUpdated(Date.now()); }
    } catch { setErr("Couldn't load that round."); }
    setLoading(false);
  };

  const start = () => { codeRef.current = code.trim().toUpperCase(); load(codeRef.current); };

  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => { if (codeRef.current) load(codeRef.current); }, 15000);
    return () => clearInterval(id);
  }, [authed]);

  if (!authed) {
    return (
      <div className="gs"><div className="frame home">
        <header className="dash-head"><button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button><h2>Outing dashboard</h2><span /></header>
        <div className="panel">
          <div className="dash-lock"><Lock size={22} /></div>
          <p className="hint" style={{ textAlign: "center" }}>Enter the organizer password to continue.</p>
          <input className="dash-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" onKeyDown={(e) => e.key === "Enter" && checkPw()} />
          {authMsg && <p className="err">{authMsg}</p>}
          <button className="primary" onClick={checkPw}>Unlock</button>
        </div>
      </div></div>
    );
  }

  // ---- Authed: outing field view ----
  const fmt = (["net", "gross", "stableford", "chicago"].find((f) => state?.formats?.[f]) || "net") as string;
  const useNet = state?.handicapMode !== "gross" && fmt === "net";
  const standings = state ? computeStandings(state, fmt) : [];
  const byId: Record<string, any> = Object.fromEntries(standings.map((s: any) => [s.id, s]));
  const holes = state?.course?.length || 18;
  const elapsedMin = state?.createdAt ? (Date.now() - state.createdAt) / 60000 : 0;
  const expected = Math.max(0, Math.min(holes, Math.floor(elapsedMin / 13))); // ~13 min/hole

  const groups: Record<string, any[]> = {};
  (state?.players || []).forEach((p: any) => { const g = p.group || "A"; (groups[g] ||= []).push(p); });
  const groupKeys = Object.keys(groups).sort();

  const groupThru = (g: string) => Math.max(0, ...groups[g].map((p) => byId[p.id]?.thru || 0));
  const paceOf = (thru: number) => {
    const behind = expected - thru;
    if (behind >= 2) return { label: "Behind", cls: "behind" };
    if (behind <= -1) return { label: "Ahead", cls: "ahead" };
    return { label: "On pace", cls: "onpace" };
  };
  const val = (s: any) => (s ? `${s.gross || "–"} (${fmtToPar(useNet ? s.toParNet : s.toParGross)})` : "—");

  const slowest = groupKeys.map((g) => ({ g, thru: groupThru(g) })).sort((a, b) => a.thru - b.thru)[0];

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button>
        <h2>Outing dashboard</h2>
        <button className="backbtn" onClick={() => codeRef.current && load(codeRef.current)} aria-label="refresh"><RotateCcw size={17} /></button>
      </header>

      <div className="panel">
        <div className="dash-load">
          <input className="dash-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Outing code (e.g. ABCD)" maxLength={6} onKeyDown={(e) => e.key === "Enter" && start()} />
          <button className="ghostbtn" onClick={start} disabled={loading}>{loading ? "Loading…" : "Load"}</button>
        </div>
        {err && <p className="err">{err}</p>}

        {state && (
          <>
            <div className="dash-meta">
              <div className="dm-title">{state.courseName || state.name || codeRef.current}</div>
              <div className="dm-sub">{state.players?.length || 0} players · {groupKeys.length} group{groupKeys.length === 1 ? "" : "s"} · expected thru {expected}{updated ? ` · updated ${new Date(updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div>
              {slowest && groupKeys.length > 1 && <div className={`dm-flag ${paceOf(slowest.thru).cls}`}>Slowest: Group {slowest.g} — thru {slowest.thru}</div>}
            </div>

            <div className="field"><span>Groups · pace</span>
              <div className="dash-groups">
                {groupKeys.map((g) => {
                  const thru = groupThru(g);
                  const pace = paceOf(thru);
                  const mem = groups[g].map((p) => byId[p.id]).filter(Boolean).sort((a, b) => (useNet ? a.toParNet - b.toParNet : a.toParGross - b.toParGross));
                  return (
                    <div className="grpcard" key={g}>
                      <div className="grpcard-top">
                        <b>Group {g}</b>
                        <span className={`pacebadge ${pace.cls}`}>{pace.label}</span>
                        <span className="grpthru">thru {thru}</span>
                      </div>
                      <div className="grpmem">
                        {mem.map((s) => (
                          <div className="grpm" key={s.id}><span>{s.name}</span><em>{val(s)}</em></div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="field"><span>Leaderboard</span>
              <div className="dash-board">
                {standings.map((s: any, i: number) => {
                  const p = (state.players || []).find((x: any) => x.id === s.id);
                  return (
                    <div className="db-row" key={s.id}>
                      <span className="db-rank">{i + 1}</span>
                      <span className="db-name">{s.name}{p?.group ? <em className="db-grp">{p.group}</em> : null}</span>
                      <span className="db-thru">thru {s.thru}</span>
                      <span className="db-score">{val(s)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="hint">Pace is estimated from holes completed vs. elapsed time (~13 min/hole). Live GPS positions come later.</p>
          </>
        )}
      </div>
    </div></div>
  );
}
