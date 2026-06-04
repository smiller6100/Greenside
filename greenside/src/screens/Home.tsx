import { useState, useEffect, useRef } from "react";
import { Plus, X, Search, Camera, MapPin, ChevronDown, Bookmark, RotateCcw } from "lucide-react";
import { FullLogo } from "../components/Logo";
import { DEFAULT_COURSE, type Hole } from "../lib/golf";

const VERSION = "v10";

const FORMAT_DEFS = [
  { id: "net", label: "Net" }, { id: "gross", label: "Gross" },
  { id: "stableford", label: "Stableford" }, { id: "chicago", label: "Chicago" }, { id: "skins", label: "Skins" },
] as const;
const HCP_DEFS = [
  { id: "perHole", label: "Per-hole" }, { id: "course", label: "Course" }, { id: "gross", label: "Off" },
] as const;
const GAME_DEFS = [
  { id: "wolf", label: "Wolf" }, { id: "nines", label: "Nines" },
  { id: "sixes", label: "Sixes" }, { id: "vegas", label: "Vegas" }, { id: "nassau", label: "Nassau" },
  { id: "bbb", label: "Bingo Bango Bongo" },
] as const;
const GAME_HELP: Record<string, string> = {
  wolf: "3\u20134 players. A different \u201cwolf\u201d each hole picks a partner after the tee shots, or goes solo for triple. Set the pick on the Scorecard tab.",
  nines: "3 players. Each hole splits 9 points: 5 to the low score, 3 to the middle, 1 to the high (ties split). Most points wins.",
  sixes: "4 players. Teams of two, partners rotate every 6 holes. Low team score wins the hole \u2014 1 point per win.",
  vegas: "4 players. Two fixed teams. Each hole your pair\u2019s two scores make a number (low one first); the lower number wins the difference.",
  nassau: "4 players. Two fixed teams, best-ball match play. Three bets in one: front 9, back 9, and the overall 18.",
  bbb: "Any size. 3 points a hole \u2014 Bingo (first on the green), Bango (closest once everyone\u2019s on), Bongo (first in the hole). You award them on the Scorecard tab. Most points wins.",
};

interface CourseHit { id: string; name: string; where: string; lat: number | null; lng: number | null; saved?: boolean; }

