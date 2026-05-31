import { useState } from "react";
import { Flag, Plus, X } from "lucide-react";
import { DEFAULT_COURSE } from "../lib/golf";

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

export default function Home() {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [roundName, setRoundName] = useState("Saturday Round");
  const [players, setPlayers] = useState([{ name: "", hcp: "12" }]);
  const [formats, setFormats] = useState<Record<string, boolean>>({ net: true, gross: true, stableford: false, skins: false });
  const [hcpMode, setHcpMode] = useState<"perHole" | "course" | "gross">("perHole");
  const [joinCode, setJoinCode] = useState(decodeURIComponent((location.hash.match(/#\/r\/([A-Za-z0-9]+)/) || [])[1] || ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const addP = () => players.length < 8 && setPlayers([...players, { name: "", hcp: "12" }]);
  const rmP = (i: number) => setPlayers(players.filter((_, k) => k !== i));
  const setP = (i: number, key: "name" | "hcp", v: string) =>
    setPlayers(players.map((p, k) => (k === i ? { ...p, [key]: v } : p)));

  async function create() {
    setErr("");
    const named = players.map((p) => ({ name: p.name.trim(), hcp: p.hcp })).filter((p) => p.name);
    if (!named.length) { setErr("Add at least one player."); return; }
    if (!Object.values(formats).some(Boolean)) { setErr("Pick at least one format."); return; }
    setBusy(true);
    const payload = {
      name: roundName.trim() || "Round",
      formats,
      handicapMode: hcpMode,
      course: DEFAULT_COURSE,
      players: named.map((p, i) => ({
        id: `p${i + 1}`,
        name: p.name.trim(),
        hcp: Math.max(0, Math.min(54, parseInt(p.hcp) || 0)),
      })),
    };
    try {
      const r = await fetch("/api/round", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const { code } = await r.json();
      localStorage.setItem(`gs:me:${code}`, "p1");
      localStorage.setItem(`gs:claimed:${code}`, "1");
      location.hash = `#/r/${code}`;
    } catch {
      setErr("Couldn't create the round. Try again.");
      setBusy(false);
    }
  }

  function join() {
    const c = joinCode.trim().toUpperCase();
    if (c.length < 3) { setErr("Enter the round code."); return; }
    location.hash = `#/r/${c}`;
  }

  return (
    <div className="gs">
      <div className="frame home">
        <div className="topbar">
          <div className="mark"><Flag size={15} strokeWidth={2.2} /><span>GREENSIDE</span></div>
        </div>

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
            <label className="field">
              <span>Round name</span>
              <input value={roundName} onChange={(e) => setRoundName(e.target.value)} placeholder="Saturday Round" />
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
