import { useState, useEffect, useRef } from "react";
import { Flag, Plus, X, Search, Check, MapPin, ChevronDown } from "lucide-react";
import { DEFAULT_COURSE, aerialUrl, type Hole } from "../lib/golf";

const FORMAT_DEFS = [
  { id: "net", label: "Net" },
  { id: "gross", label: "Gross" },
  { id: "stableford", label: "Stableford" },
  { id: "skins", label: "Skins" },
] as const;

const HCP_DEFS = [
  { id: "perHole", label: "Per-hole" },
  { id: "course", label: "Course" },
  { id: "gross", label: "Off" },
] as const;

interface CourseHit { id: number; name: string; where: string; lat: number | null; lng: number | null; }

export default function Home() {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [roundName, setRoundName] = useState("Saturday Round");
  const [nameTouched, setNameTouched] = useState(false);
  const [players, setPlayers] = useState([{ name: "", hcp: "12" }]);
  const [formats, setFormats] = useState<Record<string, boolean>>({ net: true, gross: true, stableford: false, skins: false });
  const [hcpMode, setHcpMode] = useState<"perHole" | "course" | "gross">("perHole");
  const [joinCode, setJoinCode] = useState((location.hash.match(/#\/r\/([A-Za-z0-9]+)/) || [])[1] || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // course selection
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CourseHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState("");
  const [course, setCourse] = useState<Hole[]>(DEFAULT_COURSE);
  const [courseName, setCourseName] = useState("");
  const [courseLoc, setCourseLoc] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const [siEstimated, setSiEstimated] = useState(false);
  const [editing, setEditing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearchMsg(""); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true); setSearchMsg("");
      try {
        const r = await fetch(`/api/courses/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (data.unconfigured) setSearchMsg("Course search isn't set up yet — the demo course still works.");
        else if (data.error) setSearchMsg("Search hit a snag. Try again, or use the demo course.");
        else if (!data.courses?.length) setSearchMsg("No courses found. Try the club's name.");
        setResults(data.courses || []);
      } catch { setSearchMsg("Couldn't reach search. Demo course still works."); }
      setSearching(false);
    }, 350);
  }, [query]);

  async function pickCourse(hit: CourseHit) {
    setSearching(true); setSearchMsg(""); setResults([]); setQuery("");
    try {
      const r = await fetch(`/api/courses/${hit.id}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      const holes: Hole[] = (data.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
      if (!holes.length) { setSearchMsg("That course had no scorecard data. Pick another."); setSearching(false); return; }
      setCourse(holes);
      setCourseName(data.name || hit.name);
      setCourseLoc({ lat: data.lat ?? hit.lat, lng: data.lng ?? hit.lng });
      setSiEstimated(!!data.siEstimated);
      if (!nameTouched) setRoundName(data.name || hit.name);
    } catch { setSearchMsg("Couldn't load that course. Try another."); }
    setSearching(false);
  }

  function clearCourse() {
    setCourse(DEFAULT_COURSE); setCourseName(""); setCourseLoc({ lat: null, lng: null }); setSiEstimated(false); setEditing(false);
  }
  const editHole = (i: number, key: "par" | "si", v: string) => {
    const n = Math.max(0, Math.min(99, parseInt(v) || 0));
    setCourse(course.map((h, k) => (k === i ? { ...h, [key]: n } : h)));
  };

  const addP = () => players.length < 8 && setPlayers([...players, { name: "", hcp: "12" }]);
  const rmP = (i: number) => setPlayers(players.filter((_, k) => k !== i));
  const setP = (i: number, key: "name" | "hcp", v: string) =>
    setPlayers(players.map((p, k) => (k === i ? { ...p, [key]: v } : p)));

  const parTotal = course.reduce((s, h) => s + h.par, 0);

  async function create() {
    setErr("");
    const named = players.map((p) => ({ name: p.name.trim(), hcp: p.hcp })).filter((p) => p.name);
    if (!named.length) { setErr("Add at least one player."); return; }
    if (!Object.values(formats).some(Boolean)) { setErr("Pick at least one format."); return; }
    setBusy(true);
    const payload = {
      name: roundName.trim() || "Round",
      formats, handicapMode: hcpMode,
      course, lat: courseLoc.lat, lng: courseLoc.lng,
      players: named.map((p, i) => ({ id: `p${i + 1}`, name: p.name.trim(), hcp: Math.max(0, Math.min(54, parseInt(p.hcp) || 0)) })),
    };
    try {
      const r = await fetch("/api/round", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const { code } = await r.json();
      localStorage.setItem(`gs:me:${code}`, "p1");
      localStorage.setItem(`gs:claimed:${code}`, "1");
      location.hash = `#/r/${code}`;
    } catch { setErr("Couldn't create the round. Try again."); setBusy(false); }
  }

  function join() {
    const c = joinCode.trim().toUpperCase();
    if (c.length < 3) { setErr("Enter the round code."); return; }
    location.hash = `#/r/${c}`;
  }

  return (
    <div className="gs">
      <div className="frame home">
        <div className="topbar"><div className="mark"><Flag size={15} strokeWidth={2.2} /><span>GREENSIDE</span></div></div>

        <header className="hero">
          <div className="eyebrow">Live scoring</div>
          <h1>Keep the<br />card together.</h1>
          <p className="lede">One shared scorecard for your group or your whole outing — every stroke, on every phone, the moment it lands.</p>
        </header>

        <div className="seg big">
          <button className={`seg-btn ${mode === "create" ? "on" : ""}`} onClick={() => { setMode("create"); setErr(""); }}>Start a round</button>
          <button className={`seg-btn ${mode === "join" ? "on" : ""}`} onClick={() => { setMode("join"); setErr(""); }}>Join a round</button>
        </div>

        {mode === "create" ? (
          <div className="panel">
            <div className="field">
              <span>Course</span>
              {courseName ? (
                <div className="coursecard">
                  {courseLoc.lat != null && courseLoc.lng != null && (
                    <div className="thumb" style={{ backgroundImage: `url("${aerialUrl(courseLoc.lat, courseLoc.lng, 200, 200)}")` }} />
                  )}
                  <div className="cc-info">
                    <div className="cc-name">{courseName}</div>
                    <div className="cc-meta">{course.length} holes · Par {parTotal}</div>
                  </div>
                  <button className="rm" onClick={clearCourse} aria-label="clear course"><X size={15} /></button>
                </div>
              ) : (
                <div className="searchbox">
                  <Search size={16} className="si" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a course…" />
                </div>
              )}
              {!courseName && (
                <>
                  {searching && <div className="srow muted">Searching…</div>}
                  {results.map((c) => (
                    <button className="srow" key={c.id} onClick={() => pickCourse(c)}>
                      <MapPin size={14} />
                      <span className="sr-name">{c.name}<em>{c.where}</em></span>
                    </button>
                  ))}
                  {searchMsg && <div className="srow muted">{searchMsg}</div>}
                  {!query && !searchMsg && <p className="hint left">Leave blank to use the demo Par 72.</p>}
                </>
              )}

              {courseName && (
                <>
                  {siEstimated && !editing && <p className="hint left warn">Stroke index was estimated — tap below to fine-tune.</p>}
                  <button className="addp" onClick={() => setEditing(!editing)}>
                    <ChevronDown size={15} style={{ transform: editing ? "rotate(180deg)" : "none", transition: ".2s" }} /> {editing ? "Hide" : "Edit"} scorecard
                  </button>
                  {editing && (
                    <div className="scoretable">
                      <div className="st-head"><span>Hole</span><span>Yds</span><span>Par</span><span>SI</span></div>
                      {course.map((h, i) => (
                        <div className="st-row" key={h.num}>
                          <span className="st-num">{h.num}</span>
                          <span className="st-yds">{h.yards || "—"}</span>
                          <input className="st-in" inputMode="numeric" value={h.par} onChange={(e) => editHole(i, "par", e.target.value)} />
                          <input className="st-in" inputMode="numeric" value={h.si} onChange={(e) => editHole(i, "si", e.target.value)} />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <label className="field">
              <span>Round name</span>
              <input value={roundName} onChange={(e) => { setRoundName(e.target.value); setNameTouched(true); }} placeholder="Saturday Round" />
            </label>

            <div className="field">
              <span>Players</span>
              <div className="players">
                {players.map((p, i) => (
                  <div className="prow" key={i}>
                    <input className="pname" value={p.name} onChange={(e) => setP(i, "name", e.target.value)} placeholder={i === 0 ? "You" : `Player ${i + 1}`} />
                    <div className="hcpbox">
                      <input className="phcp" inputMode="numeric" value={p.hcp} onChange={(e) => setP(i, "hcp", e.target.value.replace(/[^0-9]/g, ""))} />
                      <em>hcp</em>
                    </div>
                    {players.length > 1 && <button className="rm" onClick={() => rmP(i)} aria-label="remove"><X size={15} /></button>}
                  </div>
                ))}
              </div>
              {players.length < 8 && <button className="addp" onClick={addP}><Plus size={15} strokeWidth={2.4} /> Add player</button>}
            </div>

            <div className="field">
              <span>Scoring</span>
              <div className="chips">
                {FORMAT_DEFS.map((f) => (
                  <button key={f.id} className={`chip ${formats[f.id] ? "on" : ""}`} onClick={() => setFormats({ ...formats, [f.id]: !formats[f.id] })}>{f.label}</button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>Handicaps</span>
              <div className="seg sub">
                {HCP_DEFS.map((h) => (
                  <button key={h.id} className={`seg-btn ${hcpMode === h.id ? "on" : ""}`} onClick={() => setHcpMode(h.id)}>{h.label}</button>
                ))}
              </div>
            </div>

            {err && <p className="err">{err}</p>}
            <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create round"}</button>
            <p className="hint">You'll get a short code to share with the group.</p>
          </div>
        ) : (
          <div className="panel">
            <label className="field">
              <span>Round code</span>
              <input className="code-in" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ABCD" maxLength={6} />
            </label>
            {err && <p className="err">{err}</p>}
            <button className="primary" onClick={join}>Join round</button>
            <p className="hint">Ask whoever started the round for the code.</p>
          </div>
        )}
      </div>
    </div>
  );
}
