import { useState, useMemo, useEffect } from "react";
import { Flag, Minus, Plus, Crown, ChevronLeft, ChevronRight, Trophy, ClipboardList, Copy, Check, Home } from "lucide-react";
import { useRound } from "../lib/useRound";
import { computeStandings, strokesOn, toParClass, fmtToPar, aerialUrl } from "../lib/golf";

const FORMAT_LABELS: Record<string, string> = { net: "Net", gross: "Gross", stableford: "Stableford", skins: "Skins", card: "Full card" };

export default function Round({ code }: { code: string }) {
  const { state, connected, missing, sendScore } = useRound(code);
  const [tab, setTab] = useState<"board" | "score">("board");
  const [view, setView] = useState("net"); // a scoring format, or "card"
  const [holeIdx, setHoleIdx] = useState(0);
  const [me, setMe] = useState<string | null>(() => localStorage.getItem(`gs:me:${code}`));
  const [claimed, setClaimed] = useState(() => localStorage.getItem(`gs:claimed:${code}`) === "1");
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const enabledFormats = useMemo(
    () => (state ? Object.keys(state.formats).filter((k) => state.formats[k as keyof typeof state.formats]) : []),
    [state]
  );

  useEffect(() => {
    if (enabledFormats.length && view !== "card" && !enabledFormats.includes(view)) setView(enabledFormats[0]);
  }, [enabledFormats, view]);

  // remember this round so Home can offer to resume it
  useEffect(() => {
    if (state) { localStorage.setItem("gs:lastRound", code); localStorage.setItem("gs:lastRoundName", state.name || code); }
  }, [state, code]);

  const standings = useMemo(() => (state && view !== "card" ? computeStandings(state, view) : []), [state, view]);

  if (missing) {
    return (
      <Shell>
        <div className="empty"><Flag size={28} /><h2>Round not found</h2><p>Double-check the code, or start a new round.</p>
          <button className="primary" onClick={() => { location.hash = ""; }}>Back to start</button></div>
      </Shell>
    );
  }
  if (!state) {
    return <Shell><div className="empty"><div className="spin" /><p>Connecting to {code}…</p></div></Shell>;
  }

  const course = state.course;
  const hole = course[holeIdx];
  const useHcp = state.handicapMode !== "gross";

  const claim = (id: string | null) => {
    if (id) localStorage.setItem(`gs:me:${code}`, id); else localStorage.removeItem(`gs:me:${code}`);
    localStorage.setItem(`gs:claimed:${code}`, "1");
    setMe(id); setClaimed(true);
  };
  const copyCode = () => {
    navigator.clipboard?.writeText(`${location.origin}/#/r/${code}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {});
  };
  const adjust = (pid: string, delta: number) => {
    const cur = (state.scores[pid] || {})[hole.num];
    sendScore(pid, hole.num, Math.max(1, (cur ?? hole.par) + delta));
  };
  const setPar = (pid: string) => { if ((state.scores[pid] || {})[hole.num] == null) sendScore(pid, hole.num, hole.par); };
  const totalThru = Math.max(0, ...standings.map((r) => r.thru));
  const valueFor = (r: any) => {
    if (view === "net") return { txt: fmtToPar(r.toParNet), cls: toParClass(r.toParNet), unit: "" };
    if (view === "gross") return { txt: fmtToPar(r.toParGross), cls: toParClass(r.toParGross), unit: "" };
    if (view === "stableford") return { txt: `${r.points}`, cls: "pts", unit: "pts" };
    return { txt: `${r.skins}`, cls: "pts", unit: "skins" };
  };

  // ---- full scorecard grid ----
  const front = course.filter((h) => h.num <= 9);
  const back = course.filter((h) => h.num > 9);
  const sp = (pid: string, n: number) => (state.scores[pid] || {})[n];
  const sumPar = (arr: typeof course) => arr.reduce((s, h) => s + h.par, 0);
  const sumSc = (pid: string, arr: typeof course) => arr.reduce((s, h) => s + (sp(pid, h.num) || 0), 0);

  const FullCard = () => (
    <div className="cardwrap">
      <table className="fcard">
        <thead>
          <tr>
            <th className="stik">Hole</th>
            {front.map((h) => <th key={h.num}>{h.num}</th>)}<th className="tot">Out</th>
            {back.length > 0 && <>{back.map((h) => <th key={h.num}>{h.num}</th>)}<th className="tot">In</th></>}
            <th className="tot">Tot</th>
          </tr>
          <tr className="parrow">
            <th className="stik">Par</th>
            {front.map((h) => <th key={h.num}>{h.par}</th>)}<th className="tot">{sumPar(front)}</th>
            {back.length > 0 && <>{back.map((h) => <th key={h.num}>{h.par}</th>)}<th className="tot">{sumPar(back)}</th></>}
            <th className="tot">{sumPar(course)}</th>
          </tr>
        </thead>
        <tbody>
          {state.players.map((p) => (
            <tr key={p.id} className={p.id === me ? "meRow" : ""}>
              <th className="stik">{p.name}</th>
              {front.map((h) => { const v = sp(p.id, h.num); return <td key={h.num} className={v != null ? toParClass(v - h.par) : ""}>{v ?? ""}</td>; })}
              <td className="tot">{sumSc(p.id, front) || ""}</td>
              {back.length > 0 && <>{back.map((h) => { const v = sp(p.id, h.num); return <td key={h.num} className={v != null ? toParClass(v - h.par) : ""}>{v ?? ""}</td>; })}<td className="tot">{sumSc(p.id, back) || ""}</td></>}
              <td className="tot grand">{sumSc(p.id, course) || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="foot">Scroll sideways for the back nine</p>
    </div>
  );

  return (
    <div className="gs">
      <div className="frame">
        <div className="topbar">
          <button className="homebtn" onClick={() => setLeaving(true)} aria-label="home"><Home size={17} strokeWidth={2.2} /></button>
          <div className="mark"><Flag size={15} strokeWidth={2.2} /><span>GREENSIDE</span></div>
          <div className={`live ${connected ? "on" : ""}`}><span className="dot" />{connected ? "LIVE" : "···"}</div>
        </div>

        <header className="head">
          <div className="eyebrow">{tab === "score" ? "Scorecard" : FORMAT_LABELS[view]} · Round</div>
          <h1>{state.name}</h1>
          <button className="codepill" onClick={copyCode}>{copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Code {code}</>}</button>
        </header>

        {tab === "board" ? (
          <main className="body">
            <div className="seg wrap">
              {enabledFormats.map((f) => (
                <button key={f} className={`seg-btn ${view === f ? "on" : ""}`} onClick={() => setView(f)}>{FORMAT_LABELS[f]}</button>
              ))}
              <button className={`seg-btn ${view === "card" ? "on" : ""}`} onClick={() => setView("card")}>Full Card</button>
            </div>

            {view === "card" ? <FullCard /> : (
              <>
                <div className="board">
                  {standings.map((r, i) => {
                    const v = valueFor(r);
                    return (
                      <div key={r.id} className={`row ${i === 0 && r.thru > 0 ? "lead" : ""} ${r.id === me ? "self" : ""}`} style={{ animationDelay: `${i * 60}ms` }}>
                        <div className="pos">{i === 0 && r.thru > 0 ? <Crown size={16} strokeWidth={2.2} /> : i + 1}</div>
                        <div className="who"><div className="nm">{r.name}{r.id === me && <em>You</em>}</div><div className="mt">Hcp {r.hcp} · Thru {r.thru === 18 ? "F" : r.thru}</div></div>
                        <div className={`val ${v.cls}`}>{r.thru === 0 ? "–" : v.txt}{r.thru > 0 && v.unit && <span className="unit">{v.unit}</span>}</div>
                      </div>
                    );
                  })}
                </div>
                <p className="foot">{totalThru === 0 ? "No scores yet — head to the scorecard" : "Updates the instant anyone logs a score"}</p>
              </>
            )}
          </main>
        ) : (
          <main className="body">
            {state.lat != null && state.lng != null && (
              <div className="aerial" style={{ backgroundImage: `url("${aerialUrl(state.lat, state.lng)}")` }}>
                <div className="aerial-grad" /><div className="aerial-label">Hole {hole.num} · Par {hole.par}</div><div className="aerial-credit">Imagery © Esri</div>
              </div>
            )}
            <div className="holehead">
              <button className="nav" disabled={holeIdx === 0} onClick={() => setHoleIdx((i) => Math.max(0, i - 1))}><ChevronLeft size={20} /></button>
              <div className="holemid"><div className="hnum">Hole {hole.num}</div><div className="hmeta">Par {hole.par} · {hole.yards} yds · SI {hole.si}</div></div>
              <button className="nav" disabled={holeIdx === course.length - 1} onClick={() => setHoleIdx((i) => Math.min(course.length - 1, i + 1))}><ChevronRight size={20} /></button>
            </div>
            <div className="prog"><span style={{ width: `${((holeIdx + 1) / course.length) * 100}%` }} /></div>
            <div className="cards">
              {state.players.map((p) => {
                const rec = useHcp ? strokesOn(p.hcp, hole.si) : 0;
                const val = (state.scores[p.id] || {})[hole.num];
                const rel = val != null ? val - hole.par : null;
                return (
                  <div key={p.id} className={`pcard ${p.id === me ? "self" : ""}`}>
                    <div className="pinfo"><div className="pn">{p.name}{p.id === me && <em>You</em>}</div>
                      <div className="dots">{Array.from({ length: rec }).map((_, k) => <i key={k} />)}<span className="ph">{rec ? `${rec} stroke${rec > 1 ? "s" : ""}` : (useHcp ? "scratch here" : "gross")}</span></div></div>
                    <div className="stepper">
                      <button onClick={() => adjust(p.id, -1)} aria-label="minus"><Minus size={18} strokeWidth={2.4} /></button>
                      <button className="num" onClick={() => setPar(p.id)}><span className={val == null ? "ghost" : ""}>{val ?? hole.par}</span>{rel != null && <small className={toParClass(rel)}>{fmtToPar(rel)}</small>}</button>
                      <button onClick={() => adjust(p.id, 1)} aria-label="plus"><Plus size={18} strokeWidth={2.4} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="foot">Tap the number to log par · everyone sees it immediately</p>
          </main>
        )}

        <nav className="tabs">
          <button className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}><Trophy size={18} /><span>Leaderboard</span></button>
          <button className={tab === "score" ? "on" : ""} onClick={() => setTab("score")}><ClipboardList size={18} /><span>Scorecard</span></button>
        </nav>

        {!claimed && (
          <div className="modal"><div className="sheet">
            <h3>Which player are you?</h3><p>So we can highlight you on the board.</p>
            <div className="claimlist">{state.players.map((p) => (<button key={p.id} onClick={() => claim(p.id)}>{p.name}<span>Hcp {p.hcp}</span></button>))}</div>
            <button className="ghostbtn" onClick={() => claim(null)}>Just watching</button>
          </div></div>
        )}

        {leaving && (
          <div className="modal"><div className="sheet">
            <h3>Leave this round?</h3><p>Your scores are saved — you can jump back in anytime, and everything will still be here.</p>
            <button className="primary" onClick={() => { location.hash = ""; }}>Leave round</button>
            <button className="ghostbtn" onClick={() => setLeaving(false)}>Stay</button>
          </div></div>
        )}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="gs"><div className="frame">
      <div className="topbar"><div className="mark"><Flag size={15} strokeWidth={2.2} /><span>GREENSIDE</span></div></div>
      {children}
    </div></div>
  );
}
