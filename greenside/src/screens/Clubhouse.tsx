import { useState, useEffect, useRef } from "react";
import { ChevronLeft, RotateCcw, Lock, Search } from "lucide-react";
import { computeStandings, fmtToPar } from "../lib/golf";

// Pro-shop live field board. Password-gated. Pick a course and watch every group out on it right
// now — casual walk-ons and outings alike — with a pace flag when a group falls behind. v1 shows
// scores, hole reached and pace; live map dots come with the GPS-ping layer.
export default function Clubhouse() {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const keyRef = useRef(""); // validated admin key, sent on each poll

  const [cQuery, setCQuery] = useState("");
  const [cResults, setCResults] = useState<any[]>([]);
  const [course, setCourse] = useState<{ name: string; where: string; lat: number; lng: number } | null>(null);
  const courseRef = useRef<{ lat: number; lng: number } | null>(null);
  const [cMsg, setCMsg] = useState("");

  const [rounds, setRounds] = useState<any[]>([]);
  const [updated, setUpdated] = useState(0);
  const [loading, setLoading] = useState(false);

  const goHome = () => { location.hash = ""; };

  const checkPw = async () => {
    setAuthMsg("");
    try {
      const r = await fetch("/api/admin/check", { method: "POST", headers: { "x-admin-key": pw } });
      const d = await r.json();
      if (d.ok) { keyRef.current = pw; setAuthed(true); }
      else setAuthMsg(d.configured === false ? "Admin password isn't set up yet." : "Wrong password.");
    } catch { setAuthMsg("Couldn't reach the server."); }
  };

  useEffect(() => {
    if (course || cQuery.trim().length < 2) { setCResults([]); return; }
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/courses/search?q=${encodeURIComponent(cQuery.trim())}`); const d = await r.json(); setCResults(d.courses || []); } catch { /* */ }
    }, 250);
    return () => clearTimeout(t);
  }, [cQuery, course]);

  const poll = async () => {
    const c = courseRef.current; if (!c) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/clubhouse?lat=${c.lat}&lng=${c.lng}`, { headers: { "x-admin-key": keyRef.current } });
      if (r.ok) { const d = await r.json(); setRounds(d.rounds || []); setUpdated(Date.now()); }
    } catch { /* */ }
    setLoading(false);
  };

  const pickCourse = async (hit: any) => {
    setCMsg("");
    try {
      const r = await fetch(`/api/courses/${hit.id}`); const d = await r.json();
      const lat = d.lat ?? hit.lat, lng = d.lng ?? hit.lng;
      if (lat == null || lng == null) { setCMsg("That course has no location yet — start a round there once so it gets placed on the map."); return; }
      const c = { name: d.name || hit.name, where: d.where || hit.where || "", lat, lng };
      setCourse(c); courseRef.current = { lat, lng }; setCResults([]); setCQuery("");
      poll();
    } catch { setCMsg("Couldn't load that course."); }
  };

  useEffect(() => {
    if (!authed || !course) return;
    const id = setInterval(poll, 20000);
    return () => clearInterval(id);
  }, [authed, course]);

  const paceOf = (expected: number, thru: number) => {
    const b = expected - thru;
    if (b >= 2) return { label: "Behind", cls: "behind" };
    if (b <= -1) return { label: "Ahead", cls: "ahead" };
    return { label: "On pace", cls: "onpace" };
  };

  // ---------- Gate ----------
  if (!authed) {
    return (
      <div className="gs"><div className="frame home">
        <header className="dash-head"><button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button><h2>Clubhouse board</h2><span /></header>
        <div className="panel">
          <div className="dash-lock"><Lock size={22} /></div>
          <p className="hint" style={{ textAlign: "center" }}>Enter the clubhouse password to continue.</p>
          <input className="dash-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" onKeyDown={(e) => e.key === "Enter" && checkPw()} />
          {authMsg && <p className="err">{authMsg}</p>}
          <button className="primary" onClick={checkPw}>Unlock</button>
        </div>
      </div></div>
    );
  }

  // ---------- Build the field view ----------
  const views = rounds.map((rnd: any) => {
    const st = rnd.state || {};
    const fmt = (["net", "gross", "stableford", "chicago"].find((f: string) => st?.formats?.[f]) || "net") as string;
    const useNet = st?.handicapMode !== "gross" && fmt === "net";
    const standings = computeStandings(st, fmt);
    const byId: Record<string, any> = Object.fromEntries(standings.map((s: any) => [s.id, s]));
    const holes = st?.course?.length || 18;
    const elapsedMin = st?.createdAt ? (Date.now() - st.createdAt) / 60000 : 0;
    const expected = Math.max(0, Math.min(holes, Math.floor(elapsedMin / 13)));
    const groups: Record<string, any[]> = {};
    (st?.players || []).forEach((p: any) => { const g = p.group || "—"; (groups[g] ||= []).push(p); });
    const gs = Object.keys(groups).sort().map((g) => {
      const thru = Math.max(0, ...groups[g].map((p: any) => byId[p.id]?.thru || 0));
      const done = thru >= holes && thru > 0;
      const mem = groups[g].map((p: any) => {
        const s = byId[p.id];
        return { name: p.name, txt: s && s.thru ? `${s.gross || "–"} (${fmtToPar(useNet ? s.toParNet : s.toParGross)})` : `${p.hcp ?? 0} hcp` };
      });
      return { g, thru, done, holes, pace: paceOf(expected, thru), mem };
    });
    return { code: rnd.code, name: rnd.name || st?.courseName || rnd.code, outing: !!rnd.outing, gs };
  });
  const allGroups = views.flatMap((v) => v.gs);
  const outCount = allGroups.filter((x) => !x.done).length;
  const behindCount = allGroups.filter((x) => x.pace.cls === "behind" && !x.done).length;

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button>
        <h2>Clubhouse board</h2>
        {course ? <button className="backbtn" onClick={poll} aria-label="refresh"><RotateCcw size={17} className={loading ? "spin" : ""} /></button> : <span />}
      </header>

      <div className="panel">
        {!course ? (
          <>
            <div className="field"><span>Your course</span>
              <div className="searchbox"><Search size={16} className="si" /><input value={cQuery} onChange={(e) => setCQuery(e.target.value)} placeholder="Search for your course" /></div>
              {cResults.length > 0 && (
                <div className="hitlist">{cResults.slice(0, 6).map((h) => (
                  <button key={h.id} className="hit" onClick={() => pickCourse(h)}><b>{h.name}</b>{h.where ? <em>{h.where}</em> : null}</button>
                ))}</div>
              )}
              {cMsg && <p className="err">{cMsg}</p>}
              <p className="hint" style={{ marginTop: 12 }}>Pick your course once. From then on this board shows every group out there — walk-ons, leagues, and outings — live.</p>
            </div>
          </>
        ) : (
          <>
            <div className="dash-meta">
              <div className="dm-title">{course.name}</div>
              <div className="dm-sub">{course.where}{updated ? ` · updated ${new Date(updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</div>
              <button className="linkbtn" style={{ marginTop: 6 }} onClick={() => { setCourse(null); courseRef.current = null; setRounds([]); setCQuery(""); }}>← Change course</button>
            </div>

            <div className="ch-tiles">
              <div className="ch-tile"><b>{outCount}</b><span>groups out</span></div>
              <div className={`ch-tile ${behindCount ? "warn" : ""}`}><b>{behindCount}</b><span>behind pace</span></div>
              <div className="ch-tile"><b>{views.length}</b><span>rounds</span></div>
            </div>

            {views.length === 0 ? (
              <p className="hint" style={{ textAlign: "center", marginTop: 20 }}>No groups are out on this course right now. Rounds show up here the moment someone starts one.</p>
            ) : (
              views.map((v) => (
                <div className="field" key={v.code}>
                  <span>{v.name}{v.outing ? " · Outing" : ""}</span>
                  <div className="dash-groups">
                    {v.gs.map((grp) => (
                      <div className="grpcard" key={v.code + grp.g}>
                        <div className="grpcard-top">
                          <b>{grp.g === "—" ? "Group" : `Group ${grp.g}`}</b>
                          {grp.done ? <span className="pacebadge onpace">Done</span> : grp.thru > 0 ? <span className={`pacebadge ${grp.pace.cls}`}>{grp.pace.label}</span> : null}
                          <span className="grpthru">{grp.thru > 0 ? `thru ${grp.thru}` : "not started"}</span>
                        </div>
                        <div className="grpmem">{grp.mem.map((m, i) => (<div className="grpm" key={i}><span>{m.name}</span><em>{m.txt}</em></div>))}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
            <p className="hint">Pace is holes done versus time elapsed (~13 min/hole). Live positions on a map come next.</p>
          </>
        )}
      </div>
    </div></div>
  );
}
