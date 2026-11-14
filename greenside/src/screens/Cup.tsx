import { useState, useEffect, useRef, useMemo } from "react";
import { ChevronLeft, ChevronRight, Plus, Minus, Trophy, Users, Flag, Settings, X, Share2, Check } from "lucide-react";
import { computeMatch, cupTotals, clinch, type Format, type HcpMethod, type MatchResult } from "../lib/cup";

const FORMATS: { id: Format; label: string; sub: string; team: boolean }[] = [
  { id: "fourball", label: "Four-Ball", sub: "2v2 · each plays own ball, best counts", team: false },
  { id: "foursomes", label: "Foursomes", sub: "2v2 · one ball, alternate shot", team: true },
  { id: "singles", label: "Singles", sub: "1v1 match", team: false },
  { id: "scramble", label: "Scramble", sub: "2v2 · one ball, team scramble", team: true },
];
const fmtLabel = (f: string) => FORMATS.find((x) => x.id === f)?.label || f;
const isTeamBall = (f: string) => f === "foursomes" || f === "scramble";

const METHODS: { id: HcpMethod; label: string; sub: string }[] = [
  { id: "low", label: "Net off low", sub: "Low handicap plays scratch; others get the difference" },
  { id: "full", label: "Full net", sub: "Everyone gets their full course-handicap strokes" },
  { id: "gross", label: "Gross", sub: "No handicaps — pure low score wins" },
];

const COLORS = ["#15392a", "#9a2b2b", "#1e5fa8", "#b8860b", "#6b21a8", "#0f766e", "#c2410c", "#334155"];

// Demo course (par 72, SI 1–18) so a Cup can be created and tested instantly.
const DEMO_COURSE = {
  name: "Demo Course", where: "",
  holes: [4, 5, 4, 3, 4, 4, 5, 3, 4, 4, 4, 5, 3, 4, 4, 3, 5, 4].map((par, i) => ({
    num: i + 1, par,
    si: i < 9 ? [7, 3, 11, 1, 15, 5, 17, 13, 9][i] : [8, 4, 12, 2, 16, 6, 18, 14, 10][i - 9],
    yards: par === 3 ? 165 : par === 5 ? 530 : 400,
  })),
};

