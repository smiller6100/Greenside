import { useState, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import { ChevronLeft, ChevronRight, Plus, Minus, Trophy, Users, Flag, Settings, X, Share2, Check, MessageCircle, Send, Crown, Search, MapPin, Map as MapIcon, List, RefreshCw } from "lucide-react";
import { computeMatch, cupTotals, clinch, type Format, type HcpMethod, type MatchResult } from "../lib/cup";

const HoleMapGL = lazy(() => import("../components/HoleMapGL"));
const fmtToPar = (n: number) => (n === 0 ? "E" : n > 0 ? `+${n}` : `${n}`);
const toParClass = (n: number) => (n < 0 ? "under" : n > 0 ? "over" : "even");
import { getAccount, syncDown, addAccountCup, removeAccountCup } from "../lib/account";

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

type MyCup = { code: string; name: string; ts?: number };
function getMyCups(): MyCup[] { try { return JSON.parse(localStorage.getItem("gs:cups") || "[]"); } catch { return []; } }
function addMyCup(code: string, name: string) {
  try { const list = getMyCups().filter((c) => c.code !== code); list.unshift({ code, name, ts: Date.now() }); localStorage.setItem("gs:cups", JSON.stringify(list.slice(0, 40))); } catch { /* */ }
  addAccountCup(code, name); // mirror to the account so it follows the login across devices
}
function forgetMyCup(code: string) {
  try { localStorage.setItem("gs:cups", JSON.stringify(getMyCups().filter((c) => c.code !== code))); } catch { /* */ }
  removeAccountCup(code);
}

// Current team totals for a Cup state (banked), plus whether every match is final.
function scoreCup(state: any): { a: number; b: number; matches: number; allDone: boolean } {
  const course = state.course || DEMO_COURSE;
  const pars: number[] = course.holes.map((h: any) => h.par);
  const sis: number[] = course.holes.map((h: any) => h.si);
  const byId: Record<string, any> = Object.fromEntries((state.roster || []).map((p: any) => [p.id, p]));
  const results = (state.matches || []).map((mt: any) => {
    const sideA = mt.sideA.map((id: string) => ({ id, hcp: byId[id]?.hcp || 0 }));
    const sideB = mt.sideB.map((id: string) => ({ id, hcp: byId[id]?.hcp || 0 }));
    const gross: Record<string, (number | null)[]> = {};
    if (isTeamBall(mt.format)) { gross["A"] = mt.scores["A"] || []; gross["B"] = mt.scores["B"] || []; }
    else for (const id of [...mt.sideA, ...mt.sideB]) gross[id] = mt.scores[id] || [];
    return computeMatch({ format: mt.format, method: state.method, sideA, sideB, gross, course: { pars, sis } });
  });
  const t = cupTotals(results);
  return { a: t.banked.A, b: t.banked.B, matches: results.length, allDone: results.length > 0 && results.every((r) => r.final) };
}

export default function Cup() {
  const [code, setCode] = useState<string | null>(parseCup());
  useEffect(() => { const on = () => setCode(parseCup()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return code ? <CupBoard code={code} /> : <CupHome />;
}

/* ------------------------------------------------------------------ Home list */
function CupHome() {
  const [cups, setCups] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      if (getAccount()) { try { await syncDown(); } catch { /* */ } } // pull cups saved to the account on other devices
      const mine = getMyCups();
      if (!alive) return;
      if (!mine.length) { setCups([]); return; }
      const loaded = await Promise.all(mine.map(async (c) => {
        try { const r = await fetch("/api/cup/" + c.code); if (!r.ok) return { code: c.code, name: c.name, gone: true }; const s = await r.json(); return { code: c.code, name: s.name, teams: s.teams, score: scoreCup(s) }; }
        catch { return { code: c.code, name: c.name, offline: true }; }
      }));
      if (alive) setCups(loaded);
    })();
    return () => { alive = false; };
  }, []);

  if (creating) return <CupCreate onBack={() => setCreating(false)} />;

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head"><button className="backbtn" onClick={() => { location.hash = ""; }}><ChevronLeft size={20} /></button><h2>Ryder Cup</h2><span /></header>
      <div className="panel">
        <button className="primary" onClick={() => setCreating(true)}><Trophy size={16} style={{ marginRight: 6, verticalAlign: "-3px" }} /> Create a new Cup</button>
        <div className="pf-coderow" style={{ marginTop: 10 }}>
          <input className="dash-pw" style={{ margin: 0 }} value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="Join with a Cup code" maxLength={6} />
          <button className="primary pf-codebtn" disabled={joinCode.length < 4} onClick={() => { location.hash = "#/cup/" + joinCode; }}><ChevronRight size={16} /></button>
        </div>

        {cups === null ? <p className="hint" style={{ textAlign: "center", marginTop: 18 }}><span className="spin sm" /> Loading your cups…</p> : cups.length === 0 ? (
          <p className="hint" style={{ textAlign: "center", marginTop: 18 }}>No cups yet. Create one for your next guys' trip, or join with a code.</p>
        ) : (
          <div className="cuphome-list">
            <div className="cup-sub" style={{ marginTop: 18 }}><Trophy size={14} /> My cups</div>
            {cups.map((c) => (
              <button key={c.code} className="cuphome-item" onClick={() => { location.hash = "#/cup/" + c.code; }}>
                <div className="chi-main">
                  <b>{c.name}</b>
                  {c.gone ? <span className="chi-sub">no longer available</span>
                    : c.offline ? <span className="chi-sub">offline — tap to open</span>
                    : c.score.matches === 0 ? <span className="chi-sub">setup · {c.code}</span>
                    : <span className="chi-sub">{c.teams.A.name} {fmtPts(c.score.a)} – {fmtPts(c.score.b)} {c.teams.B.name}{c.score.allDone ? " · final" : ""}</span>}
                </div>
                {!c.gone && !c.offline && c.score.matches > 0 && (
                  <span className="chi-badge" style={{ background: c.score.allDone ? (c.score.a > c.score.b ? c.teams.A.color : c.score.b > c.score.a ? c.teams.B.color : "#6b7280") : "#fff4d6", color: c.score.allDone ? "#fff" : "#7a5a00" }}>
                    {c.score.allDone ? (c.score.a > c.score.b ? "A wins" : c.score.b > c.score.a ? "B wins" : "Tied") : "Live"}
                  </span>
                )}
                {c.gone && <span className="chi-x" onClick={(e) => { e.stopPropagation(); forgetMyCup(c.code); setCups((cs) => (cs || []).filter((x) => x.code !== c.code)); }}><X size={14} /></span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div></div>
  );
}

/* ------------------------------------------------------------------ Create / Join */
function CupCreate({ onBack }: { onBack?: () => void }) {
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
      if (d.code) { try { localStorage.setItem("gs:cup:" + d.code + ":token", d.adminToken); } catch { /* */ } addMyCup(d.code, name.trim() || "Ryder Cup"); location.hash = "#/cup/" + d.code; }
    } finally { setBusy(false); }
  };

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head"><button className="backbtn" onClick={() => { onBack ? onBack() : (location.hash = ""); }}><ChevronLeft size={20} /></button><h2>New Cup</h2><span /></header>
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

  // Remember any Cup I open so it lists on the Ryder Cup home.
  useEffect(() => { if (state?.name) addMyCup(code, state.name); }, [code, state?.name]);

  // Who am I in this Cup — a roster entry I registered by joining with the code. When signed in we
  // key identity to the account id so the same person is recognized on any device they log into;
  // otherwise a per-device random id is stored.
  const acct = getAccount();
  const meId = useRef<string>("");
  try { meId.current = localStorage.getItem("gs:cup:" + code + ":me") || (acct ? "acct_" + acct.id : ""); } catch { /* */ }
  const mePlayer = state?.roster?.find((p: any) => p.id === meId.current) || null;
  // My role: commissioner (holds the token), captain of a team, or ordinary player.
  const myCaptainTeam: "A" | "B" | null = state?.captains?.A === meId.current ? "A" : state?.captains?.B === meId.current ? "B" : null;
  const canSetup = isAdmin || !!myCaptainTeam;
  const [joinName, setJoinName] = useState(acct?.name || ""); const [joinHcp, setJoinHcp] = useState("");
  const doJoin = () => {
    const n = joinName.trim(); if (!n) return;
    let id = meId.current;
    if (!id) { id = Math.random().toString(36).slice(2, 10); meId.current = id; }
    try { localStorage.setItem("gs:cup:" + code + ":me", id); } catch { /* */ }
    send({ type: "join", id, name: n, hcp: parseInt(joinHcp) || 0 });
    setJoinHcp("");
  };

  // Group chat (same as a round).
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const chatLen = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement | null>(null);
  const chatMsgs = (state?.chat as any[]) || [];
  useEffect(() => {
    const nn = chatMsgs.length;
    if (chatLen.current === null) { chatLen.current = nn; return; }
    if (nn > chatLen.current && !chatOpen) setChatUnread((u) => u + (nn - chatLen.current!));
    chatLen.current = nn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMsgs.length]);
  useEffect(() => { if (chatOpen) chatEnd.current?.scrollIntoView({ block: "end" }); }, [chatOpen, chatMsgs.length]);
  const sendChatMsg = () => { const t = chatText.trim(); if (!t || !mePlayer) return; send({ type: "chat", name: mePlayer.name, text: t }); setChatText(""); };

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
    return <MatchView state={state} mt={mt} course={course} rosterById={rosterById} result={resultFor(mt)} onBack={() => setMatchId(null)} send={send} meId={meId.current} />;
  }

  const allResults = state.matches.map(resultFor);
  const totals = cupTotals(allResults);
  const need = clinch(state.matches.length || 0);

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={() => { location.hash = ""; }}><ChevronLeft size={20} /></button>
        <h2>{state.name}</h2>
        <div className="cup-head-btns">
          <button className="backbtn chatbtn" onClick={() => { setChatOpen(true); setChatUnread(0); }} aria-label="Group chat"><MessageCircle size={18} />{chatUnread > 0 && <span className="chatbadge">{chatUnread > 9 ? "9+" : chatUnread}</span>}</button>
          <button className="backbtn" onClick={() => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}); }} aria-label="share">{copied ? <Check size={18} /> : <Share2 size={18} />}</button>
        </div>
      </header>

      {!mePlayer && (
        <div className="cup-join">
          <div className="cj-h"><Users size={15} /> Join this Cup</div>
          <p>Add yourself so you can be put on a team.</p>
          <div className="pf-coderow">
            <input className="dash-pw" style={{ margin: 0, flex: 2 }} value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Your name" />
            <input className="dash-pw" style={{ margin: 0, width: 56, flex: "none", textAlign: "center" }} value={joinHcp} onChange={(e) => setJoinHcp(e.target.value.replace(/[^0-9]/g, ""))} placeholder="hcp" />
            <button className="primary pf-codebtn" disabled={!joinName.trim()} onClick={doJoin}><Check size={16} /></button>
          </div>
        </div>
      )}
      {mePlayer && !mePlayer.team && <div className="cup-waiting">You're in as <b>{mePlayer.name}</b> — waiting to be assigned a team.</div>}

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
      {state.matches.length > 0 && (() => {
        const total = state.matches.length;
        const pct = (n: number) => `${Math.max(0, (n / total) * 100)}%`;
        const aB = totals.banked.A, bB = totals.banked.B, aP = totals.projected.A, bP = totals.projected.B;
        return (
          <div className="cup-track">
            <div className="ct-bar">
              <div className="cts" style={{ width: pct(aB), background: state.teams.A.color }} />
              <div className="cts" style={{ width: pct(aP - aB), background: state.teams.A.color, opacity: 0.4 }} />
              <div className="cts ct-gap" />
              <div className="cts" style={{ width: pct(bP - bB), background: state.teams.B.color, opacity: 0.4 }} />
              <div className="cts" style={{ width: pct(bB), background: state.teams.B.color }} />
              <span className="ct-center" />
            </div>
            <div className="ct-cap">
              <b style={{ color: state.teams.A.color }}>{fmtPts(aB)}{aP > aB ? ` → ${fmtPts(aP)}` : ""}</b>
              <span><Trophy size={11} /> {fmtPts(need.toWin)} to win</span>
              <b style={{ color: state.teams.B.color }}>{bP > bB ? `${fmtPts(bP)} ← ` : ""}{fmtPts(bB)}</b>
            </div>
          </div>
        );
      })()}

      <div className="cup-tabs">
        <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}><Flag size={15} /> Matches</button>
        {canSetup && <button className={view === "setup" ? "on" : ""} onClick={() => setView("setup")}><Settings size={15} /> {isAdmin ? "Setup" : "My team"}</button>}
      </div>

      {view === "board" ? (
        <div className="panel cup-panel">
          {state.sessions.length === 0 && <p className="hint" style={{ textAlign: "center" }}>{isAdmin ? "No sessions yet — open Setup to build the weekend and set pairings." : "The commissioner hasn't set up any sessions yet."}</p>}
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
        <CupSetup state={state} send={send} isAdmin={isAdmin} captainTeam={myCaptainTeam} meId={meId.current} />
      )}
      <div className="cup-code-foot">Cup code <b>{code}</b> · share it so everyone sees the same board</div>

      {chatOpen && (
        <div className="chatwrap" onClick={() => setChatOpen(false)}>
          <div className="chatcard" onClick={(e) => e.stopPropagation()}>
            <div className="chathead"><div><h3>Cup chat</h3><span className="chatsub">Everyone in {code}</span></div><button className="xbtn" onClick={() => setChatOpen(false)}>✕</button></div>
            <div className="chatlog">
              {chatMsgs.length === 0 && <div className="chatempty">No messages yet. Trash talk, pairings, tee times — go.</div>}
              {chatMsgs.map((m: any) => {
                const mine = !!mePlayer && m.name === mePlayer.name;
                return (
                  <div key={m.id} className={`chatmsg ${mine ? "mine" : ""}`}>
                    {!mine && <span className="chatname">{m.name}</span>}
                    <span className="chatbubble">{m.text}</span>
                    <span className="chatts">{new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                );
              })}
              <div ref={chatEnd} />
            </div>
            <div className="chatinput">
              <input value={chatText} maxLength={280} placeholder={mePlayer ? "Message the group…" : "Join the Cup to chat"} disabled={!mePlayer}
                onChange={(e) => setChatText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendChatMsg(); }} />
              <button onClick={sendChatMsg} disabled={!mePlayer || !chatText.trim()} aria-label="Send"><Send size={18} /></button>
            </div>
            {!mePlayer && <div className="chatclaim">Join the Cup above to chat.</div>}
          </div>
        </div>
      )}
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
    <button className={`cup-match ${statusCls}`} onClick={onOpen}>
      <span className="cm-accent" style={{ background: lead ? state.teams[lead].color : "var(--line)" }} />
      <div className="cm-sides">
        <span className={`cm-side ${lead === "A" ? "win" : result.final && lead !== "A" ? "lose" : ""}`} style={{ color: lead === "A" ? state.teams.A.color : undefined }}>{a}</span>
        <span className="cm-v">v</span>
        <span className={`cm-side ${lead === "B" ? "win" : result.final && lead !== "B" ? "lose" : ""}`} style={{ color: lead === "B" ? state.teams.B.color : undefined }}>{b}</span>
      </div>
      <div className={`cm-status ${statusCls}`}>{statusCls === "live" && <span className="cm-pulse" />}{result.label === "—" ? "—" : result.label}</div>
    </button>
  );
}

