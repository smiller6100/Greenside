import { useState } from "react";
import { ChevronLeft, Trophy, Plus, LogIn, Copy, Check } from "lucide-react";
import { getAccount } from "../lib/account";
import { getLeagues, createLeague, joinLeagueByCode, leagueStandings, forgetLeague, type MyLeague } from "../lib/leagues";

function myName(): string {
  const a = getAccount(); if (a?.name) return a.name;
  try { const p = JSON.parse(localStorage.getItem("gs:profile") || "{}"); if (p.recent?.[0]?.name) return p.recent[0].name; } catch { /* */ }
  return "Me";
}

export default function Leagues() {
  const [leagues, setLeagues] = useState<MyLeague[]>(getLeagues());
  const [sel, setSel] = useState<MyLeague | null>(null);
  const [standings, setStandings] = useState<any>(null);
  const [newName, setNewName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const goHome = () => { location.hash = ""; };
  const open = async (l: MyLeague) => { setSel(l); setStandings(null); setStandings(await leagueStandings(l.code)); };

  const doCreate = async () => { if (!newName.trim()) return; setBusy(true); setMsg(""); const l = await createLeague(newName.trim(), myName()); setBusy(false); if (l) { setLeagues(getLeagues()); setNewName(""); open(l); } else setMsg("Couldn't create the league."); };
  const doJoin = async () => { const c = joinCode.trim().toUpperCase(); if (c.length < 4) return; setBusy(true); setMsg(""); const l = await joinLeagueByCode(c, myName()); setBusy(false); if (l) { setLeagues(getLeagues()); setJoinCode(""); open(l); } else setMsg("No league found for that code."); };
  const leave = (code: string) => { forgetLeague(code); setLeagues(getLeagues()); setSel(null); };
  const copyCode = (code: string) => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}); };

  if (sel) {
    const s = standings;
    return (
      <div className="gs"><div className="frame home">
        <header className="dash-head"><button className="backbtn" onClick={() => { setSel(null); setStandings(null); }}><ChevronLeft size={20} /></button><h2>{sel.name}</h2><span /></header>
        <div className="panel">
          <div className="lg-codebar">Share code <b>{sel.code}</b><button className="linkbtn" onClick={() => copyCode(sel.code)}>{copied ? "Copied" : "Copy"}</button></div>
          {!s ? <p className="hint" style={{ textAlign: "center", marginTop: 20 }}>Loading standings…</p> : (
            <>
              {(!s.standings || s.standings.length === 0) ? (
                <p className="hint" style={{ textAlign: "center", marginTop: 16 }}>No rounds submitted yet. Finish a round and tap <b>Submit to league</b> on its leaderboard — members are matched by name.</p>
              ) : (
                <div className="lg-table">
                  <div className="lg-th"><span className="lg-pos">#</span><span className="lg-nm">Member</span><span className="lg-pts">Pts</span><span className="lg-rd">Rds</span><span className="lg-avg">Avg</span></div>
                  {s.standings.map((r: any, i: number) => (
                    <div className={`lg-tr ${i === 0 ? "lead" : ""}`} key={r.id}>
                      <span className="lg-pos">{i === 0 ? <Trophy size={14} /> : i + 1}</span>
                      <span className="lg-nm">{r.name}</span>
                      <span className="lg-pts">{r.points}</span>
                      <span className="lg-rd">{r.rounds}</span>
                      <span className="lg-avg">{r.avgNet > 0 ? `+${r.avgNet.toFixed(1)}` : r.avgNet < 0 ? r.avgNet.toFixed(1) : "E"}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="hint" style={{ marginTop: 14 }}>{s.memberCount} member{s.memberCount === 1 ? "" : "s"} · {s.rounds?.length || 0} round{(s.rounds?.length || 0) === 1 ? "" : "s"} · placing points 10-8-6-5-4-3-2-1</p>
            </>
          )}
          <button className="linkbtn" style={{ marginTop: 10 }} onClick={() => leave(sel.code)}>Leave this league</button>
        </div>
      </div></div>
    );
  }

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head"><button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button><h2>Leagues</h2><span /></header>
      <div className="panel">
        {leagues.length > 0 && (
          <div className="field"><span>My leagues</span>
            <div className="lg-list">
              {leagues.map((l) => (
                <button className="lg-item" key={l.code} onClick={() => open(l)}><Trophy size={16} /><span className="lg-item-nm">{l.name}<em>{l.code}</em></span><ChevronLeft size={16} style={{ transform: "rotate(180deg)" }} /></button>
              ))}
            </div>
          </div>
        )}
        <div className="field"><span>Start a league</span>
          <div className="pf-coderow">
            <input className="dash-pw" style={{ margin: 0 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Thursday Night Men's" />
            <button className="primary pf-codebtn" disabled={busy || !newName.trim()} onClick={doCreate}><Plus size={16} /></button>
          </div>
        </div>
        <div className="field"><span>Join with a code</span>
          <div className="pf-coderow">
            <input className="dash-pw" style={{ margin: 0 }} value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="League code" maxLength={5} />
            <button className="primary pf-codebtn" disabled={busy || joinCode.length < 4} onClick={doJoin}><LogIn size={16} /></button>
          </div>
        </div>
        {msg && <p className="err">{msg}</p>}
        <p className="hint">A league keeps season-long standings across every round its members submit. Players are matched by the name on their scorecard, so keep names consistent.</p>
      </div>
    </div></div>
  );
}