function wsUrl(code: string) { return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/cup/" + code; }
function parseCup(): string | null { const m = location.hash.match(/#\/cup\/([A-Za-z0-9]+)/); return m ? m[1].toUpperCase() : null; }

export default function Cup() {
  const [code, setCode] = useState<string | null>(parseCup());
  useEffect(() => { const on = () => setCode(parseCup()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return code ? <CupBoard code={code} /> : <CupCreate />;
}

/* ------------------------------------------------------------------ Create / Join */
function CupCreate() {
  const [name, setName] = useState("");
  const [teamA, setTeamA] = useState("Team USA");
  const [teamB, setTeamB] = useState("Team Europe");
  const [colorA, setColorA] = useState(COLORS[0]);
  const [colorB, setColorB] = useState(COLORS[1]);
  const [method, setMethod] = useState<HcpMethod>("low");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/cup/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Ryder Cup", method, teams: { A: { name: teamA.trim() || "Team A", color: colorA }, B: { name: teamB.trim() || "Team B", color: colorB } }, course: DEMO_COURSE }),
      });
      const d = await r.json();
      if (d.code) { try { localStorage.setItem("gs:cup:" + d.code + ":token", d.adminToken); } catch { /* */ } location.hash = "#/cup/" + d.code; }
    } finally { setBusy(false); }
  };

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head"><button className="backbtn" onClick={() => { location.hash = ""; }}><ChevronLeft size={20} /></button><h2>Ryder Cup</h2><span /></header>
      <div className="panel">
        <p className="cup-intro"><Trophy size={15} /> A team match-play event for a guys' golf weekend — sessions of Four-Ball, Foursomes and Singles, live match status, and a running Cup scoreboard.</p>

        <div className="field"><span>Event name</span><input className="dash-pw" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fall Classic 2026" /></div>

        <div className="field"><span>Teams</span>
          <div className="cup-team-row">
            <input className="dash-pw cup-tname" style={{ borderLeft: `5px solid ${colorA}` }} value={teamA} onChange={(e) => setTeamA(e.target.value)} />
            <div className="cup-swatches">{COLORS.map((c) => <button key={c} className={`cup-sw ${colorA === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColorA(c)} />)}</div>
          </div>
          <div className="cup-team-row">
            <input className="dash-pw cup-tname" style={{ borderLeft: `5px solid ${colorB}` }} value={teamB} onChange={(e) => setTeamB(e.target.value)} />
            <div className="cup-swatches">{COLORS.map((c) => <button key={c} className={`cup-sw ${colorB === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColorB(c)} />)}</div>
          </div>
        </div>

        <div className="field"><span>Handicaps</span>
          <div className="cup-methods">
            {METHODS.map((m) => (
              <button key={m.id} className={`cup-method ${method === m.id ? "on" : ""}`} onClick={() => setMethod(m.id)}>
                <b>{m.label}</b><em>{m.sub}</em>
              </button>
            ))}
          </div>
        </div>

        <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create the Cup"}</button>
        <p className="hint">Runs on a demo course to start — you can set the real course in setup. You'll get a code to share with everyone.</p>

        <div className="field" style={{ marginTop: 18 }}><span>Join an existing Cup</span>
          <div className="pf-coderow">
            <input className="dash-pw" style={{ margin: 0 }} value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="Cup code" maxLength={6} />
            <button className="primary pf-codebtn" disabled={joinCode.length < 4} onClick={() => { location.hash = "#/cup/" + joinCode; }}><ChevronRight size={16} /></button>
          </div>
        </div>
      </div>
    </div></div>
  );
}

/* ------------------------------------------------------------------ Board + management */
function CupBoard({ code }: { code: string }) {
  const [state, setState] = useState<any>(null);
  const [view, setView] = useState<"board" | "setup">("board");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const token = useRef<string>("");
  try { token.current = localStorage.getItem("gs:cup:" + code + ":token") || ""; } catch { /* */ }
  const isAdmin = !!token.current;

  useEffect(() => {
    let alive = true; let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket(wsUrl(code)); wsRef.current = ws;
      ws.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.type === "state") setState(d.state); } catch { /* */ } };
      ws.onclose = () => { if (alive) setTimeout(connect, 1500); };
    };
    connect();
    return () => { alive = false; try { ws.close(); } catch { /* */ } };
  }, [code]);

  const send = (obj: any) => { try { wsRef.current?.send(JSON.stringify({ ...obj, token: token.current || undefined })); } catch { /* */ } };

  const course = state?.course || DEMO_COURSE;
  const pars: number[] = course.holes.map((h: any) => h.par);
  const sis: number[] = course.holes.map((h: any) => h.si);
  const rosterById: Record<string, any> = useMemo(() => Object.fromEntries((state?.roster || []).map((p: any) => [p.id, p])), [state]);

  const resultFor = (mt: any): MatchResult => {
    const sideA = mt.sideA.map((id: string) => ({ id, hcp: rosterById[id]?.hcp || 0 }));
    const sideB = mt.sideB.map((id: string) => ({ id, hcp: rosterById[id]?.hcp || 0 }));
    const gross: Record<string, (number | null)[]> = {};
    if (isTeamBall(mt.format)) { gross["A"] = mt.scores["A"] || []; gross["B"] = mt.scores["B"] || []; }
    else { for (const id of [...mt.sideA, ...mt.sideB]) gross[id] = mt.scores[id] || []; }
    return computeMatch({ format: mt.format, method: state.method, sideA, sideB, gross, course: { pars, sis } });
  };

  if (!state) return <div className="gs"><div className="frame home"><div className="cup-load"><span className="spin sm" /> Loading the Cup…</div></div></div>;

  if (matchId) {
    const mt = state.matches.find((x: any) => x.id === matchId);
    if (!mt) { setMatchId(null); return null; }
    return <MatchView state={state} mt={mt} course={course} rosterById={rosterById} result={resultFor(mt)} onBack={() => setMatchId(null)} send={send} />;
  }

  const allResults = state.matches.map(resultFor);
  const totals = cupTotals(allResults);
  const need = clinch(state.matches.length || 0);

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={() => { location.hash = ""; }}><ChevronLeft size={20} /></button>
        <h2>{state.name}</h2>
        <button className="backbtn" onClick={() => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}); }} aria-label="share">{copied ? <Check size={18} /> : <Share2 size={18} />}</button>
      </header>

      {/* Headline scoreboard */}
      <div className="cup-score">
        <div className="cup-side" style={{ background: state.teams.A.color }}>
          <span className="cup-sn">{state.teams.A.name}</span>
          <b className="cup-pts">{fmtPts(totals.banked.A)}</b>
        </div>
        <div className="cup-mid"><span>vs</span>{state.matches.length ? <em>{fmtPts(need.toWin)} to win</em> : null}</div>
        <div className="cup-side b" style={{ background: state.teams.B.color }}>
          <b className="cup-pts">{fmtPts(totals.banked.B)}</b>
          <span className="cup-sn">{state.teams.B.name}</span>
        </div>
      </div>
      {(totals.projected.A !== totals.banked.A || totals.projected.B !== totals.banked.B) && (
        <div className="cup-proj">Projected with matches in progress: {fmtPts(totals.projected.A)} – {fmtPts(totals.projected.B)}</div>
      )}

      <div className="cup-tabs">
        <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}><Flag size={15} /> Matches</button>
        {isAdmin && <button className={view === "setup" ? "on" : ""} onClick={() => setView("setup")}><Settings size={15} /> Setup</button>}
      </div>

      {view === "board" ? (
        <div className="panel cup-panel">
          {state.sessions.length === 0 && <p className="hint" style={{ textAlign: "center" }}>{isAdmin ? "No sessions yet — open Setup to build the weekend and set pairings." : "The captain hasn't set up any sessions yet."}</p>}
          {state.sessions.map((s: any) => {
            const ms = state.matches.filter((m: any) => m.sessionId === s.id);
            return (
              <div key={s.id} className="cup-sess">
                <div className="cup-sess-h"><b>{s.name}</b><span>{fmtLabel(s.format)}</span></div>
                {ms.length === 0 ? <p className="hint" style={{ margin: "4px 0 10px" }}>No matches yet.</p> : ms.map((mt: any) => <MatchRow key={mt.id} mt={mt} state={state} result={resultFor(mt)} rosterById={rosterById} onOpen={() => setMatchId(mt.id)} />)}
              </div>
            );
          })}
        </div>
      ) : (
        <CupSetup state={state} send={send} />
      )}
      <div className="cup-code-foot">Cup code <b>{code}</b> · share it so everyone sees the same board</div>
    </div></div>
  );
}