/* ------------------------------------------------------------------ Setup (role-aware) */
function CupSetup(props: any) {
  // Commissioner gets the full console; a captain gets only their draft/team view; nobody else
  // reaches this (the Setup tab is hidden for ordinary players).
  return props.isAdmin ? <CommissionerSetup {...props} /> : <CaptainSetup {...props} />;
}

// What a captain sees: their squad, and — when the commissioner has chosen a draft — the board to
// pick their team when it's their turn. No course, sessions, or settings.
function CaptainSetup({ state, send, captainTeam, meId }: any) {
  const team = state.teams[captainTeam];
  return (
    <div className="panel cup-panel">
      <div className="cup-sub"><Crown size={14} /> You're captain of <b style={{ color: team.color, marginLeft: 4 }}>{team.name}</b></div>
      {state.teamMode === "draft" ? (
        <DraftPanel state={state} send={send} isAdmin={false} captainTeam={captainTeam} meId={meId} />
      ) : (
        <p className="hint" style={{ textAlign: "center" }}>The commissioner is assigning teams directly. Your squad appears below as it fills in.</p>
      )}
      <TeamColumns state={state} />
    </div>
  );
}

// What the commissioner sees: everything.
function CommissionerSetup({ state, send, meId }: any) {
  const unassigned = state.roster.filter((p: any) => !p.team);
  const draftMode = state.teamMode === "draft";
  // Manual A/B buttons are available except while a draft is actively on the clock — so the
  // commissioner can still place a late joiner before the draft starts or after it finishes.
  const canManualAssign = !draftMode || !state.draft.turn;

  return (
    <div className="panel cup-panel">
      {/* Course */}
      <div className="cup-sub"><MapPin size={14} /> Course</div>
      <CoursePicker state={state} send={send} />

      {/* Captains */}
      <div className="cup-sub" style={{ marginTop: 20 }}><Crown size={14} /> Captains</div>
      <CaptainPicker state={state} send={send} />

      {/* How teams are picked */}
      <div className="cup-sub" style={{ marginTop: 20 }}><Users size={14} /> How teams are picked</div>
      <div className="cup-modeseg">
        <button className={!draftMode ? "on" : ""} onClick={() => send({ type: "teamMode", mode: "assign" })}>I assign teams</button>
        <button className={draftMode ? "on" : ""} onClick={() => send({ type: "teamMode", mode: "draft" })}>Captains draft</button>
      </div>

      {draftMode && <DraftPanel state={state} send={send} isAdmin={true} captainTeam={null} meId={meId} />}

      {/* Roster */}
      <div className="cup-sub" style={{ marginTop: 20 }}><Flag size={14} /> Players &amp; teams</div>
      <TeamColumns state={state} send={send} />
      {unassigned.length > 0 && (
        <div className="cup-unassigned">
          {draftMode && state.draft.turn ? (
            <span className="cu-lbl">Still in the draft pool — captains are picking above.</span>
          ) : draftMode && state.draft.started ? (
            <span className="cu-lbl">Joined after the draft — drop them on a team:</span>
          ) : draftMode ? (
            <span className="cu-lbl">Waiting in the pool — start the draft above, or drop them on a team:</span>
          ) : (
            <span className="cu-lbl">Tap to assign a team:</span>
          )}
          {unassigned.map((p: any) => (
            <div key={p.id} className="cu-p">
              <span>{p.name} <em>{p.hcp}</em></span>
              <div className="cu-btns">
                {canManualAssign && <button style={{ background: state.teams.A.color }} onClick={() => send({ type: "rosterUpdate", id: p.id, team: "A" })}>{state.teams.A.name.split(" ")[0]}</button>}
                {canManualAssign && <button style={{ background: state.teams.B.color }} onClick={() => send({ type: "rosterUpdate", id: p.id, team: "B" })}>{state.teams.B.name.split(" ")[0]}</button>}
                <button className="cu-x" onClick={() => send({ type: "rosterRemove", id: p.id })}><X size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {state.roster.length === 0 && <p className="hint" style={{ marginTop: 8 }}>Share the Cup code (below) — everyone joins on their own phone and their names appear here automatically, each set to their own handicap.</p>}

      {/* Sessions */}
      <div className="cup-sub" style={{ marginTop: 20 }}><Flag size={14} /> Sessions</div>
      {state.sessions.map((s: any) => <SessionEditor key={s.id} s={s} state={state} send={send} />)}
      <AddSession send={send} />
    </div>
  );
}

// Read-only (or commissioner-editable) team columns, with a crown on each captain.
function TeamColumns({ state, send }: any) {
  return (
    <>
      {(["A", "B"] as const).map((side) => {
        const members = state.roster.filter((p: any) => p.team === side);
        return (
          <div key={side} className="cup-roster-team">
            <div className="crt-h" style={{ color: state.teams[side].color }}>{state.teams[side].name}</div>
            <div className="crt-list">
              {members.map((p: any) => {
                const isCap = state.captains?.[side] === p.id;
                return (
                  <div key={p.id} className="crt-p">
                    <span>{isCap && <Crown size={12} className="crt-crown" />}{p.name}<em>{p.hcp}</em></span>
                    {send && !isCap && <button onClick={() => send({ type: "rosterUpdate", id: p.id, team: null })} aria-label="unassign"><X size={13} /></button>}
                  </div>
                );
              })}
              {members.length === 0 && <span className="crt-empty">—</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

// Commissioner picks the real course via the same search the rest of the app uses.
function CoursePicker({ state, send }: any) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = state.course;
  const isDemo = !cur || cur.name === "Demo Course";

  useEffect(() => {
    if (!editing || q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/courses/search?q=${encodeURIComponent(q.trim())}`); const d = await r.json(); setResults(d.courses || []); } catch { /* */ }
    }, 250);
    return () => clearTimeout(t);
  }, [q, editing]);

  const pick = async (hit: any) => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`/api/courses/${hit.id}`);
      const d = await r.json();
      const holes = (d.holes || []).filter((h: any) => h.num >= 1 && h.num <= 18).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
      if (!holes.length) { setMsg("That course has no scorecard yet — scan it from the main screen first."); setBusy(false); return; }
      // Keep the course coordinates so cup matches can show the satellite hole view.
      send({ type: "course", course: { name: d.name || hit.name, where: d.where || hit.where || "", lat: d.lat ?? hit.lat ?? null, lng: d.lng ?? hit.lng ?? null, holes } });
      setEditing(false); setQ(""); setResults([]);
    } catch { setMsg("Couldn't load that course."); } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <div className="cup-course">
        <div className="cc-cur">
          <div><b>{cur?.name || "No course set"}</b>{cur?.where ? <em>{cur.where}</em> : null}{isDemo && <span className="cc-demo">placeholder par-72 — set the real course</span>}</div>
          <button className="linkbtn" onClick={() => setEditing(true)}>Change</button>
        </div>
      </div>
    );
  }
  return (
    <div className="cup-course">
      <div className="cc-search">
        <Search size={15} />
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setMsg(""); }} placeholder="Search course name…" />
        <button className="linkbtn" onClick={() => { setEditing(false); setQ(""); setMsg(""); }}>Cancel</button>
      </div>
      {busy && <p className="hint"><span className="spin sm" /> Loading…</p>}
      {msg && <p className="hint">{msg}</p>}
      {results.map((hit) => (
        <button key={hit.id} className="cc-hit" onClick={() => pick(hit)}>
          <b>{hit.name}</b>{hit.where ? <em>{hit.where}</em> : null}
        </button>
      ))}
    </div>
  );
}

// Commissioner sets each team's captain from the people who've joined.
function CaptainPicker({ state, send }: any) {
  return (
    <div className="cup-caps">
      {(["A", "B"] as const).map((side) => (
        <div key={side} className="cap-row">
          <span className="cap-team" style={{ color: state.teams[side].color }}><Crown size={13} /> {state.teams[side].name}</span>
          <select className="cup-sel" value={state.captains?.[side] || ""} onChange={(e) => send({ type: "setCaptain", team: side, id: e.target.value || null })}>
            <option value="">— pick captain —</option>
            {state.roster.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      ))}
      {state.roster.length === 0 && <p className="hint">Nobody's joined yet. Share the code — names show up here as people join, then pick your captains.</p>}
    </div>
  );
}

// The draft board. Straight alternating A,B,A,B; the DO enforces who may pick and when.
function DraftPanel({ state, send, isAdmin, captainTeam, meId }: any) {
  const { teams, captains, draft } = state;
  const pool = state.roster.filter((p: any) => !p.team);
  const turn = draft.turn as ("A" | "B" | null);
  const bothCaps = captains?.A && captains?.B;
  const myTurn = !!turn && (isAdmin || captainTeam === turn);
  const nameOf = (id: string) => state.roster.find((p: any) => p.id === id)?.name?.split(" ")[0] || "—";

  return (
    <div className="cup-draft">
      {isAdmin && !draft.started && (
        <div className="cd-setup">
          <div className="cd-first"><span>First pick</span>
            {(["A", "B"] as const).map((s) => (
              <button key={s} className={`cd-firstbtn ${draft.first === s ? "on" : ""}`} style={draft.first === s ? { background: teams[s].color, borderColor: teams[s].color, color: "#fff" } : { borderColor: teams[s].color, color: teams[s].color }} onClick={() => send({ type: "draftFirst", team: s })}>{teams[s].name.split(" ")[0]}</button>
            ))}
          </div>
          <button className="primary" disabled={!bothCaps} onClick={() => send({ type: "draftStart" })}>{bothCaps ? "Start the draft" : "Set both captains first"}</button>
        </div>
      )}

      {draft.started && turn && (
        <div className="cd-turn" style={{ borderColor: teams[turn].color }}>
          <span className="cd-dot" style={{ background: teams[turn].color }} />
          <span><b style={{ color: teams[turn].color }}>{teams[turn].name}</b> on the clock — {nameOf(captains[turn])} picks{myTurn ? " · your pick" : ""}</span>
        </div>
      )}
      {draft.started && !turn && <div className="cd-done"><Check size={15} /> Draft complete — every player is on a team.</div>}

      {pool.length > 0 && (
        <div className="cd-pool">
          <span className="cd-poollbl">In the pool ({pool.length})</span>
          <div className="cd-chips">
            {pool.map((p: any) => (
              <button key={p.id} className={`cd-chip ${myTurn ? "pick" : ""}`} disabled={!myTurn} onClick={() => myTurn && send({ type: "draftPick", playerId: p.id, me: meId })}>
                {p.name}<em>{p.hcp}</em>
              </button>
            ))}
          </div>
          {draft.started && turn && !myTurn && <p className="hint" style={{ marginTop: 6 }}>Waiting for {teams[turn].name} to pick.</p>}
          {!draft.started && !isAdmin && <p className="hint" style={{ marginTop: 6 }}>Waiting for the commissioner to start the draft.</p>}
        </div>
      )}

      {isAdmin && draft.started && <button className="linkbtn" style={{ marginTop: 8 }} onClick={() => send({ type: "draftReset" })}>Reset draft</button>}
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
function MatchView({ state, mt, course, rosterById, result, onBack, send, meId }: any) {
  const [h, setH] = useState(() => Math.max(0, Math.min(course.holes.length - 1, result.holesPlayed)));
  const hole = course.holes[h];
  const teamBall = isTeamBall(mt.format);
  const scoreOf = (slot: string) => (mt.scores[slot]?.[h] ?? null);
  const setScore = (slot: string, v: number | null) => send({ type: "score", matchId: mt.id, slot, hole: h, value: v });
  const holeRes = result.holeResults[h];
  const mySide: "A" | "B" | null = mt.sideA.includes(meId) ? "A" : mt.sideB.includes(meId) ? "B" : null;

  // Satellite hole view, fed by the course's banked hole geometry (same source as a normal round).
  const lat = state.course?.lat, lng = state.course?.lng;
  const [holeMap, setHoleMap] = useState<any>(null);
  const [satView, setSatView] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (lat == null || lng == null) { setHoleMap({ available: false }); return; }
    setHoleMap(null);
    const ctrl = new AbortController();
    fetch(`/api/holemap?lat=${lat}&lng=${lng}&holes=${course.holes.length}`, { cache: "no-store", signal: ctrl.signal })
      .then((r) => r.json()).then(setHoleMap).catch(() => setHoleMap({ available: false, retry: true }));
    return () => ctrl.abort();
  }, [lat, lng, course.holes.length, reload]);
  const hm = holeMap?.available ? holeMap.holes.find((x: any) => x.ref === hole.num) : null;
  const mapReady = !!hm;

  // GPS for "from you" distances (optional; distances fall back to the tee without it).
  const [gps, setGps] = useState<{ lat: number; lng: number; acc?: number } | null>(null);
  const [gpsErr, setGpsErr] = useState("");
  const watch = useRef<number | null>(null);
  const toggleGps = () => {
    if (watch.current != null) { navigator.geolocation.clearWatch(watch.current); watch.current = null; setGps(null); return; }
    if (!navigator.geolocation) { setGpsErr("Location isn't available on this device."); return; }
    setGpsErr("locating");
    watch.current = navigator.geolocation.watchPosition(
      (p) => { setGpsErr(""); setGps({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); },
      () => setGpsErr("Couldn't get your location."),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
  };
  useEffect(() => () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); }, []);

  const curVal = (slot: string) => mt.scores[slot]?.[h] ?? null;
  const adjust = (slot: string, d: number) => setScore(slot, Math.max(1, Math.min(20, (curVal(slot) ?? hole.par) + d)));
  const slotToPar = (slot: string) => { const arr = mt.scores[slot] || []; let tp = 0, n = 0; course.holes.forEach((hh: any, i: number) => { const v = arr[i]; if (v != null) { tp += v - hh.par; n++; } }); return { txt: n ? fmtToPar(tp) : "", cls: toParClass(tp) }; };
  const glPlayers = (teamBall
    ? (["A", "B"] as const).map((side) => { const s = slotToPar(side); return { id: side, name: state.teams[side].name, isMe: mySide === side, val: curVal(side), toParTxt: s.txt, toParCls: s.cls }; })
    : [...mt.sideA, ...mt.sideB].map((id: string) => { const s = slotToPar(id); return { id, name: rosterById[id]?.name || "—", isMe: id === meId, val: curVal(id), toParTxt: s.txt, toParCls: s.cls }; })
  ).sort((a, b) => (a.isMe ? -1 : 0) - (b.isMe ? -1 : 0));

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
          <b><span className="mv-dot" style={{ background: state.teams.A.color }} />{teamNames(mt.sideA, rosterById)}</b>
          <span>vs</span>
          <b><span className="mv-dot" style={{ background: state.teams.B.color }} />{teamNames(mt.sideB, rosterById)}</b>
        </div>
        <div className={`mv-banner ${result.final ? "fin" : ""}`}>{result.statusShort}</div>
      </div>

      {mapReady && (
        <div className="mv-viewtoggle">
          <button className={satView ? "on" : ""} onClick={() => setSatView(true)}><MapIcon size={14} /> Map</button>
          <button className={!satView ? "on" : ""} onClick={() => setSatView(false)}><List size={14} /> Card</button>
        </div>
      )}

      {mapReady && satView ? (
        <div className="holemap-wrap">
          <Suspense fallback={<div className="holemap-empty"><span className="spin sm" /> Loading satellite…</div>}>
            <HoleMapGL key={hole.num} hole={hm} me={gps}
              nav={{ num: hole.num, par: hole.par, yards: hole.yards, si: hole.si, onPrev: () => setH((i) => Math.max(0, i - 1)), onNext: () => setH((i) => Math.min(course.holes.length - 1, i + 1)), canPrev: h > 0, canNext: h < course.holes.length - 1 }}
              players={glPlayers}
              onAdjust={(id, d) => adjust(id, d)}
              onScorePar={(id) => setScore(id, hole.par)} />
          </Suspense>
          <button className={`locbtn ${gps ? "on" : ""}`} onClick={toggleGps}>
            <MapPin size={15} />{gps ? "Stop tracking" : gpsErr === "locating" ? "Locating…" : "Show my distance"}
          </button>
          {gpsErr && gpsErr !== "locating" && <div className="loc-err">{gpsErr}</div>}
          <p className="hint" style={{ marginTop: 8 }}>You log your own score on the hole; your group keeps each other honest. Everyone sees it live.</p>
        </div>
      ) : (
        <>
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
            {holeMap && !holeMap.available && state.course?.lat != null && <button className="hm-maplink" onClick={() => setReload((n) => n + 1)} style={{ marginTop: 10 }}><RefreshCw size={13} /> Try the satellite view again</button>}
            <p className="hint" style={{ marginTop: 12 }}>Each player logs their own score — your group keeps each other honest. Everyone on the Cup sees it live.</p>
          </div>
        </>
      )}
    </div></div>
  );
}