async function fileToJpeg(file: File, max = 1800, q = 0.85): Promise<Blob> {
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
  const [players, setPlayers] = useState<{ name: string; hcp: string; group: string }[]>([{ name: "", hcp: "12", group: "A" }]);
  const [outing, setOuting] = useState(false);
  const [groupCount, setGroupCount] = useState(4);
  const [formats, setFormats] = useState<Record<string, boolean>>({ net: true, gross: true, stableford: false, chicago: false, skins: false });
  const [games, setGames] = useState<Record<string, boolean>>({ wolf: false, nines: false, sixes: false, vegas: false, nassau: false, bbb: false });
  const [hcpMode, setHcpMode] = useState<"perHole" | "course" | "gross">("perHole");
  const [joinCode, setJoinCode] = useState((location.hash.match(/#\/r\/([A-Za-z0-9]+)/) || [])[1] || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [last] = useState(() => ({ code: localStorage.getItem("gs:lastRound") || "", name: localStorage.getItem("gs:lastRoundName") || "" }));
  const [confirmNew, setConfirmNew] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminCourses, setAdminCourses] = useState<{ id: string; name: string; where: string; plays: number }[]>([]);
  const [adminMsg, setAdminMsg] = useState("");

  // course
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CourseHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [course, setCourse] = useState<Hole[]>(DEFAULT_COURSE);
  const [tees, setTees] = useState<{ name: string; total: number; holes: Hole[] }[]>([]);
  const [teeName, setTeeName] = useState("");
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
      const tlist = (data.tees || []).map((t: any) => ({ name: t.name, total: t.total, holes: (t.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si })) }));
      const tfinal = tlist.length ? tlist : [{ name: "Tees", total: holes.reduce((s: number, h: Hole) => s + (h.yards || 0), 0), holes }];
      setTees(tfinal); setTeeName(data.defaultTee || tfinal[0]?.name || "");
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
        const blank = DEFAULT_COURSE.map((h) => ({ ...h, yards: 0, si: 0 }));
        setTees([{ name: "Tees", total: 0, holes: blank }]); setTeeName("Tees");
        setCourse(blank); setCourseName(""); setCourseWhere("");
        setLoc({ lat: null, lng: null }); setSiEstimated(false); setScanned(true); setLoaded(true); setEditing(true);
      } else {
        const data = await r.json();
        const holes: Hole[] = (data.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
        const tlist = (data.tees || []).map((t: any) => ({ name: t.name, total: t.total, holes: (t.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si })) }));
        const base = holes.length ? holes : DEFAULT_COURSE;
        const tfinal = tlist.length ? tlist : [{ name: "Tees", total: base.reduce((s: number, h: Hole) => s + (h.yards || 0), 0), holes: base }];
        setTees(tfinal); setTeeName(data.defaultTee || tfinal[0]?.name || "");
        setCourse(base); setCourseName(data.name || ""); setCourseWhere("");
        setLoc({ lat: null, lng: null }); setSiEstimated(!!data.siEstimated); setScanned(true); setLoaded(true); setEditing(true);
        if (!nameTouched && data.name) setRoundName(data.name);
      }
    } catch { setMsg("Couldn't process that image."); }
    setScanning(false);
    if (fileIn.current) fileIn.current.value = "";
  }

  function clearCourse() {
    setLoaded(false); setScanned(false); setCourse(DEFAULT_COURSE); setCourseName(""); setCourseWhere("");
    setTees([]); setTeeName("");
    setLoc({ lat: null, lng: null }); setSiEstimated(false); setEditing(false); setMsg("");
  }
  // The selected tee always feeds the round's course (par/SI are shared across tees).
  useEffect(() => {
    if (!tees.length) return;
    const t = tees.find((x) => x.name === teeName) || tees[0];
    if (t) setCourse(t.holes.map((h) => ({ ...h })));
  }, [tees, teeName]);

  const selectTee = (name: string) => setTeeName(name);

  // Par and S.I. are shared by every tee; yards belong to one tee.
  const editPar = (i: number, v: string) => {
    const n = Math.max(0, Math.min(7, parseInt(v) || 0));
    setTees((ts) => ts.map((t) => ({ ...t, holes: t.holes.map((h, k) => (k === i ? { ...h, par: n } : h)) })));
  };
  const editSI = (i: number, v: string) => {
    const n = Math.max(0, Math.min(18, parseInt(v) || 0));
    setTees((ts) => ts.map((t) => ({ ...t, holes: t.holes.map((h, k) => (k === i ? { ...h, si: n } : h)) })));
  };
  const editYards = (teeIdx: number, i: number, v: string) => {
    const n = Math.max(0, Math.min(999, parseInt(v) || 0));
    setTees((ts) => ts.map((t, ti) => {
      if (ti !== teeIdx) return t;
      const holes = t.holes.map((h, k) => (k === i ? { ...h, yards: n } : h));
      return { ...t, holes, total: holes.reduce((s, h) => s + (h.yards || 0), 0) };
    }));
  };

  const GL = (n: number) => String.fromCharCode(65 + n);
  const cap = outing ? 32 : 8;
  const addP = () => players.length < cap && setPlayers([...players, { name: "", hcp: "12", group: GL(Math.floor(players.length / 4) % Math.max(1, groupCount)) }]);
  const rmP = (i: number) => setPlayers(players.filter((_, k) => k !== i));
  const setP = (i: number, key: "name" | "hcp", v: string) => setPlayers(players.map((p, k) => (k === i ? { ...p, [key]: v } : p)));
  const cycleGroup = (i: number) => setPlayers(players.map((p, k) => (k === i ? { ...p, group: GL((p.group.charCodeAt(0) - 65 + 1) % Math.max(1, groupCount)) } : p)));
  const toggleOuting = () => {
    const on = !outing; setOuting(on);
    if (on) setPlayers((ps) => ps.map((p, i) => ({ ...p, group: GL(Math.floor(i / 4)) })));
  };
  const setGroups = (n: number) => {
    const gc = Math.max(2, Math.min(8, n)); setGroupCount(gc);
    setPlayers((ps) => ps.map((p) => ({ ...p, group: p.group.charCodeAt(0) - 65 >= gc ? GL(gc - 1) : p.group })));
  };
  const adminLogin = async () => {
    setAdminMsg("");
    try {
      const r = await fetch("/api/admin/check", { method: "POST", headers: { "x-admin-key": adminKey } });
      const d: any = await r.json();
      if (d.ok) { setAdminAuthed(true); loadAdminCourses(); }
      else setAdminMsg(d.configured === false ? "Admin isn't set up yet — add the ADMIN_KEY secret in Cloudflare." : "Wrong password.");
    } catch { setAdminMsg("Couldn't reach the server."); }
  };
  const loadAdminCourses = async () => {
    try {
      const r = await fetch("/api/admin/courses", { headers: { "x-admin-key": adminKey } });
      const d: any = await r.json();
      setAdminCourses(d.courses || []);
    } catch { setAdminMsg("Couldn't load courses."); }
  };
  const deleteAdminCourse = async (id: string) => {
    try {
      const r = await fetch("/api/admin/courses/delete", { method: "POST", headers: { "x-admin-key": adminKey, "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const d: any = await r.json();
      if (d.ok) setAdminCourses((cs) => cs.filter((c) => c.id !== id));
    } catch { setAdminMsg("Delete failed."); }
  };
  const closeAdmin = () => { setAdminOpen(false); setAdminAuthed(false); setAdminKey(""); setAdminCourses([]); setAdminMsg(""); };

  const parTotal = course.reduce((s, h) => s + h.par, 0);
  const selTee = tees.find((t) => t.name === teeName) || tees[0];

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
    const named = players.map((p) => ({ name: p.name.trim(), hcp: p.hcp, group: p.group })).filter((p) => p.name);
    const payload = {
      name: roundName.trim() || "Round", formats, games: outing ? { wolf: false, nines: false, sixes: false, vegas: false, nassau: false, bbb: false } : games,
      outing, groupCount, handicapMode: hcpMode,
      course, lat: loc.lat, lng: loc.lng,
      courseName: loaded ? courseName.trim() : "", courseWhere, teeName: loaded ? teeName : "",
      tees: loaded && tees.length ? tees : null, defaultTee: loaded ? teeName : "",
      players: named.map((p, i) => ({ id: `p${i + 1}`, name: p.name.trim(), hcp: Math.max(0, Math.min(54, parseInt(p.hcp) || 0)), ...(outing ? { group: p.group } : {}) })),
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
        <header className="hero logo-hero">
          <FullLogo />
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
                  <input ref={fileIn} type="file" accept="image/*" onChange={onScan} style={{ display: "none" }} />
                  <button className="scanbtn" disabled={scanning} onClick={() => fileIn.current?.click()}>
                    <Camera size={16} /> {scanning ? "Reading scorecard…" : "Scan a scorecard"}
                  </button>
                  <p className="hint left">No course? Snap the scorecard and we'll read it — and save it for everyone. Or leave blank for the demo Par 72.</p>
                </>
              ) : (
                <>
                  <div className="coursecard">
                    <div className="cc-info">
                      <input className="cc-nameinput" value={courseName} onChange={(e) => setCourseName(e.target.value)} placeholder="Course name" />
                      <div className="cc-meta">{course.length} holes · Par {parTotal}{teeName ? ` · ${teeName}` : ""}{selTee?.total ? ` · ${selTee.total.toLocaleString()} yds` : ""}</div>
                    </div>
                    <button className="rm" onClick={clearCourse} aria-label="clear course"><X size={15} /></button>
                  </div>
                  {scanned && <p className="hint left warn">Scanned — tap a tee name to use it, and double-check the numbers (especially the S.I. row).</p>}
                  {siEstimated && !scanned && <p className="hint left warn">Stroke index was estimated — fine-tune below if needed.</p>}
                  <button className="addp" onClick={() => setEditing(!editing)}>
                    <ChevronDown size={15} style={{ transform: editing ? "rotate(180deg)" : "none", transition: ".2s" }} /> {editing ? "Hide scorecard" : "Select Tee / Edit Scorecard"}
                  </button>
                  {editing && (
                    <div className="cardgrid">
                      {(course.length > 9 ? [[0, 9], [9, course.length]] : [[0, course.length]]).map(([from, to], seg) => (
                        <div className="cg-wrap" key={seg}>
                          <table className="cg">
                            <thead>
                              <tr>
                                <th className="cg-rl">Hole</th>
                                {course.slice(from, to).map((h) => (<th key={h.num}>{h.num}</th>))}
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <th className="cg-rl">Par</th>
                                {course.slice(from, to).map((h, k) => (
                                  <td key={h.num}><input inputMode="numeric" value={h.par || ""} onChange={(e) => editPar(from + k, e.target.value)} /></td>
                                ))}
                              </tr>
                              <tr>
                                <th className="cg-rl">S.I.</th>
                                {course.slice(from, to).map((h, k) => (
                                  <td key={h.num}><input inputMode="numeric" value={h.si || ""} onChange={(e) => editSI(from + k, e.target.value)} /></td>
                                ))}
                              </tr>
                              {tees.map((t, ti) => (
                                <tr key={t.name + ti} className={teeName === t.name ? "cg-tee on" : "cg-tee"}>
                                  <th className="cg-rl tee" onClick={() => selectTee(t.name)} title="Use this tee for the round">
                                    <span className="dot" />{t.name}
                                  </th>
                                  {Array.from({ length: to - from }).map((_, k) => (
                                    <td key={k}><input className="dim" inputMode="numeric" value={t.holes[from + k]?.yards || ""} onChange={(e) => editYards(ti, from + k, e.target.value)} /></td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                      <p className="hint left">Tap a tee name to use it for this round. Tap any number to fix it — Par and S.I. apply to every tee.</p>
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
              <span>Format of play</span>
              <div className="seg sub">
                <button className={`seg-btn ${!outing ? "on" : ""}`} onClick={() => { if (outing) toggleOuting(); }}>One group</button>
                <button className={`seg-btn ${outing ? "on" : ""}`} onClick={() => { if (!outing) toggleOuting(); }}>Outing</button>
              </div>
              {outing && (
                <div className="grpcount">
                  <span>Foursomes</span>
                  <div className="steppermini">
                    <button onClick={() => setGroups(groupCount - 1)} aria-label="fewer">–</button><b>{groupCount}</b><button onClick={() => setGroups(groupCount + 1)} aria-label="more">+</button>
                  </div>
                </div>
              )}
              {outing && <p className="hint">One code for the whole outing. Tag each player to a group — each foursome enters only their own scores, and the board rolls everyone up.</p>}
            </div>

            <div className="field">
              <span>Players</span>
              <div className="players">
                {players.map((p, i) => (
                  <div className="prow" key={i}>
                    {outing && <button className="grppill" onClick={() => cycleGroup(i)} aria-label="group">{p.group}</button>}
                    <input className="pname" value={p.name} onChange={(e) => setP(i, "name", e.target.value)} placeholder={i === 0 ? "You" : `Player ${i + 1}`} />
                    <div className="hcpbox">
                      <input className="phcp" inputMode="numeric" value={p.hcp} onChange={(e) => setP(i, "hcp", e.target.value.replace(/[^0-9]/g, ""))} />
                      <em>hcp</em>
                    </div>
                    {players.length > 1 && <button className="rm" onClick={() => rmP(i)} aria-label="remove"><X size={15} /></button>}
                  </div>
                ))}
              </div>
              {players.length < cap && <button className="addp" onClick={addP}><Plus size={15} strokeWidth={2.4} /> Add player</button>}
            </div>

            <div className="field">
              <span>Scoring</span>
              <div className="chips">
                {FORMAT_DEFS.map((f) => (
                  <button key={f.id} className={`chip ${formats[f.id] ? "on" : ""}`} onClick={() => setFormats({ ...formats, [f.id]: !formats[f.id] })}>{f.label}</button>
                ))}
              </div>
            </div>

            {!outing && (
            <div className="field">
              <span>Games <em className="opt">optional</em></span>
              <div className="chips">
                {GAME_DEFS.map((f) => (
                  <button key={f.id} className={`chip ${games[f.id] ? "on" : ""}`} onClick={() => setGames({ ...games, [f.id]: !games[f.id] })}>{f.label}</button>
                ))}
              </div>
              {GAME_DEFS.some((f) => games[f.id]) && (
                <div className="gamehelp">
                  {GAME_DEFS.filter((f) => games[f.id]).map((f) => (
                    <div className="gh" key={f.id}><b>{f.label}</b><span>{GAME_HELP[f.id]}</span></div>
                  ))}
                </div>
              )}
            </div>
            )}

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

        <button className="adminlink" onClick={() => setAdminOpen(true)}>Admin</button>

        <div className="ver">Greenside {VERSION}</div>

        {adminOpen && (
          <div className="modal"><div className="sheet">
            {!adminAuthed ? (
              <>
                <h3>Admin</h3>
                <p>Enter the admin password to manage saved courses.</p>
                <input className="admin-pw" type="password" placeholder="Password" value={adminKey}
                  onChange={(e) => setAdminKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") adminLogin(); }} />
                {adminMsg && <p className="err">{adminMsg}</p>}
                <button className="primary" onClick={adminLogin}>Log in</button>
                <button className="ghostbtn" onClick={closeAdmin}>Cancel</button>
              </>
            ) : (
              <>
                <h3>Manage courses</h3>
                <p className="hint left">Tap Delete to remove a bad saved card. This can't be undone.</p>
                {adminMsg && <p className="err">{adminMsg}</p>}
                <div className="adminlist">
                  {adminCourses.length === 0 && <p className="hint left">No saved courses.</p>}
                  {adminCourses.map((c) => (
                    <div className="adminrow" key={c.id}>
                      <div className="adminrow-info"><b>{c.name}</b>{c.where ? <span> · {c.where}</span> : null}<span className="dim"> · {c.plays}×</span></div>
                      <button className="delbtn" onClick={() => deleteAdminCourse(c.id)}>Delete</button>
                    </div>
                  ))}
                </div>
                <button className="ghostbtn" onClick={closeAdmin}>Done</button>
              </>
            )}
          </div></div>
        )}
      </div>
    </div>
  );
}