function fmtPts(n: number) { const whole = Math.floor(n); const half = n - whole >= 0.5; return half ? (whole ? whole : "") + "½" : String(whole); }

function teamNames(ids: string[], rosterById: Record<string, any>) {
  return ids.map((id) => rosterById[id]?.name?.split(" ")[0] || "—").join(" / ") || "—";
}

function MatchRow({ mt, state, result, rosterById, onOpen }: any) {
  const a = teamNames(mt.sideA, rosterById), b = teamNames(mt.sideB, rosterById);
  const lead = result.leader;
  const statusCls = result.final ? "fin" : result.holesPlayed ? "live" : "idle";
  return (
    <button className="cup-match" onClick={onOpen}>
      <div className="cm-sides">
        <span className={`cm-side ${lead === "A" ? "win" : result.final && lead !== "A" ? "lose" : ""}`} style={{ color: lead === "A" ? state.teams.A.color : undefined }}>{a}</span>
        <span className="cm-v">v</span>
        <span className={`cm-side ${lead === "B" ? "win" : result.final && lead !== "B" ? "lose" : ""}`} style={{ color: lead === "B" ? state.teams.B.color : undefined }}>{b}</span>
      </div>
      <div className={`cm-status ${statusCls}`}>{result.label === "—" ? "—" : result.label}</div>
    </button>
  );
}

