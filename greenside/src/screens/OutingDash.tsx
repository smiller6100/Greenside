import { useState, useEffect, useRef } from "react";
import { ChevronLeft, RotateCcw, Lock, Search, Copy, Check } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { computeStandings, fmtToPar } from "../lib/golf";

type Hole = { num: number; par: number; yards: number; si: number };
type Tee = { name: string; total: number; holes: Hole[] };
type PickedCourse = { name: string; where: string; lat: number | null; lng: number | null; holes: Hole[]; tees: Tee[]; defaultTee: string };

// Password-gated organizer cockpit. The coordinator creates and runs the outing here — they never
// play. Attendees join their own foursome by QR/code (built below). v1 pace is a thru-vs-elapsed
// estimate; live GPS comes later.
export default function OutingDash() {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [mode, setMode] = useState<"new" | "watch">("new");

  // Watch / load existing
  const [code, setCode] = useState("");
  const [state, setState] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(0);
  const codeRef = useRef("");

  // New outing builder
  const [cQuery, setCQuery] = useState("");
  const [cResults, setCResults] = useState<any[]>([]);
  const [cCourse, setCCourse] = useState<PickedCourse | null>(null);
  const [cTitle, setCTitle] = useState("");
  const [cDate, setCDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [cGroups, setCGroups] = useState(4);
  const [cFormats, setCFormats] = useState<Record<string, boolean>>({ net: true, gross: true });
  const [showPairings, setShowPairings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cMsg, setCMsg] = useState("");
  const [copied, setCopied] = useState("");

  const goHome = () => { location.hash = ""; };

  const checkPw = async () => {
    setAuthMsg("");
    try {
      const r = await fetch("/api/admin/check", { method: "POST", headers: { "x-admin-key": pw } });
      const d = await r.json();
      if (d.ok) setAuthed(true);
      else setAuthMsg(d.configured === false ? "Admin password isn't set up yet." : "Wrong password.");
    } catch { setAuthMsg("Couldn't reach the server."); }
  };

  const load = async (c: string) => {
    const cc = c.trim().toUpperCase();
    if (!cc) return;
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/round/${cc}`);
      if (!r.ok) { setErr("No outing found for that code."); setState(null); }
      else { setState(await r.json()); setUpdated(Date.now()); }
    } catch { setErr("Couldn't load that outing."); }
    setLoading(false);
  };
  const start = () => { codeRef.current = code.trim().toUpperCase(); load(codeRef.current); };

  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => { if (codeRef.current) load(codeRef.current); }, 15000);
    return () => clearInterval(id);
  }, [authed]);

  // Course search for the builder (mirrors Home).
  useEffect(() => {
    if (cCourse || cQuery.trim().length < 2) { setCResults([]); return; }
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/courses/search?q=${encodeURIComponent(cQuery.trim())}`); const d = await r.json(); setCResults(d.courses || []); } catch { /* */ }
    }, 250);
    return () => clearTimeout(t);
  }, [cQuery, cCourse]);

  const pickCourse = async (hit: any) => {
    setCMsg(""); setCResults([]);
    try {
      const r = await fetch(`/api/courses/${hit.id}`);
      const data = await r.json();
      const holes: Hole[] = (data.holes || []).filter((h: any) => h.num >= 1 && h.num <= 18).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
      if (!holes.length) { setCMsg("That course has no scorecard data — scan it from the main screen first."); return; }
      const tees: Tee[] = (data.tees || []).map((t: any) => ({ name: t.name, total: t.total, holes: (t.holes || []).filter((h: any) => h.num <= 18).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si })) }));
      const tfinal = tees.length ? tees : [{ name: "Tees", total: holes.reduce((s, h) => s + (h.yards || 0), 0), holes }];
      setCCourse({ name: data.name || hit.name, where: data.where || hit.where || "", lat: data.lat ?? hit.lat ?? null, lng: data.lng ?? hit.lng ?? null, holes, tees: tfinal, defaultTee: data.defaultTee || tfinal[0]?.name || "" });
      setCQuery(data.name || hit.name);
    } catch { setCMsg("Couldn't load that course."); }
  };

  const createOuting = async () => {
    if (!cCourse) { setCMsg("Pick a course first."); return; }
    setCreating(true); setCMsg("");
    const payload = {
      name: cTitle.trim() || `${cCourse.name} Outing`,
      date: cDate,
      formats: cFormats,
      games: { wolf: false, nines: false, sixes: false, vegas: false, nassau: false, bbb: false, bestball: false },
      outing: true, roundType: "outing", groupCount: cGroups, handicapMode: "perhole",
      course: cCourse.holes, lat: cCourse.lat, lng: cCourse.lng,
      courseName: cCourse.name, courseWhere: cCourse.where, teeName: cCourse.defaultTee,
      tees: cCourse.tees, defaultTee: cCourse.defaultTee,
      catalogHoles: cCourse.holes, catalogTees: cCourse.tees, players: [],
    };
    try {
      const r = await fetch("/api/round", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (d.code) { codeRef.current = d.code; await load(d.code); setMode("watch"); }
      else setCMsg("Couldn't create the outing.");
    } catch { setCMsg("Couldn't create the outing."); }
    setCreating(false);
  };

  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1400); } catch { /* */ }
  };

  // ---------- Gate ----------
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

  // ---------- Cockpit ----------
  const fmt = (["net", "gross", "stableford", "chicago"].find((f) => state?.formats?.[f]) || "net") as string;
  const useNet = state?.handicapMode !== "gross" && fmt === "net";
  const standings = state ? computeStandings(state, fmt) : [];
  const byId: Record<string, any> = Object.fromEntries(standings.map((s: any) => [s.id, s]));
  const holes = state?.course?.length || 18;
  const elapsedMin = state?.createdAt ? (Date.now() - state.createdAt) / 60000 : 0;
  const expected = Math.max(0, Math.min(holes, Math.floor(elapsedMin / 13)));
  const groups: Record<string, any[]> = {};
  (state?.players || []).forEach((p: any) => { const g = p.group || "A"; (groups[g] ||= []).push(p); });
  const groupKeys = Object.keys(groups).sort();
  const groupThru = (g: string) => Math.max(0, ...groups[g].map((p) => byId[p.id]?.thru || 0));
  const paceOf = (thru: number) => { const b = expected - thru; if (b >= 2) return { label: "Behind", cls: "behind" }; if (b <= -1) return { label: "Ahead", cls: "ahead" }; return { label: "On pace", cls: "onpace" }; };
  const val = (s: any) => (s ? `${s.gross || "–"} (${fmtToPar(useNet ? s.toParNet : s.toParGross)})` : "—");
  const gc = state?.groupCount || groupKeys.length || 1;
  const joinBase = `${location.origin}${location.pathname}#/r/${codeRef.current}`;
  const dateLabel = state?.date ? new Date(state.date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const registered = state?.players?.length || 0;
  const anyScores = standings.some((s: any) => s.thru > 0);

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button>
        <h2>Outing dashboard</h2>
        {state ? <button className="backbtn" onClick={() => codeRef.current && load(codeRef.current)} aria-label="refresh"><RotateCcw size={17} /></button> : <span />}
      </header>

      <div className="panel">
        {!state && (
          <>
            <div className="seg" style={{ marginBottom: 18 }}>
              <button className={`seg-btn ${mode === "new" ? "on" : ""}`} onClick={() => setMode("new")}>New outing</button>
              <button className={`seg-btn ${mode === "watch" ? "on" : ""}`} onClick={() => setMode("watch")}>Open by code</button>
            </div>

            {mode === "watch" && (
              <div className="dash-load">
                <input className="dash-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Outing code" maxLength={6} onKeyDown={(e) => e.key === "Enter" && start()} />
                <button className="ghostbtn" onClick={start} disabled={loading}>{loading ? "Loading…" : "Open"}</button>
              </div>
            )}
            {mode === "watch" && err && <p className="err">{err}</p>}

            {mode === "new" && (
              <>
                <div className="field"><span>Outing name</span>
                  <input className="dash-pw" style={{ margin: 0 }} value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder="e.g. Riverside Charity Scramble" />
                </div>

                <div className="field"><span>Course</span>
                  {!cCourse ? (
                    <>
                      <div className="searchbox"><Search size={16} className="si" /><input value={cQuery} onChange={(e) => setCQuery(e.target.value)} placeholder="Search courses" /></div>
                      {cResults.length > 0 && (
                        <div className="hitlist">{cResults.slice(0, 6).map((h) => (
                          <button key={h.id} className="hit" onClick={() => pickCourse(h)}><b>{h.name}</b>{h.where ? <em>{h.where}</em> : null}</button>
                        ))}</div>
                      )}
                    </>
                  ) : (
                    <div className="picked"><div><b>{cCourse.name}</b>{cCourse.where ? <em>{cCourse.where}</em> : null}</div><button className="linkbtn" onClick={() => { setCCourse(null); setCQuery(""); }}>Change</button></div>
                  )}
                  {cMsg && <p className="err">{cMsg}</p>}
                </div>

                <div className="field"><span>Date</span>
                  <input className="dash-pw" style={{ margin: 0 }} type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} />
                </div>

                <div className="field"><span>Foursomes</span>
                  <div className="stepper">
                    <button onClick={() => setCGroups((n) => Math.max(2, n - 1))}>−</button>
                    <b>{cGroups}</b>
                    <button onClick={() => setCGroups((n) => Math.min(16, n + 1))}>+</button>
                    <span className="stepnote">players pick theirs at sign-up · up to {cGroups * 4}</span>
                  </div>
                </div>

                <div className="field"><span>Scoring</span>
                  <div className="chips">
                    {[["net", "Net"], ["gross", "Gross"], ["stableford", "Stableford"]].map(([id, lab]) => (
                      <button key={id} className={`chip ${cFormats[id] ? "on" : ""}`} onClick={() => setCFormats({ ...cFormats, [id]: !cFormats[id] })}>{lab}</button>
                    ))}
                  </div>
                </div>

                <button className="primary" onClick={createOuting} disabled={creating || !cCourse}>{creating ? "Creating…" : "Create outing"}</button>
              </>
            )}
          </>
        )}

        {state && (
          <>
            <div className="dash-meta">
              <div className="dm-title">{state.name || codeRef.current}</div>
              <div className="dm-sub">{[state.courseName, dateLabel].filter(Boolean).join(" · ")}{updated ? ` · updated ${new Date(updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div>
              <button className="linkbtn" style={{ marginTop: 6 }} onClick={() => { setState(null); codeRef.current = ""; setMode("new"); }}>← New / open another</button>
            </div>

            <div className="field"><span>Registration</span>
              <div className="regcard">
                <div className="qrwrap"><QRCodeSVG value={joinBase} size={132} bgColor="#ffffff" fgColor="#0f5a37" level="M" /></div>
                <div className="regmeta">
                  <b>{registered} registered</b><span>of {gc * 4} spots</span>
                  <button className="copybtn" onClick={() => copy("reg", joinBase)}>{copied === "reg" ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy sign-up link</>}</button>
                </div>
              </div>
              <p className="hint" style={{ margin: "10px 0 0" }}>Share this one link or QR. Players scan it, pick their foursome, add their name — and they're on the live scorecard.</p>
              <button className="linkbtn" style={{ marginTop: 9 }} onClick={() => setShowPairings((s) => !s)}>{showPairings ? "Hide" : "Pre-assigning pairings? Per-foursome codes"}</button>
              {showPairings && (
                <div className="joingrid" style={{ marginTop: 11 }}>
                  {Array.from({ length: gc }).map((_, i) => {
                    const n = i + 1; const url = `${joinBase}-${n}`; const k = `g${n}`;
                    return (
                      <div className="joincard" key={n}>
                        <div className="qrwrap"><QRCodeSVG value={url} size={92} bgColor="#ffffff" fgColor="#0f5a37" level="M" /></div>
                        <div className="joinmeta"><b>Group {n}</b><span className="joincode">{codeRef.current}-{n}</span>
                          <button className="copybtn" onClick={() => copy(k, url)}>{copied === k ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="field"><span>Roster</span>
              {registered === 0 ? (
                <p className="hint" style={{ margin: 0 }}>No one's registered yet. Share the sign-up link above to fill the field.</p>
              ) : (
                <div className="dash-groups">
                  {groupKeys.map((g) => {
                    const thru = groupThru(g); const pace = paceOf(thru);
                    return (
                      <div className="grpcard" key={g}>
                        <div className="grpcard-top"><b>Group {g}</b>{anyScores ? <span className={`pacebadge ${pace.cls}`}>{pace.label}</span> : null}<span className="grpthru">{anyScores ? `thru ${thru} · ` : ""}{groups[g].length}/4</span></div>
                        <div className="grpmem">{groups[g].map((p) => { const s = byId[p.id]; return (<div className="grpm" key={p.id}><span>{p.name}</span><em>{s && s.thru ? val(s) : `${p.hcp ?? 0} hcp`}</em></div>); })}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {standings.length > 0 && (
              <div className="field"><span>Live scoring</span>
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
            )}
            {!standings.length && <p className="hint">No players have joined yet. Share the foursome QRs above to fill the field.</p>}
          </>
        )}
      </div>
    </div></div>
  );
}
