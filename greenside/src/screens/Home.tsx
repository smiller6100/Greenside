import { useState, useEffect, useRef } from "react";
import { Flag, Plus, X, Search, Camera, MapPin, ChevronDown, Bookmark, RotateCcw } from "lucide-react";
import { DEFAULT_COURSE, aerialUrl, type Hole } from "../lib/golf";

const FORMAT_DEFS = [
  { id: "net", label: "Net" }, { id: "gross", label: "Gross" },
  { id: "stableford", label: "Stableford" }, { id: "skins", label: "Skins" },
] as const;
const HCP_DEFS = [
  { id: "perHole", label: "Per-hole" }, { id: "course", label: "Course" }, { id: "gross", label: "Off" },
] as const;

interface CourseHit { id: string; name: string; where: string; lat: number | null; lng: number | null; saved?: boolean; }

async function fileToJpeg(file: File, max = 1400, q = 0.82): Promise<Blob> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return await new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", q));
}

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
  const [last] = useState(() => ({ code: localStorage.getItem("gs:lastRound") || "", name: localStorage.getItem("gs:lastRoundName") || "" }));
  const [confirmNew, setConfirmNew] = useState(false);

  // course
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CourseHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [course, setCourse] = useState<Hole[]>(DEFAULT_COURSE);
  const [courseName, setCourseName] = useState("");
  const [courseWhere, setCourseWhere] = useState("");
  const [loc, setLoc] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const [siEstimated, setSiEstimated] = useState(false);
  const [editing, setEditing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const fileIn = useRef<HTMLInputElement>(null);

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2 || loaded) { setResults([]); setMsg(""); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true); setMsg("");
      try {
        const r = await fetch(`/api/courses/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (data.unconfigured && !data.courses?.length) setMsg("Not finding it? Scan the scorecard instead.");
        else if (!data.courses?.length) setMsg("No match yet — scan the scorecard to add it.");
        setResults(data.courses || []);
      } catch { setMsg("Search unavailable. Scan the scorecard or use the demo course."); }
      setSearching(false);
    }, 350);
  }, [query, loaded]);

  async function pickCourse(hit: CourseHit) {
    setSearching(true); setMsg(""); setResults([]); setQuery("");
    try {
      const r = await fetch(`/api/courses/${hit.id}`);
      if (!r.ok) throw new Error();
      const data = await r.json();
      const holes: Hole[] = (data.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
      if (!holes.length) { setMsg("That course had no scorecard data. Try another or scan it."); setSearching(false); return; }
      setCourse(holes); setCourseName(data.name || hit.name); setCourseWhere(data.where || hit.where || "");
      setLoc({ lat: data.lat ?? hit.lat, lng: data.lng ?? hit.lng });
      setSiEstimated(!!data.siEstimated); setScanned(false); setLoaded(true);
      if (!nameTouched) setRoundName(data.name || hit.name);
    } catch { setMsg("Couldn't load that course. Try another or scan it."); }
    setSearching(false);
  }

  async function onScan(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setScanning(true); setMsg("");
    try {
      const blob = await fileToJpeg(file);
      const r = await fetch("/api/courses/scan", { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
      if (!r.ok) {
        setMsg("Couldn't read that photo clearly — enter the holes by hand below, or try a flatter, brighter shot.");
        setCourse(DEFAULT_COURSE.map((h) => ({ ...h, yards: 0, si: 0 }))); setCourseName(""); setCourseWhere("");
        setLoc({ lat: null, lng: null }); setSiEstimated(false); setScanned(true); setLoaded(true); setEditing(true);
      } else {
        const data = await r.json();
        const holes: Hole[] = (data.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
        setCourse(holes.length ? holes : DEFAULT_COURSE); setCourseName(data.name || ""); setCourseWhere("");
        setLoc({ lat: null, lng: null }); setSiEstimated(false); setScanned(true); setLoaded(true); setEditing(true);
        if (!nameTouched && data.name) setRoundName(data.name);
      }
    } catch { setMsg("Couldn't process that image."); }
    setScanning(false);
    if (fileIn.current) fileIn.current.value = "";
  }

  function clearCourse() {
    setLoaded(false); setScanned(false); setCourse(DEFAULT_COURSE); setCourseName(""); setCourseWhere("");
    setLoc({ lat: null, lng: null }); setSiEstimated(false); setEditing(false); setMsg("");
  }
  const editHole = (i: number, key: "par" | "si" | "yards", v: string) => {
    const n = Math.max(0, Math.min(999, parseInt(v) || 0));
    setCourse(course.map((h, k) => (k === i ? { ...h, [key]: n } : h)));
  };

  const addP = () => players.length < 8 && setPlayers([...players, { name: "", hcp: "12" }]);
  const rmP = (i: number) => setPlayers(players.filter((_, k) => k !== i));
  const setP = (i: number, key: "name" | "hcp", v: string) => setPlayers(players.map((p, k) => (k === i ? { ...p, [key]: v } : p)));
  const parTotal = course.reduce((s, h) => s + h.par, 0);

  function onCreatePress() {
    setErr("");
    const named = players.map((p) => p.name.trim()).filter(Boolean);
    if (!named.length) { setErr("Add at least one player."); return; }
    if (!Object.values(formats).some(Boolean)) { setErr("Pick at least one format."); return; }
    if (last.code) { setConfirmNew(true); return; }
    doCreate();
  }
  function deleteOldAndCreate() {
    localStorage.removeItem("gs:lastRound"); localStorage.removeItem("gs:lastRoundName");
    setConfirmNew(false); doCreate();
  }
  async function doCreate() {
    setConfirmNew(false); setBusy(true);
    const named = players.map((p) => ({ name: p.name.trim(), hcp: p.hcp })).filter((p) => p.name);
    const payload = {
      name: roundName.trim() || "Round", formats, handicapMode: hcpMode,
      course, lat: loc.lat, lng: loc.lng,
      courseName: loaded ? courseName.trim() : "", courseWhere,
      players: named.map((p, i) => ({ id: `p${i + 1}`, name: p.name.trim(), hcp: Math.max(0, Math.min(54, parseInt(p.hcp) || 0)) })),
    };
    try {
      const r = await fetch("/api/round", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const { code } = await r.json();
      localStorage.setItem(`gs:me:${code}`, "p1"); localStorage.setItem(`gs:claimed:${code}`, "1");
      localStorage.setItem("gs:lastRound", code); localStorage.setItem("gs:lastRoundName", payload.name);
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

        {last.code && (
          <button className="resume" onClick={() => { location.hash = `#/r/${last.code}`; }}>
            <RotateCcw size={16} />
            <span className="rs-txt">Resume your round<em>{last.name || last.code}</em></span>
            <span className="rs-code">{last.code}</span>
          </button>
        )}

        <div className="seg big">
          <button className={`seg-btn ${mode === "create" ? "on" : ""}`} onClick={() => { setMode("create"); setErr(""); }}>Start a round</button>
          <button className={`seg-btn ${mode === "join" ? "on" : ""}`} onClick={() => { setMode("join"); setErr(""); }}>Join a round</button>
        </div>

        {mode === "create" ? (
          <div className="panel">
            <div className="field">
              <span>Course</span>
              {!loaded ? (
                <>
                  <div className="searchbox">
                    <Search size={16} className="si" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a course…" />
                  </div>
                  {searching && <div className="srow muted">Searching…</div>}
                  {results.map((c) => (
                    <button className="srow" key={c.id} onClick={() => pickCourse(c)}>
                      <MapPin size={14} />
                      <span className="sr-name">{c.name}<em>{c.where}</em></span>
                      {c.saved && <span className="badge"><Bookmark size={10} /> Saved</span>}
                    </button>
                  ))}
                  {msg && <div className="srow muted">{msg}</div>}
                  <input ref={fileIn} type="file" accept="image/*" capture="environment" onChange={onScan} style={{ display: "none" }} />
                  <button className="scanbtn" disabled={scanning} onClick={() => fileIn.current?.click()}>
                    <Camera size={16} /> {scanning ? "Reading scorecard…" : "Scan a scorecard"}
                  </button>
                  <p className="hint left">No course? Snap the scorecard and we'll read it — and save it for everyone. Or leave blank for the demo Par 72.</p>
                </>
              ) : (
                <>
                  <div className="coursecard">
                    {loc.lat != null && loc.lng != null && (
                      <div className="thumb" style={{ backgroundImage: `url("${aerialUrl(loc.lat, loc.lng, 200, 200)}")` }} />
                    )}
                    <div className="cc-info">
                      <input className="cc-nameinput" value={courseName} onChange={(e) => setCourseName(e.target.value)} placeholder="Course name" />
                      <div className="cc-meta">{course.length} holes · Par {parTotal}</div>
                    </div>
                    <button className="rm" onClick={clearCourse} aria-label="clear course"><X size={15} /></button>
                  </div>
                  {scanned && <p className="hint left warn">Scanned — please double-check the values below, especially stroke index.</p>}
                  {siEstimated && !scanned && <p className="hint left warn">Stroke index was estimated — fine-tune below if needed.</p>}
                  <button className="addp" onClick={() => setEditing(!editing)}>
                    <ChevronDown size={15} style={{ transform: editing ? "rotate(180deg)" : "none", transition: ".2s" }} /> {editing ? "Hide" : "Review"} scorecard
                  </button>
                  {editing && (
                    <div className="scoretable">
                      <div className="st-head"><span>Hole</span><span>Yds</span><span>Par</span><span>SI</span></div>
                      {course.map((h, i) => (
                        <div className="st-row" key={i}>
                          <span className="st-num">{h.num}</span>
                          <input className="st-in dim" inputMode="numeric" value={h.yards} onChange={(e) => editHole(i, "yards", e.target.value)} />
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
            <button className="primary" disabled={busy} onClick={onCreatePress}>{busy ? "Creating…" : "Create round"}</button>
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

        {confirmNew && (
          <div className="modal"><div className="sheet">
            <h3>Start a new round?</h3>
            <p>You've still got <strong>{last.name || last.code}</strong> ({last.code}) going. Delete it and start fresh, or keep it?</p>
            <button className="primary" onClick={deleteOldAndCreate}>Delete old round &amp; start new</button>
            <button className="ghostbtn" onClick={() => { setConfirmNew(false); location.hash = `#/r/${last.code}`; }}>Go back to that round</button>
            <button className="ghostbtn" onClick={() => setConfirmNew(false)}>Cancel</button>
          </div></div>
        )}
      </div>
    </div>
  );
}
