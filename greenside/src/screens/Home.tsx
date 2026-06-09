import { useState, useEffect, useRef } from "react";
import { Plus, X, Search, Camera, MapPin, ChevronDown, Bookmark, RotateCcw, Trash2, ChevronLeft } from "lucide-react";
import { computeStandings, fmtToPar } from "../lib/golf";
import { FullLogo } from "../components/Logo";
import { DEFAULT_COURSE, type Hole, FORMAT_DEFS, HCP_DEFS, GAME_DEFS, GAME_HELP, composeNines, ninesFromHoles } from "../lib/golf";

const VERSION = "v74";



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
  const [games, setGames] = useState<Record<string, boolean>>({ wolf: false, nines: false, sixes: false, vegas: false, nassau: false, bbb: false, bestball: false });
  const [hcpMode, setHcpMode] = useState<"perHole" | "course" | "gross">("perHole");
  const [joinCode, setJoinCode] = useState((location.hash.match(/#\/r\/([A-Za-z0-9-]+)/) || [])[1] || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [last] = useState(() => ({ code: localStorage.getItem("gs:lastRound") || "", name: localStorage.getItem("gs:lastRoundName") || "" }));
  const [confirmNew, setConfirmNew] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [myRounds, setMyRounds] = useState<any[]>([]);
  const [viewRound, setViewRound] = useState<any | null>(null);
  const [delCode, setDelCode] = useState<string>("");
  const loadMyRounds = () => { try { setMyRounds(JSON.parse(localStorage.getItem("gs:rounds") || "[]")); } catch { setMyRounds([]); } };
  useEffect(() => { loadMyRounds(); }, []);
  const deleteMyRound = (code: string) => {
    const next = myRounds.filter((r) => r.code !== code);
    setMyRounds(next); setDelCode(""); if (viewRound?.code === code) setViewRound(null);
    try { localStorage.setItem("gs:rounds", JSON.stringify(next)); } catch { /* */ }
  };
  const roundResult = (snap: any) => {
    const fmt = ["net", "gross", "stableford", "chicago", "skins"].find((f) => snap.formats?.[f]) || "net";
    try {
      const st = computeStandings(snap, fmt);
      if (!st.length) return null;
      const winner = st[0];
      const wname = snap.players.find((p: any) => p.id === winner.id)?.name || "—";
      return { fmt, winner: wname, st };
    } catch { return null; }
  };
  const [adminKey, setAdminKey] = useState("");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminCourses, setAdminCourses] = useState<{ id: string; name: string; where: string; plays: number }[]>([]);
  const [adminMsg, setAdminMsg] = useState("");
  const [coverage, setCoverage] = useState<any[] | null>(null);
  const [covRunning, setCovRunning] = useState(false);
  const [covTotal, setCovTotal] = useState(0);
  const [editId, setEditId] = useState("");
  const [editName, setEditName] = useState("");
  const [editWhere, setEditWhere] = useState("");

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
  const [nines3, setNines3] = useState(false);
  const nines3Ref = useRef(false);
  const scanModeRef = useRef<"9" | "18" | "27">("18");
  const [scanChoose, setScanChoose] = useState(false);
  const chooseScan = (mode: "9" | "18" | "27") => {
    scanModeRef.current = mode; nines3Ref.current = mode === "27"; setNines3(mode === "27"); setScanChoose(false);
    setTimeout(() => fileIn.current?.click(), 0);
  };
  const [ninesRaw, setNinesRaw] = useState<{ name: string; par: number[]; si: number[]; tees: { name: string; yards: number[] }[] }[] | null>(null);
  const [ninePick, setNinePick] = useState<number[]>([]);
  const composeFromPick = (raw: typeof ninesRaw, pick: number[]) => {
    if (!raw || !pick.length) return;
    const structNines = pick.map((i) => ({ name: raw[i].name, holes: raw[i].par.map((p, k) => ({ num: k + 1, par: Number(p) || 4, yards: 0, si: Number(raw[i].si[k]) || 0 })) }));
    const composed = composeNines(structNines);
    const lists = pick.map((i) => raw[i].tees.map((t) => t.name));
    let names = lists[0] || [];
    for (const a of lists.slice(1)) names = names.filter((nm) => a.includes(nm));
    if (!names.length) names = lists[0] || ["Tees"];
    const composedTees = names.map((tn) => {
      const holes = composed.map((h, k) => {
        const ni = Math.floor(k / 9), hi = k % 9;
        const tee = raw[pick[ni]].tees.find((t) => t.name === tn);
        return { ...h, yards: tee ? (Number(tee.yards[hi]) || 0) : 0 };
      });
      return { name: tn, total: holes.reduce((s, h) => s + h.yards, 0), holes };
    });
    setTees(composedTees.length ? composedTees : [{ name: "Tees", total: 0, holes: composed }]);
    setTeeName(composedTees[0]?.name || "Tees");
  };
  const pickNines = (next: number[]) => { setNinePick(next); composeFromPick(ninesRaw, next); };
  const toggleNine = (i: number) => {
    const has = ninePick.includes(i);
    const next = has ? ninePick.filter((x) => x !== i) : [...ninePick, i];
    if (next.length) pickNines(next);
  };
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
      const rawHoles: any[] = (data.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si, nine: h.nine }));
      if (!rawHoles.length) { setMsg("That course had no scorecard data. Try another or scan it."); setSearching(false); return; }
      // A saved 27-hole / three-nines course: rebuild the nine picker instead of a flat load.
      const labels = new Set(rawHoles.map((h) => h.nine).filter(Boolean));
      if (labels.size >= 2) {
        const grouped = ninesFromHoles(rawHoles as any);
        const teesIn = (data.tees || []).map((t: any) => ({ name: t.name, holes: (t.holes || []).map((h: any) => ({ ...h })) }));
        const raw = grouped.map((g) => ({
          name: g.name,
          par: g.holes.map((h) => h.par),
          si: g.holes.map((h) => (h as any).si),
          tees: teesIn.map((t: any) => ({ name: t.name, yards: t.holes.filter((h: any) => h.nine === g.name).map((h: any) => h.yards) })).filter((t: any) => t.yards.length === g.holes.length),
        }));
        const pick = raw.length >= 2 ? [0, 1] : raw.map((_, i) => i);
        setNinesRaw(raw); setNinePick(pick); composeFromPick(raw, pick);
        setCourseName(data.name || hit.name); setCourseWhere(data.where || hit.where || "");
        setLoc({ lat: data.lat ?? hit.lat, lng: data.lng ?? hit.lng });
        setSiEstimated(false); setScanned(false); setLoaded(true); setEditing(false);
        if (!nameTouched) setRoundName(data.name || hit.name);
        setSearching(false);
        return;
      }
      const holes: Hole[] = rawHoles.map((h) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
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
      const q = scanModeRef.current === "27" ? "?nines=3" : scanModeRef.current === "9" ? "?holes=9" : "";
      const r = await fetch(`/api/courses/scan${q}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
      if (!r.ok) {
        setMsg("Couldn't read that photo clearly — enter the holes by hand below, or try a flatter, brighter shot.");
        const blank = DEFAULT_COURSE.map((h) => ({ ...h, yards: 0, si: 0 }));
        setTees([{ name: "Tees", total: 0, holes: blank }]); setTeeName("Tees");
        setCourse(blank); setCourseName(""); setCourseWhere("");
        setLoc({ lat: null, lng: null }); setSiEstimated(false); setScanned(true); setLoaded(true); setEditing(true);
      } else {
        const data: any = await r.json();
        if (data.multiNine && Array.isArray(data.nines) && data.nines.length) {
          const raw = data.nines.map((n: any) => ({ name: String(n.name || "Nine"), par: n.par || [], si: n.si || [], tees: (n.tees || []).map((t: any) => ({ name: t.name, yards: t.yards || [] })) }));
          const pick = raw.length >= 2 ? [0, 1] : raw.map((_: any, i: number) => i);
          setNinesRaw(raw); setNinePick(pick); composeFromPick(raw, pick);
          setCourseName(data.name || ""); setCourseWhere("");
          setLoc({ lat: null, lng: null }); setSiEstimated(false); setScanned(true); setLoaded(true); setEditing(false);
          if (!nameTouched && data.name) setRoundName(data.name);
        } else {
        const holes: Hole[] = (data.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si }));
        const tlist = (data.tees || []).map((t: any) => ({ name: t.name, total: t.total, holes: (t.holes || []).map((h: any) => ({ num: h.num, par: h.par, yards: h.yards, si: h.si })) }));
        const base = holes.length ? holes : DEFAULT_COURSE;
        const tfinal = tlist.length ? tlist : [{ name: "Tees", total: base.reduce((s: number, h: Hole) => s + (h.yards || 0), 0), holes: base }];
        setTees(tfinal); setTeeName(data.defaultTee || tfinal[0]?.name || "");
        setCourse(base); setCourseName(data.name || ""); setCourseWhere("");
        setLoc({ lat: null, lng: null }); setSiEstimated(!!data.siEstimated); setScanned(true); setLoaded(true); setEditing(true);
        if (!nameTouched && data.name) setRoundName(data.name);
        }
      }
    } catch { setMsg("Couldn't process that image."); }
    setScanning(false);
    if (fileIn.current) fileIn.current.value = "";
  }

  function clearCourse() {
    setLoaded(false); setScanned(false); setCourse(DEFAULT_COURSE); setCourseName(""); setCourseWhere("");
    setTees([]); setTeeName(""); setNinesRaw(null); setNinePick([]);
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
      if (d.ok) { setAdminAuthed(true); loadAdminCourses(); loadStats(); }
      else setAdminMsg(d.configured === false ? "Admin isn't set up yet — add the ADMIN_KEY secret in Cloudflare." : "Wrong password.");
    } catch { setAdminMsg("Couldn't reach the server."); }
  };
  const [stats, setStats] = useState<any>(null);
  const [statsReset, setStatsReset] = useState(false);
  const loadStats = async () => {
    try { const r = await fetch("/api/admin/stats", { headers: { "x-admin-key": adminKey } }); setStats(await r.json()); } catch { /* */ }
  };
  const resetStats = async () => {
    setStatsReset(false);
    try { await fetch("/api/admin/stats/reset", { method: "POST", headers: { "x-admin-key": adminKey } }); loadStats(); } catch { /* */ }
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
  const startEdit = (c: { id: string; name: string; where: string }) => { setEditId(c.id); setEditName(c.name); setEditWhere(c.where || ""); };
  const saveEdit = async () => {
    if (!editName.trim()) return;
    try {
      const r = await fetch("/api/admin/courses/rename", { method: "POST", headers: { "x-admin-key": adminKey, "content-type": "application/json" }, body: JSON.stringify({ id: editId, name: editName.trim(), where: editWhere.trim() }) });
      const d: any = await r.json();
      if (d.ok) { setAdminCourses((cs) => cs.map((c) => c.id === editId ? { ...c, name: editName.trim(), where: editWhere.trim() } : c)); setEditId(""); setCoverage(null); }
      else setAdminMsg("Rename failed.");
    } catch { setAdminMsg("Rename failed."); }
  };
  const [covSel, setCovSel] = useState<string[]>([]);
  const toggleCovSel = (id: string) => setCovSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const runCoverage = async () => {
    setCovRunning(true); setCoverage([]); setAdminMsg(""); setCovTotal(0);
    try {
      if (covSel.length) {
        const r = await fetch(`/api/admin/coverage?ids=${covSel.join(",")}`, { headers: { "x-admin-key": adminKey } });
        const d: any = await r.json();
        setCovTotal(d.total || 0); setCoverage(d.courses || []);
      } else {
        let offset = 0; const acc: any[] = [];
        for (let page = 0; page < 40; page++) {
          const r = await fetch(`/api/admin/coverage?offset=${offset}&limit=4`, { headers: { "x-admin-key": adminKey } });
          const d: any = await r.json();
          if (d.total != null) setCovTotal(d.total);
          acc.push(...(d.courses || []));
          setCoverage([...acc]);
          if (d.nextOffset == null) break;
          offset = d.nextOffset;
        }
      }
    } catch { setAdminMsg("Coverage check failed — try again."); }
    setCovRunning(false);
  };
  const closeAdmin = () => { setAdminOpen(false); setAdminAuthed(false); setAdminKey(""); setAdminCourses([]); setAdminMsg(""); setCoverage(null); setCovRunning(false); setCovTotal(0); setCovSel([]); };

  const parTotal = course.reduce((s, h) => s + h.par, 0);
  const selTee = tees.find((t) => t.name === teeName) || tees[0];

  function onCreatePress() {
    setErr("");
    const named = players.map((p) => p.name.trim()).filter(Boolean);
    if (!outing && !named.length) { setErr("Add at least one player."); return; }
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
    // For a three-nines course, save ALL nines to the catalog (raw, per-nine SI) so it stays a
    // 27-hole course on future searches — the round itself still uses the composed selection.
    let catalogHoles: any = null, catalogTees: any = null;
    if (ninesRaw && ninesRaw.length) {
      catalogHoles = ninesRaw.flatMap((n) => n.par.map((p, k) => ({ num: k + 1, par: Number(p) || 4, yards: 0, si: Number(n.si[k]) || 0, nine: n.name })));
      const lists = ninesRaw.map((n) => n.tees.map((t) => t.name));
      let names = lists[0] || []; for (const a of lists.slice(1)) names = names.filter((nm) => a.includes(nm));
      if (!names.length) names = lists[0] || [];
      catalogTees = names.map((tn) => {
        const holes = ninesRaw.flatMap((n) => { const tee = n.tees.find((t) => t.name === tn); return n.par.map((p, k) => ({ num: k + 1, par: Number(p) || 4, yards: tee ? Number(tee.yards[k]) || 0 : 0, si: Number(n.si[k]) || 0, nine: n.name })); });
        return { name: tn, total: holes.reduce((s, h) => s + h.yards, 0), holes };
      });
    }
    const payload = {
      name: roundName.trim() || "Round", formats, games: outing ? { wolf: false, nines: false, sixes: false, vegas: false, nassau: false, bbb: false, bestball: false } : games,
      outing, groupCount, handicapMode: hcpMode,
      course, lat: loc.lat, lng: loc.lng,
      courseName: loaded ? courseName.trim() : "", courseWhere, teeName: loaded ? teeName : "",
      tees: loaded && tees.length ? tees : null, defaultTee: loaded ? teeName : "",
      catalogHoles, catalogTees,
      players: named.map((p, i) => ({ id: `p${i + 1}`, name: p.name.trim(), hcp: Math.max(0, Math.min(54, parseInt(p.hcp) || 0)), ...(outing ? { group: p.group } : {}) })),
    };
    try {
      const r = await fetch("/api/round", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const { code, adminToken } = await r.json();
      localStorage.removeItem(`gs:ended:${code}`);
      if (adminToken) localStorage.setItem(`gs:admin:${code}`, adminToken);
      if (outing) {
        localStorage.setItem(`gs:creator:${code}`, "1");
        localStorage.setItem(`gs:claimed:${code}`, "1"); // organizer view; can join a foursome later
      } else {
        localStorage.setItem(`gs:me:${code}`, "p1"); localStorage.setItem(`gs:claimed:${code}`, "1");
      }
      localStorage.setItem("gs:lastRound", code); localStorage.setItem("gs:lastRoundName", payload.name);
      location.hash = `#/r/${code}`;
    } catch { setErr("Couldn't create the round. Try again."); setBusy(false); }
  }
  function join() {
    const c = joinCode.trim().toUpperCase();
    if (c.length < 3) { setErr("Enter the round code."); return; }
    localStorage.removeItem(`gs:ended:${c.split("-")[0]}`); // explicit re-entry clears the ended block
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
          <div className="resume-wrap">
            <button className="resume" onClick={() => { location.hash = `#/r/${last.code}`; }}>
              <RotateCcw size={16} />
              <span className="rs-txt">Resume your round<em>{last.name || last.code}</em></span>
              <span className="rs-code">{last.code}</span>
            </button>
            <button className="resume-edit" onClick={() => { sessionStorage.setItem("gs:editOnOpen", last.code); location.hash = `#/r/${last.code}`; }}>Edit round settings</button>
          </div>
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
                  {!scanChoose ? (
                    <button className="scanbtn" disabled={scanning} onClick={() => setScanChoose(true)}>
                      <Camera size={16} /> {scanning ? "Reading scorecard…" : "Scan a scorecard"}
                    </button>
                  ) : (
                    <div className="scanchoose">
                      <div className="scanchoose-h">How many holes on the card?</div>
                      <button className="scanopt" onClick={() => chooseScan("9")}><b>9-hole course</b><small>holes 1–9 only</small></button>
                      <button className="scanopt" onClick={() => chooseScan("18")}><b>18-hole course</b><small>standard front & back nine</small></button>
                      <button className="scanopt" onClick={() => chooseScan("27")}><b>27-hole course</b><small>three nines on one card</small></button>
                      <button className="scanchoose-x" onClick={() => setScanChoose(false)}>Cancel</button>
                    </div>
                  )}
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
                  {loc.lat == null && (
                    <div className="cc-where">
                      <label className="cc-where-l">Course location <span>— so the hole map loads automatically</span></label>
                      <input className="cc-where-in" value={courseWhere} onChange={(e) => setCourseWhere(e.target.value)} placeholder="City, State (e.g. Pewaukee, WI)" />
                    </div>
                  )}
                  {ninesRaw && ninesRaw.length >= 2 && (
                    <div className="ninepick">
                      <div className="ninepick-h">Which nines are you playing? <span>tap in the order you'll play</span></div>
                      <div className="ninechips">
                        {ninesRaw.map((nine, i) => {
                          const pos = ninePick.indexOf(i);
                          return (
                            <button key={i} className={`ninechip ${pos >= 0 ? "on" : ""}`} onClick={() => toggleNine(i)}>
                              {pos >= 0 && <span className="ninechip-n">{pos + 1}</span>}{nine.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {scanned && <p className="hint left warn">Scanned — tap a tee name to use it, and double-check the numbers (especially the S.I. row).</p>}
                  {siEstimated && !scanned && <p className="hint left warn">Stroke index was estimated — fine-tune below if needed.</p>}
                  <button className="addp" onClick={() => setEditing(!editing)}>
                    <ChevronDown size={15} style={{ transform: editing ? "rotate(180deg)" : "none", transition: ".2s" }} /> {editing ? "Hide scorecard" : "Select Tee / Edit Scorecard"}
                  </button>
                  {editing && (
                    <div className="cardgrid">
                      {(() => {
                        const labeled = course.some((h) => (h as any).nine);
                        let segs: { label: string; from: number; to: number }[];
                        if (labeled) {
                          segs = []; let start = 0;
                          for (let i = 1; i <= course.length; i++) {
                            if (i === course.length || (course[i] as any).nine !== (course[start] as any).nine) { segs.push({ label: (course[start] as any).nine || "", from: start, to: i }); start = i; }
                          }
                        } else if (course.length > 9) { segs = []; for (let i = 0; i < course.length; i += 9) segs.push({ label: "", from: i, to: Math.min(i + 9, course.length) }); }
                        else segs = [{ label: "", from: 0, to: course.length }];
                        return segs.map((sg, seg) => {
                          const [from, to] = [sg.from, sg.to];
                          return (
                        <div className="cg-wrap" key={seg}>
                          {sg.label && <div className="cg-ninelabel">{sg.label}</div>}
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
                          );
                        });
                      })()}
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
              {outing && <p className="hint">One outing code, and each foursome gets its own join link — Group 1, Group 2, and so on, up to 36. Players open their link, type their name, and they're on that team. You'll get the links to share the moment you create it.</p>}
            </div>

            {!outing && (
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
            )}

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
            {myRounds.length > 0 && (
              <div className="myrounds-wrap">
                <button className="myrounds-btn" onClick={() => { loadMyRounds(); setRoundsOpen(true); }}>My rounds<span className="myrounds-n">{myRounds.length}</span></button>
              </div>
            )}
          </div>
        ) : (
          <div className="panel">
            <label className="field">
              <span>Round code</span>
              <input className="code-in" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))} placeholder="ABCD or ABCD-1" maxLength={8} />
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

        {roundsOpen && (
          <div className="roundswrap" onClick={() => { setRoundsOpen(false); setViewRound(null); setDelCode(""); }}>
            <div className="roundscard" onClick={(e) => e.stopPropagation()}>
              {!viewRound ? (
                <>
                  <div className="rounds-head"><h3>My rounds</h3><button className="xbtn" onClick={() => setRoundsOpen(false)}>✕</button></div>
                  <p className="hint left">Saved on this device — no account. Clearing your browser data removes them.</p>
                  <div className="rounds-list">
                    {myRounds.length === 0 && <p className="hint left">No rounds yet.</p>}
                    {myRounds.map((r) => {
                      const res = roundResult(r);
                      const thru = res ? Math.max(0, ...res.st.map((s: any) => s.thru)) : 0;
                      return (
                        <div className="roundrow" key={r.code}>
                          {delCode === r.code ? (
                            <div className="roundrow-del">
                              <span>Delete this round?</span>
                              <button className="delbtn" onClick={() => deleteMyRound(r.code)}>Delete</button>
                              <button className="ghostbtn sm" onClick={() => setDelCode("")}>Cancel</button>
                            </div>
                          ) : (
                            <>
                              <button className="roundrow-main" onClick={() => setViewRound(r)}>
                                <div className="rr-top"><b>{r.name || r.code}</b><span className="rr-date">{new Date(r.savedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span></div>
                                <div className="rr-sub">{r.courseName || "Course"}{res ? ` · Won: ${res.winner}` : ""}{thru ? ` · thru ${thru}` : ""}</div>
                              </button>
                              <button className="rr-trash" onClick={() => setDelCode(r.code)} aria-label="delete"><Trash2 size={16} /></button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button className="ghostbtn" onClick={() => setRoundsOpen(false)}>Done</button>
                </>
              ) : (() => {
                const snap = viewRound;
                const res = roundResult(snap);
                const useHcp = snap.handicapMode !== "gross";
                const course = snap.course || [];
                const labeled = course.some((h: any) => h.nine);
                let chunks: { label: string; holes: any[] }[] = [];
                if (labeled) {
                  let s = 0; for (let i = 1; i <= course.length; i++) { if (i === course.length || course[i].nine !== course[s].nine) { chunks.push({ label: course[s].nine || "", holes: course.slice(s, i) }); s = i; } }
                } else { for (let i = 0; i < course.length; i += 9) chunks.push({ label: course.length <= 9 ? "Out" : ["Out", "In", "Third"][i / 9] || "", holes: course.slice(i, i + 9) }); }
                const sumSc = (pid: string, hs: any[]) => hs.reduce((t, h) => t + ((snap.scores[pid] || {})[h.num] || 0), 0);
                return (
                  <>
                    <div className="rounds-head">
                      <button className="backbtn" onClick={() => setViewRound(null)}><ChevronLeft size={18} /></button>
                      <h3 className="rd-title">{snap.name || snap.code}</h3>
                      <button className="xbtn" onClick={() => { setRoundsOpen(false); setViewRound(null); }}>✕</button>
                    </div>
                    <p className="hint left">{snap.courseName || "Course"} · {new Date(snap.savedAt).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</p>

                    {res && (
                      <div className="rd-board">
                        {res.st.map((s: any, i: number) => (
                          <div className={`rd-brow ${snap.me && s.id === snap.me ? "me" : ""}`} key={s.id}>
                            <span className="rd-rank">{i + 1}</span>
                            <span className="rd-name">{s.name}</span>
                            <span className="rd-score">{s.gross || "–"}{useHcp ? <em> ({fmtToPar(s.toParNet)})</em> : <em> ({fmtToPar(s.toParGross)})</em>}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="rd-cards">
                      {chunks.map((c, ci) => (
                        <div className="rd-chunk" key={ci}>
                          {c.label && <div className="rd-ninelabel">{c.label}</div>}
                          <div className="rd-scroll">
                            <table className="rd-grid">
                              <thead>
                                <tr><th>Hole</th>{c.holes.map((h) => <th key={h.num}>{h.num}</th>)}<th className="tot">Tot</th></tr>
                                <tr className="rd-par"><th>Par</th>{c.holes.map((h) => <th key={h.num}>{h.par}</th>)}<th className="tot">{c.holes.reduce((t, h) => t + h.par, 0)}</th></tr>
                              </thead>
                              <tbody>
                                {snap.players.map((p: any) => (
                                  <tr key={p.id} className={snap.me && p.id === snap.me ? "me" : ""}>
                                    <th>{p.name.split(" ")[0]}</th>
                                    {c.holes.map((h) => <td key={h.num}>{(snap.scores[p.id] || {})[h.num] || "·"}</td>)}
                                    <td className="tot">{sumSc(p.id, c.holes) || "–"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>

                    <button className="ghostbtn" onClick={() => { location.hash = `#/r/${snap.code}`; }}>Open round</button>
                  </>
                );
              })()}
            </div>
          </div>
        )}

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
                {stats && (
                  <div className="usage">
                    <div className="usage-h"><h3>Usage</h3><button className="ghostbtn sm" onClick={loadStats}>Refresh</button></div>
                    <div className="usage-grid">
                      <div className="ustat"><b>{stats.totals?.round || 0}</b><span>rounds all-time</span></div>
                      <div className="ustat"><b>{stats.today?.round || 0}</b><span>rounds today</span></div>
                      <div className="ustat"><b>{stats.d7?.round || 0}</b><span>rounds · 7d</span></div>
                      <div className="ustat"><b>{stats.d30?.round || 0}</b><span>rounds · 30d</span></div>
                      <div className="ustat"><b>{stats.totals?.scan || 0}</b><span>cards scanned</span></div>
                      <div className="ustat"><b>{stats.totals?.players || 0}</b><span>player slots</span></div>
                      <div className="ustat"><b>{stats.courses || 0}</b><span>courses saved</span></div>
                    </div>
                    {Array.isArray(stats.daily) && (() => {
                      const last = stats.daily.slice(-14);
                      const max = Math.max(1, ...last.map((d: any) => d.round));
                      return (
                        <div className="usage-chart">
                          <div className="uchart-label">Rounds · last 14 days</div>
                          <div className="uchart-bars">
                            {last.map((d: any) => (
                              <div key={d.day} className="uchart-col" title={`${d.day}: ${d.round}`}>
                                <div className="uchart-bar" style={{ height: `${Math.round((d.round / max) * 100)}%` }} />
                                <span className="uchart-d">{d.day.slice(8)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {!statsReset ? (
                      <button className="ghostbtn sm" onClick={() => setStatsReset(true)}>Reset usage stats</button>
                    ) : (
                      <div className="roundrow-del"><span>Reset all usage counts? (Use before launch to clear test data.)</span><button className="delbtn" onClick={resetStats}>Reset</button><button className="ghostbtn sm" onClick={() => setStatsReset(false)}>Cancel</button></div>
                    )}
                  </div>
                )}
                <h3>Manage courses</h3>
                <p className="hint left">Tap Delete to remove a bad saved card. This can't be undone.</p>
                {adminMsg && <p className="err">{adminMsg}</p>}
                <div className="adminlist">
                  {adminCourses.length === 0 && <p className="hint left">No saved courses.</p>}
                  {adminCourses.map((c) => (
                    <div className="adminrow" key={c.id}>
                      {editId === c.id ? (
                        <div className="adminedit">
                          <input className="admin-pw" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Course name" />
                          <input className="admin-pw" value={editWhere} onChange={(e) => setEditWhere(e.target.value)} placeholder="City, State" />
                          <div className="adminedit-btns">
                            <button className="primary" onClick={saveEdit}>Save</button>
                            <button className="ghostbtn" onClick={() => setEditId("")}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <input type="checkbox" className="covpick" checked={covSel.includes(c.id)} onChange={() => toggleCovSel(c.id)} aria-label="select for coverage" />
                          <div className="adminrow-info"><b>{c.name}</b>{c.where ? <span> · {c.where}</span> : null}<span className="dim"> · {c.plays}×</span></div>
                          <button className="editbtn" onClick={() => startEdit(c)}>Edit</button>
                          <button className="delbtn" onClick={() => deleteAdminCourse(c.id)}>Delete</button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {covSel.length > 0 && <p className="hint left">{covSel.length} selected — coverage will check just these.</p>}
                <button className="ghostbtn" onClick={runCoverage} disabled={covRunning}>{covRunning ? `Checking… ${coverage ? coverage.length : 0}${covTotal ? "/" + covTotal : ""}` : covSel.length ? `Check map for ${covSel.length} selected` : "Check hole-map coverage (all)"}</button>
                {coverage && (
                  <div className="adminlist">
                    {coverage.length === 0 && !covRunning && <p className="hint left">No courses.</p>}
                    {coverage.map((c) => {
                      const ok = c.holesMapped > 0;
                      const status = ok ? `✓ ${c.holesMapped}/${c.holesExpected} holes mapped${c.foundRaw != null && c.foundRaw !== c.holesMapped ? ` · ${c.foundRaw} in OSM` : ""}`
                        : c.source === "no-coords" ? "no location found"
                        : c.mapErr ? `map error: ${c.mapErr}`
                        : "not in OpenStreetMap";
                      return (
                        <div className="adminrow" key={c.id}>
                          <div className="adminrow-info"><b>{c.name}</b>{c.where ? <span> · {c.where}</span> : null}
                            <span className={ok ? "cov-ok" : "cov-no"}> · {status}</span>
                            {c.source === "geocoded" && <span className="dim"> · geocoded</span>}
                            {!ok && c.geo && (c.geo.tried || c.geo.overpass) && (
                              <span className="dim cov-dbg">
                                {(c.geo.tried || []).map((t: any) => `"${t.q}" → ${t.status != null ? t.status : (t.n + " hits" + (t.types && t.types.length ? " [" + t.types.join(", ") + "]" : ""))}`).join("  ·  ")}
                                {c.geo.overpass && `  ·  town ${typeof c.geo.overpass.town === "string" ? c.geo.overpass.town : "ok"}${c.geo.overpass.pick ? `, matched "${c.geo.overpass.pick}"` : `, nearby: ${(c.geo.overpass.nearby || []).join("; ") || "none"}`}`}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <button className="ghostbtn" onClick={closeAdmin}>Done</button>
              </>
            )}
          </div></div>
        )}
      </div>
    </div>
  );
}