/* ------------------------------------------------------------------ Setup */
function CupSetup({ state, send }: any) {
  const [pname, setPname] = useState(""); const [phcp, setPhcp] = useState("");
  const addPlayer = () => { const n = pname.trim(); if (!n) return; send({ type: "rosterAdd", name: n, hcp: parseInt(phcp) || 0, team: null }); setPname(""); setPhcp(""); };
  const unassigned = state.roster.filter((p: any) => !p.team);

  return (
    <div className="panel cup-panel">
      {/* Roster */}
      <div className="cup-sub"><Users size={14} /> Players</div>
      {(["A", "B"] as const).map((side) => (
        <div key={side} className="cup-roster-team">
          <div className="crt-h" style={{ color: state.teams[side].color }}>{state.teams[side].name}</div>
          <div className="crt-list">
            {state.roster.filter((p: any) => p.team === side).map((p: any) => (
              <div key={p.id} className="crt-p">
                <span>{p.name}<em>{p.hcp}</em></span>
                <button onClick={() => send({ type: "rosterUpdate", id: p.id, team: null })} aria-label="unassign"><X size={13} /></button>
              </div>
            ))}
            {state.roster.filter((p: any) => p.team === side).length === 0 && <span className="crt-empty">—</span>}
          </div>
        </div>
      ))}
      {unassigned.length > 0 && (
        <div className="cup-unassigned">
          <span className="cu-lbl">Tap to assign a team:</span>
          {unassigned.map((p: any) => (
            <div key={p.id} className="cu-p">
              <span>{p.name} <em>{p.hcp}</em></span>
              <div className="cu-btns">
                <button style={{ background: state.teams.A.color }} onClick={() => send({ type: "rosterUpdate", id: p.id, team: "A" })}>{state.teams.A.name.split(" ")[0]}</button>
                <button style={{ background: state.teams.B.color }} onClick={() => send({ type: "rosterUpdate", id: p.id, team: "B" })}>{state.teams.B.name.split(" ")[0]}</button>
                <button className="cu-x" onClick={() => send({ type: "rosterRemove", id: p.id })}><X size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="pf-coderow" style={{ marginTop: 8 }}>
        <input className="dash-pw" style={{ margin: 0, flex: 2 }} value={pname} onChange={(e) => setPname(e.target.value)} placeholder="Player name" />
        <input className="dash-pw" style={{ margin: 0, width: 56, flex: "none", textAlign: "center" }} value={phcp} onChange={(e) => setPhcp(e.target.value.replace(/[^0-9]/g, ""))} placeholder="hcp" />
        <button className="primary pf-codebtn" disabled={!pname.trim()} onClick={addPlayer}><Plus size={16} /></button>
      </div>

      {/* Sessions */}
      <div className="cup-sub" style={{ marginTop: 20 }}><Flag size={14} /> Sessions</div>
      {state.sessions.map((s: any) => <SessionEditor key={s.id} s={s} state={state} send={send} />)}
      <AddSession send={send} />
    </div>
  );
}

function AddSession({ send }: any) {
  const [name, setName] = useState(""); const [format, setFormat] = useState<Format>("fourball"); const [open, setOpen] = useState(false);
  if (!open) return <button className="linkbtn" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>+ Add a session</button>;
  return (
    <div className="cup-addsess">
      <input className="dash-pw" style={{ margin: "0 0 8px" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Session name (e.g. Saturday AM)" />
      <div className="cup-fmt-grid">
        {FORMATS.map((f) => <button key={f.id} className={`cup-fmt ${format === f.id ? "on" : ""}`} onClick={() => setFormat(f.id)}><b>{f.label}</b><em>{f.sub}</em></button>)}
      </div>
      <div className="pf-coderow">
        <button className="primary" style={{ flex: 1 }} disabled={!name.trim()} onClick={() => { send({ type: "sessionAdd", name: name.trim(), format }); setName(""); setOpen(false); }}>Add session</button>
        <button className="linkbtn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function SessionEditor({ s, state, send }: any) {
  const ms = state.matches.filter((m: any) => m.sessionId === s.id);
  const [adding, setAdding] = useState(false);
  const twoPer = s.format !== "singles";
  const [a1, setA1] = useState(""); const [a2, setA2] = useState(""); const [b1, setB1] = useState(""); const [b2, setB2] = useState("");
  const teamA = state.roster.filter((p: any) => p.team === "A");
  const teamB = state.roster.filter((p: any) => p.team === "B");
  const nameOf = (id: string) => state.roster.find((p: any) => p.id === id)?.name || "";
  const addMatch = () => {
    const sideA = [a1, twoPer ? a2 : ""].filter(Boolean);
    const sideB = [b1, twoPer ? b2 : ""].filter(Boolean);
    if (!sideA.length || !sideB.length) return;
    send({ type: "matchAdd", sessionId: s.id, sideA, sideB });
    setA1(""); setA2(""); setB1(""); setB2(""); setAdding(false);
  };
  const sel = (val: string, set: (v: string) => void, team: any[]) => (
    <select className="cup-sel" value={val} onChange={(e) => set(e.target.value)}>
      <option value="">—</option>
      {team.map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.hcp})</option>)}
    </select>
  );
  return (
    <div className="cup-sess-ed">
      <div className="cup-sess-h"><b>{s.name}</b><span>{fmtLabel(s.format)}<button className="cse-del" onClick={() => send({ type: "sessionRemove", id: s.id })}><X size={13} /></button></span></div>
      {ms.map((m: any) => (
        <div key={m.id} className="cse-match">
          <span>{teamNames(m.sideA, Object.fromEntries(state.roster.map((p: any) => [p.id, p])))} v {teamNames(m.sideB, Object.fromEntries(state.roster.map((p: any) => [p.id, p])))}</span>
          <button onClick={() => send({ type: "matchRemove", id: m.id })}><X size={13} /></button>
        </div>
      ))}
      {adding ? (
        <div className="cse-add">
          <div className="cse-pick"><span style={{ color: state.teams.A.color }}>{state.teams.A.name}</span>{sel(a1, setA1, teamA)}{twoPer && sel(a2, setA2, teamA)}</div>
          <div className="cse-pick"><span style={{ color: state.teams.B.color }}>{state.teams.B.name}</span>{sel(b1, setB1, teamB)}{twoPer && sel(b2, setB2, teamB)}</div>
          <div className="pf-coderow"><button className="primary" style={{ flex: 1 }} onClick={addMatch}>Add match</button><button className="linkbtn" onClick={() => setAdding(false)}>Cancel</button></div>
        </div>
      ) : <button className="linkbtn" onClick={() => setAdding(true)}>+ Add a pairing</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ Match scoring */
function MatchView({ state, mt, course, rosterById, result, onBack, send }: any) {
  const [h, setH] = useState(() => Math.max(0, Math.min(course.holes.length - 1, result.holesPlayed)));
  const hole = course.holes[h];
  const teamBall = isTeamBall(mt.format);
  const scoreOf = (slot: string) => (mt.scores[slot]?.[h] ?? null);
  const setScore = (slot: string, v: number | null) => send({ type: "score", matchId: mt.id, slot, hole: h, value: v });
  const holeRes = result.holeResults[h];

  const stepper = (slot: string, label: string, color?: string) => {
    const v = scoreOf(slot);
    return (
      <div className="mv-row" key={slot}>
        <span className="mv-name" style={{ color }}>{label}</span>
        <div className="mv-step">
          <button onClick={() => setScore(slot, v == null ? null : Math.max(1, v - 1))}><Minus size={17} /></button>
          <button className="mv-num" onClick={() => setScore(slot, hole.par)}>{v ?? hole.par}{v == null && <em>tap</em>}</button>
          <button onClick={() => setScore(slot, (v ?? hole.par) + 1)}><Plus size={17} /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head"><button className="backbtn" onClick={onBack}><ChevronLeft size={20} /></button><h2>{fmtLabel(mt.format)}</h2><span /></header>

      <div className="mv-status">
        <div className="mv-matchup">
          <b style={{ color: state.teams.A.color }}>{teamNames(mt.sideA, rosterById)}</b>
          <span>vs</span>
          <b style={{ color: state.teams.B.color }}>{teamNames(mt.sideB, rosterById)}</b>
        </div>
        <div className={`mv-banner ${result.final ? "fin" : ""}`}>{result.statusShort}</div>
      </div>

      <div className="mv-holebar">
        <button className="backbtn" disabled={h === 0} onClick={() => setH((i) => Math.max(0, i - 1))}><ChevronLeft size={20} /></button>
        <div className="mv-holemid"><b>Hole {hole.num}</b><span>Par {hole.par} · SI {hole.si}{holeRes && holeRes !== "halve" ? ` · ${state.teams[holeRes].name.split(" ")[0]} won` : holeRes === "halve" ? " · halved" : ""}</span></div>
        <button className="backbtn" disabled={h === course.holes.length - 1} onClick={() => setH((i) => Math.min(course.holes.length - 1, i + 1))}><ChevronRight size={20} /></button>
      </div>

      <div className="panel cup-panel">
        <div className="mv-teamlbl" style={{ color: state.teams.A.color }}>{state.teams.A.name}</div>
        {teamBall ? stepper("A", teamNames(mt.sideA, rosterById) + " (team ball)") : mt.sideA.map((id: string) => stepper(id, rosterById[id]?.name || "—"))}
        <div className="mv-teamlbl" style={{ color: state.teams.B.color, marginTop: 10 }}>{state.teams.B.name}</div>
        {teamBall ? stepper("B", teamNames(mt.sideB, rosterById) + " (team ball)") : mt.sideB.map((id: string) => stepper(id, rosterById[id]?.name || "—"))}
        <p className="hint" style={{ marginTop: 12 }}>Each player logs their own score — your group keeps each other honest. Everyone on the Cup sees it live.</p>
      </div>
    </div></div>
  );
}
