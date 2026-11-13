import { useState, useEffect, useRef } from "react";
import { ChevronLeft, RotateCcw, Lock, Search } from "lucide-react";
import { computeStandings, fmtToPar } from "../lib/golf";
import CourseMap, { Green, GroupDot } from "../components/CourseMap";

// Stable palette for group dots on the map (cycled). Chosen to read against the fairway-green board.
const DOT_COLORS = ["#2563eb", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4d7c0f", "#b45309"];
const FRESH_MS = 15 * 60 * 1000; // a fix older than this is "stale" (group may have left or lost signal)

// Pro-shop live field board. Password-gated. Pick a course and watch every group out on it right
// now — casual walk-ons and outings alike — with scores, the hole each group is on, a pace flag,
// and a live course map with a dot per group (from opt-in GPS shares, saved hole map as basemap).
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
  const [greens, setGreens] = useState<Green[]>([]);
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

  // The saved hole map gives us green locations to draw as a faint basemap under the live dots.
  const fetchGreens = async (lat: number, lng: number) => {
    try {
      const r = await fetch(`/api/holemap?lat=${lat}&lng=${lng}`);
      const d = await r.json();
      const gs: Green[] = (d?.available && Array.isArray(d.holes) ? d.holes : [])
        .filter((h: any) => h.greenC && isFinite(h.greenC[0]) && isFinite(h.greenC[1]))
        .map((h: any) => ({ num: h.ref || 0, lat: h.greenC[0], lng: h.greenC[1] }));
      setGreens(gs);
    } catch { setGreens([]); }
  };

  const pickCourse = async (hit: any) => {
    setCMsg("");
    try {
      const r = await fetch(`/api/courses/${hit.id}`); const d = await r.json();
      const lat = d.lat ?? hit.lat, lng = d.lng ?? hit.lng;
      if (lat == null || lng == null) { setCMsg("That course has no location yet — start a round there once so it gets placed on the map."); return; }
      const c = { name: d.name || hit.name, where: d.where || hit.where || "", lat, lng };
      setCourse(c); courseRef.current = { lat, lng }; setCResults([]); setCQuery("");
      fetchGreens(lat, lng);
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
  const now = Date.now();
  const dots: GroupDot[] = [];
  let colorI = 0;
  const views = rounds.map((rnd: any) => {
    const st = rnd.state || {};
    const posById: Record<string, any> = rnd.positions || {};
    const fmt = (["net", "gross", "stableford", "chicago"].find((f: string) => st?.formats?.[f]) || "net") as string;
    const useNet = st?.handicapMode !== "gross" && fmt === "net";
    const standings = computeStandings(st, fmt);
    const byId: Record<string, any> = Object.fromEntries(standings.map((s: any) => [s.id, s]));
    const holes = st?.course?.length || 18;
    const elapsedMin = st?.createdAt ? (now - st.createdAt) / 60000 : 0;
    const expected = Math.max(0, Math.min(holes, Math.floor(elapsedMin / 13)));
    const groups: Record<string, any[]> = {};
    (st?.players || []).forEach((p: any) => { const g = p.group || "—"; (groups[g] ||= []).push(p); });
    const gs = Object.keys(groups).sort().map((g) => {
      const thru = Math.max(0, ...groups[g].map((p: any) => byId[p.id]?.thru || 0));
      const done = thru >= holes && thru > 0;
      // Latest GPS fix across the group — drives the live current-hole and the map dot.
      let fix: any = null;
      for (const p of groups[g]) { const f = posById[p.id]; if (f && isFinite(f.lat) && (!fix || (f.ts || 0) > (fix.ts || 0))) fix = f; }
      const live = !!fix && now - (fix.ts || 0) < FRESH_MS;
      const gpsHole = live && fix.hole ? Number(fix.hole) : 0;
      // Pace compares the hole they're actually ON (GPS) to where the clock says they should be,
      // falling back to holes scored when there's no live fix.
      const atHole = gpsHole || thru;
      const pace = paceOf(expected, atHole);
      const mem = groups[g].map((p: any) => {
        const s = byId[p.id];
        return { name: p.name, txt: s && s.thru ? `${s.gross || "–"} (${fmtToPar(useNet ? s.toParNet : s.toParGross)})` : `${p.hcp ?? 0} hcp` };
      });
      const color = DOT_COLORS[colorI % DOT_COLORS.length];
      if (fix && !done) {
        dots.push({ key: rnd.code + g, label: g === "—" ? "•" : g, lat: fix.lat, lng: fix.lng, hole: gpsHole || undefined, color, fresh: live });
        colorI++;
      }
      return { g, thru, done, holes, pace, mem, live, gpsHole, dotColor: fix && !done ? color : null };
    });
    return { code: rnd.code, name: rnd.name || st?.courseName || rnd.code, outing: !!rnd.outing, gs };
  });
  const allGroups = views.flatMap((v) => v.gs);
  const outCount = allGroups.filter((x) => !x.done).length;
  const behindCount = allGroups.filter((x) => x.pace.cls === "behind" && !x.done).length;
  const liveCount = allGroups.filter((x) => x.live && !x.done).length;

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
              <button className="linkbtn" style={{ marginTop: 6 }} onClick={() => { setCourse(null); courseRef.current = null; setRounds([]); setGreens([]); setCQuery(""); }}>← Change course</button>
            </div>

            <div className="ch-tiles">
              <div className="ch-tile"><b>{outCount}</b><span>groups out</span></div>
              <div className={`ch-tile ${behindCount ? "warn" : ""}`}><b>{behindCount}</b><span>behind pace</span></div>
              <div className="ch-tile"><b>{liveCount}</b><span>live on GPS</span></div>
            </div>

            {dots.length > 0 && (
              <div className="ch-map">
                <CourseMap greens={greens} groups={dots} />
                {greens.length === 0 && <p className="hint" style={{ textAlign: "center", marginTop: 6 }}>Map this course in the Mapper to show holes behind the dots.</p>}
              </div>
            )}

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
                          {grp.dotColor && <span className={`livedot ${grp.live ? "" : "stale"}`} style={{ background: grp.dotColor }} />}
                          <b>{grp.g === "—" ? "Group" : `Group ${grp.g}`}</b>
                          {grp.done ? <span className="pacebadge onpace">Done</span> : (grp.thru > 0 || grp.live) ? <span className={`pacebadge ${grp.pace.cls}`}>{grp.pace.label}</span> : null}
                          <span className="grpthru">{grp.live && grp.gpsHole ? `on ${grp.gpsHole}` : grp.thru > 0 ? `thru ${grp.thru}` : "not started"}</span>
                        </div>
                        <div className="grpmem">{grp.mem.map((m, i) => (<div className="grpm" key={i}><span>{m.name}</span><em>{m.txt}</em></div>))}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
            <p className="hint">Pace compares the hole each group is on (live GPS, or holes scored) against the clock at ~13 min/hole. Dots on the map update as phones share location.</p>
          </>
        )}
      </div>
    </div></div>
  );
}
