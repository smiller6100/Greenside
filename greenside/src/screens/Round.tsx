import { useState, useMemo, useEffect, useRef } from "react";
import { Minus, Plus, Crown, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Trophy, ClipboardList, Copy, Check, Home } from "lucide-react";
import { LogoMark } from "../components/Logo";
import { useRound } from "../lib/useRound";
import { computeStandings, computeGames, computeTeams, strokesOn, toParClass, fmtToPar, holesUp, sixesSegs } from "../lib/golf";

const FORMAT_LABELS: Record<string, string> = { net: "Net", gross: "Gross", stableford: "Stableford", chicago: "Chicago", skins: "Skins", card: "Full card", games: "Games", teams: "Teams" };

export default function Round({ code }: { code: string }) {
  const { state, connected, missing, sendScore, sendWolfPick, sendBbb, sendPress } = useRound(code);
  const [tab, setTab] = useState<"board" | "score">("board");
  const [view, setView] = useState("net"); // a scoring format (leaderboard side)
  const [scView, setScView] = useState<"hole" | "card" | "games">("hole"); // scorecard side
  const [holeIdx, setHoleIdx] = useState(0);
  const [grp, setGrp] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(() => localStorage.getItem(`gs:me:${code}`));
  const [claimed, setClaimed] = useState(() => localStorage.getItem(`gs:claimed:${code}`) === "1");
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const enabledFormats = useMemo(
    () => (state ? Object.keys(state.formats).filter((k) => state.formats[k as keyof typeof state.formats]) : []),
    [state]
  );

  const didInit = useRef(false);
  useEffect(() => {
    if (state && !didInit.current) { didInit.current = true; if (state.outing) setView("teams"); }
  }, [state]);

  useEffect(() => {
    if (enabledFormats.length && view !== "teams" && !enabledFormats.includes(view)) setView(enabledFormats[0]);
  }, [enabledFormats, view]);

  // remember this round so Home can offer to resume it
  useEffect(() => {
    if (state) { localStorage.setItem("gs:lastRound", code); localStorage.setItem("gs:lastRoundName", state.name || code); }
  }, [state, code]);

  const standings = useMemo(() => (state && view !== "card" ? computeStandings(state, view) : []), [state, view]);
  const games = useMemo(() => (state ? computeGames(state) : null), [state]);

  if (missing) {
    return (
      <Shell>
        <div className="empty"><LogoMark size={40} /><h2>Round not found</h2><p>Double-check the code, or start a new round.</p>
          <button className="primary" onClick={() => { location.hash = ""; }}>Back to start</button></div>
      </Shell>
    );
  }
  if (!state) {
    return <Shell><div className="empty loadwrap"><LogoMark size={88} className="loadmark" /><p>Connecting to {code}…</p></div></Shell>;
  }

  const course = state.course;
  const hole = course[holeIdx];
  const useHcp = state.handicapMode !== "gross";
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.name || "?";
  const enabledGames = state.games ? Object.keys(state.games).filter((k) => (state.games as any)[k]) : [];
  const myGroup = state.players.find((p) => p.id === me)?.group;
  const groups = state.outing ? Array.from(new Set(state.players.map((p) => p.group || "A"))).sort() : [];
  const effGrp = grp ?? myGroup ?? groups[0] ?? null;

  const TeamsPanel = () => {
    const rows = computeTeams(state);
    return (
      <>
        <div className="board">
          {rows.map((t, i) => (
            <div key={t.group} className={`row ${i === 0 && t.thru > 0 ? "lead" : ""} ${t.group === myGroup ? "self" : ""}`}>
              <div className="pos">{i === 0 && t.thru > 0 ? <Crown size={16} strokeWidth={2.2} /> : i + 1}</div>
              <div className="who"><div className="nm">Group {t.group}{t.group === myGroup && <em>You</em>}</div><div className="mt">{t.names.join(", ")}{t.thru ? ` · Thru ${t.thru === 18 ? "F" : t.thru}` : ""}</div></div>
              <div className={`val ${t.thru ? toParClass(t.toPar) : ""}`}>{t.thru ? fmtToPar(t.toPar) : "–"}</div>
            </div>
          ))}
        </div>
        <p className="foot">Each foursome’s 2 best net scores per hole</p>
      </>
    );
  };

  const vegasLead = (v: any) => {
    const d = v.pts[0] - v.pts[1];
    if (d === 0) return "All even";
    return d > 0 ? `${v.teams[0].map(nameOf).join(" & ")} lead by ${d}` : `${v.teams[1].map(nameOf).join(" & ")} lead by ${-d}`;
  };

  const bestBallLead = (v: any) => {
    if (v.a.thru === 0 && v.b.thru === 0) return "No scores yet.";
    const d = v.a.toPar - v.b.toPar; // lower is better
    if (d === 0) return "All even.";
    return d < 0 ? `${v.teams[0].map(nameOf).join(" & ")} lead by ${-d}` : `${v.teams[1].map(nameOf).join(" & ")} lead by ${d}`;
  };

  const GamesPanel = () => {
    if (!games?.anyOn) return <p className="foot">No games picked for this round.</p>;
    const ranked = (pts: Record<string, number>) => [...state.players].sort((a, b) => pts[b.id] - pts[a.id]);
    const fmtPts = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const need = (label: string, want: string) => <div className="gnote">{label} needs {want} players — this round has {games.n}.</div>;
    return (
      <div className="gamewrap">
        {state.games?.wolf && (games.wolf ? (
          <div className="gcard">
            <h3>Wolf</h3>
            {ranked(games.wolf.points).map((p) => (
              <div className="grow" key={p.id}><span className={p.id === me ? "me" : ""}>{p.name}</span><b>{games.wolf.points[p.id]} pts</b></div>
            ))}
            <p className="ghint">Wolf rotates each hole — set the pick on the Scorecard tab.</p>
          </div>
        ) : need("Wolf", "3 or 4"))}
        {state.games?.nines && (games.nines ? (
          <div className="gcard">
            <h3>Nines</h3>
            {ranked(games.nines.points).map((p) => (
              <div className="grow" key={p.id}><span className={p.id === me ? "me" : ""}>{p.name}</span><b>{fmtPts(games.nines.points[p.id])} pts</b></div>
            ))}
            <p className="ghint">5 / 3 / 1 points each hole for low / middle / high — ties split.</p>
          </div>
        ) : need("Nines", "exactly 3"))}
        {state.games?.sixes && (games.sixes ? (
          <div className="gcard">
            <h3>Sixes</h3>
            {ranked(games.sixes.points).map((p) => (
              <div className="grow" key={p.id}><span className={p.id === me ? "me" : ""}>{p.name}</span><b>{games.sixes.points[p.id]} pts</b></div>
            ))}
            <div className="gsegs">{games.sixes.segments.map((s: any, i: number) => (
              <div className="gseg" key={i}>
                <em>{s.label}</em>
                <span>{s.a.map(nameOf).join(" & ")} <i>vs</i> {s.b.map(nameOf).join(" & ")}</span>
                <b className="segstatus">{s.status}</b>
                {s.presses.map((pr: any, j: number) => (<span className="presrow" key={j}>Press from {pr.start}: {pr.status}</span>))}
              </div>
            ))}</div>
          </div>
        ) : need("Sixes", "exactly 4"))}
        {state.games?.vegas && (games.vegas ? (
          <div className="gcard">
            <h3>Vegas</h3>
            <div className="grow"><span>{games.vegas.teams[0].map(nameOf).join(" & ")}</span><b>{games.vegas.pts[0]}</b></div>
            <div className="grow"><span>{games.vegas.teams[1].map(nameOf).join(" & ")}</span><b>{games.vegas.pts[1]}</b></div>
            <p className="ghint">{vegasLead(games.vegas)}</p>
          </div>
        ) : need("Vegas", "exactly 4"))}
        {state.games?.nassau && (games.nassau ? (
          <div className="gcard">
            <h3>Nassau</h3>
            <p className="gteams">{games.nassau.teams[0].map(nameOf).join(" & ")} <i>vs</i> {games.nassau.teams[1].map(nameOf).join(" & ")}</p>
            {games.nassau.lines.map((l: any, i: number) => (<div className="grow" key={i}><span>{l.label}</span><b>{l.status}</b></div>))}
            {games.nassau.presses?.map((l: any, i: number) => (<div className="grow presrowline" key={`p${i}`}><span>{l.label}</span><b>{l.status}</b></div>))}
          </div>
        ) : need("Nassau", "exactly 4"))}
        {state.games?.bestball && (games.bestball ? (
          <div className="gcard">
            <h3>Best Ball</h3>
            <div className="grow"><span>{games.bestball.teams[0].map(nameOf).join(" & ")}</span><b>{fmtToPar(games.bestball.a.toPar)}</b></div>
            <div className="grow"><span>{games.bestball.teams[1].map(nameOf).join(" & ")}</span><b>{fmtToPar(games.bestball.b.toPar)}</b></div>
            <p className="ghint">{bestBallLead(games.bestball)}</p>
          </div>
        ) : need("Best Ball", "exactly 4"))}
        {state.games?.bbb && games.bbb && (
          <div className="gcard">
            <h3>Bingo Bango Bongo</h3>
            {ranked(games.bbb.points).map((p) => (
              <div className="grow" key={p.id}><span className={p.id === me ? "me" : ""}>{p.name}</span><b>{games.bbb.points[p.id]} pts</b></div>
            ))}
            <p className="ghint">3 points per hole — Bingo (first on green), Bango (closest once all are on), Bongo (first in the hole). Award them on the Scorecard tab.</p>
          </div>
        )}
      </div>
    );
  };

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
    if (view === "chicago") return { txt: `${r.chicago > 0 ? "+" : ""}${r.chicago}`, cls: "pts", unit: "pts" };
    return { txt: `${r.skins}`, cls: "pts", unit: "skins" };
  };

  // ---- full scorecard grid ----
  const front = course.filter((h) => h.num <= 9);
  const back = course.filter((h) => h.num > 9);
  const sp = (pid: string, n: number) => (state.scores[pid] || {})[n];
  const sumPar = (arr: typeof course) => arr.reduce((s, h) => s + h.par, 0);
  const sumYards = (arr: typeof course) => arr.reduce((s, h) => s + (h.yards || 0), 0);
  const sumSc = (pid: string, arr: typeof course) => arr.reduce((s, h) => s + (sp(pid, h.num) || 0), 0);

  const nineTable = (holes: typeof course, label: string) => (
    <table className="nine">
      <thead>
        <tr><th className="stik">Hole</th>{holes.map((h) => <th key={h.num}>{h.num}</th>)}<th className="tot">{label}</th></tr>
        <tr className="yardrow"><th className="stik">Yds</th>{holes.map((h) => <th key={h.num}>{h.yards || "–"}</th>)}<th className="tot">{sumYards(holes) || "–"}</th></tr>
        <tr className="parrow"><th className="stik">Par</th>{holes.map((h) => <th key={h.num}>{h.par}</th>)}<th className="tot">{sumPar(holes)}</th></tr>
        <tr className="sirow"><th className="stik">S.I.</th>{holes.map((h) => <th key={h.num}>{h.si || "–"}</th>)}<th className="tot" /></tr>
      </thead>
      <tbody>
        {state.players.map((p) => (
          <tr key={p.id} className={p.id === me ? "meRow" : ""}>
            <th className="stik">{p.name}</th>
            {holes.map((h) => {
              const v = sp(p.id, h.num);
              const pops = useHcp ? strokesOn(p.hcp, h.si) : 0;
              return (
                <td key={h.num} className={`popcell ${v != null ? toParClass(v - h.par) : ""}`}>
                  {pops > 0 && <span className="pops">{Array.from({ length: pops }).map((_, i) => <i key={i} />)}</span>}
                  {v ?? ""}
                </td>
              );
            })}
            <td className="tot">{sumSc(p.id, holes) || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const FullCard = () => (
    <div className="cardstack">
      {((state as any).teeName || sumYards(course) > 0) && (
        <div className="cardtee">{(state as any).teeName ? `${(state as any).teeName} tees` : "Scorecard"}{sumYards(course) > 0 ? ` · ${sumYards(course).toLocaleString()} yds · Par ${sumPar(course)}` : ""}</div>
      )}
      {nineTable(front, "Out")}
      {back.length > 0 && nineTable(back, "In")}
      <table className="nine totals">
        <thead><tr><th className="stik">Totals</th><th>Out</th>{back.length > 0 && <th>In</th>}<th className="tot">Gross</th></tr></thead>
        <tbody>
          {state.players.map((p) => (
            <tr key={p.id} className={p.id === me ? "meRow" : ""}>
              <th className="stik">{p.name}</th>
              <td>{sumSc(p.id, front) || "–"}</td>
              {back.length > 0 && <td>{sumSc(p.id, back) || "–"}</td>}
              <td className="tot grand">{sumSc(p.id, course) || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {useHcp && <p className="foot dotlegend"><span className="popdemo"><i /></span> a dot marks a hole where that player gets a handicap stroke</p>}
    </div>
  );

  const _np = (state.name || "Round").split(" — ");
  const roundTitle = _np.length === 2 && _np[0].trim() === _np[1].trim() ? _np[0].trim() : (state.name || "Round");

  return (
    <div className="gs">
      <div className="frame">
        <div className="topbar">
          <div className="mark"><LogoMark size={22} /><span>GREENSIDE</span></div>
          <div className={`live ${connected ? "on" : ""}`}><span className="dot" />{connected ? "LIVE" : "···"}</div>
        </div>

        {tab === "board" ? (
          <main className="body">
            <div className="seg wrap">
              {enabledFormats.map((f) => (
                <button key={f} className={`seg-btn ${view === f ? "on" : ""}`} onClick={() => setView(f)}>{FORMAT_LABELS[f]}</button>
              ))}
              {state.outing && <button className={`seg-btn ${view === "teams" ? "on" : ""}`} onClick={() => setView("teams")}>Teams</button>}
            </div>

            {view === "teams" ? <TeamsPanel /> : (
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
            <div className="seg wrap">
              <button className={`seg-btn ${scView === "hole" ? "on" : ""}`} onClick={() => setScView("hole")}>Hole</button>
              <button className={`seg-btn ${scView === "card" ? "on" : ""}`} onClick={() => setScView("card")}>Full Card</button>
              {enabledGames.length > 0 && <button className={`seg-btn ${scView === "games" ? "on" : ""}`} onClick={() => setScView("games")}>Games</button>}
            </div>
            {scView === "card" ? <FullCard /> : scView === "games" ? <GamesPanel /> : (
              <>
            <div className="holehead">
              <button className="nav" disabled={holeIdx === 0} onClick={() => setHoleIdx((i) => Math.max(0, i - 1))}><ChevronLeft size={20} /></button>
              <div className="holemid"><div className="hnum">Hole {hole.num}</div><div className="hmeta">Par {hole.par} · {hole.yards} yds · SI {hole.si}</div></div>
              <button className="nav" disabled={holeIdx === course.length - 1} onClick={() => setHoleIdx((i) => Math.min(course.length - 1, i + 1))}><ChevronRight size={20} /></button>
            </div>
            <div className="prog"><span style={{ width: `${((holeIdx + 1) / course.length) * 100}%` }} /></div>
            {state.outing && groups.length > 1 && (
              <div className="grpswitch">
                {groups.map((gname) => (
                  <button key={gname} className={effGrp === gname ? "on" : ""} onClick={() => setGrp(gname)}>Group {gname}</button>
                ))}
              </div>
            )}
            <div className="cards">
              {state.players.filter((p) => !state.outing || (p.group || "A") === effGrp).map((p) => {
                const rec = useHcp ? strokesOn(p.hcp, hole.si) : 0;
                const val = (state.scores[p.id] || {})[hole.num];
                const rel = val != null ? val - hole.par : null;
                const sc = state.scores[p.id] || {};
                const ppPlayed = course.filter((h) => sc[h.num] != null);
                const toPar = ppPlayed.reduce((s, h) => s + (sc[h.num] - h.par), 0);
                return (
                  <div key={p.id} className={`pcard ${p.id === me ? "self" : ""}`}>
                    <div className="pinfo"><div className="pn">{p.name}{p.id === me && <em>You</em>}
                      {ppPlayed.length > 0 && (
                        <span className={`tpar ${toParClass(toPar)}`}>
                          {toPar > 0 ? <ChevronUp size={13} strokeWidth={2.8} /> : toPar < 0 ? <ChevronDown size={13} strokeWidth={2.8} /> : null}
                          {fmtToPar(toPar)}
                        </span>
                      )}</div>
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
            {(state.games?.sixes || state.games?.nassau) && state.players.length === 4 && (() => {
              const blocks: any[] = [];
              const teamNames = (t: any[]) => t.map((p) => p.name).join("/");
              const statusOf = (a: any[], b: any[], lo: number, hi: number) => {
                const u = holesUp(state, a, b, lo, hi);
                return u === 0 ? "all square" : `${teamNames(u > 0 ? a : b)} ${Math.abs(u)} up`;
              };
              const render = (key: string, label: string, a: any[], b: any[], lo: number, hi: number, game: "sixes" | "nassau") => {
                const up = holesUp(state, a, b, lo, hi);
                const all = ((state.presses as any)?.[game] || []) as number[];
                const pressList = all.filter((h) => h >= lo && h <= hi).sort((x, y) => x - y)
                  .map((start) => ({ start, status: statusOf(a, b, start, hi) }));
                if (up === 0 && pressList.length === 0) return; // hide until a team is down
                const down = up > 0 ? b : up < 0 ? a : null;
                const iCanPress = !!me && !!down && down.some((p: any) => p.id === me) && hole.num < hi;
                const pressedHere = all.includes(hole.num);
                blocks.push(
                  <div className="pressbar" key={key}>
                    <div className="wolf-head">{label}: <b>{up === 0 ? "all square" : `${teamNames(up > 0 ? a : b)} ${Math.abs(up)} up`}</b></div>
                    {pressList.map((pr, i) => (<div className="presrow light" key={i}>Press from {pr.start}: {pr.status}</div>))}
                    {iCanPress && (
                      <button className={`pressbtn ${pressedHere ? "on" : ""}`} onClick={() => sendPress(game, hole.num)}>
                        {pressedHere ? `Pressed from ${hole.num} — tap to undo` : "Press — start a new bet from here"}
                      </button>
                    )}
                  </div>
                );
              };
              if (state.games?.sixes) {
                const seg = sixesSegs(state.players).find((s) => hole.num >= s.lo && hole.num <= s.hi);
                if (seg) render("sixes", `Sixes · ${seg.label}`, seg.a, seg.b, seg.lo, seg.hi, "sixes");
              }
              if (state.games?.nassau) {
                const t1 = [state.players[0], state.players[1]], t2 = [state.players[2], state.players[3]];
                const lo = hole.num <= 9 ? 1 : 10, hi = hole.num <= 9 ? 9 : 18, label = hole.num <= 9 ? "Front 9" : "Back 9";
                render("nassau", `Nassau · ${label}`, t1, t2, lo, hi, "nassau");
              }
              return blocks;
            })()}
            {state.games?.wolf && (state.players.length === 3 || state.players.length === 4) && (() => {
              const wolf = state.players[(hole.num - 1) % state.players.length];
              const others = state.players.filter((p) => p.id !== wolf.id);
              const pick = (state.wolf || {})[hole.num];
              return (
                <div className="wolfbar">
                  <div className="wolf-head">Wolf this hole: <b>{wolf.name}</b> — pick a partner or go lone</div>
                  <div className="wolf-picks">
                    {others.map((p) => (
                      <button key={p.id} className={pick === p.id ? "on" : ""} onClick={() => sendWolfPick(hole.num, pick === p.id ? null : p.id)}>{p.name}</button>
                    ))}
                    <button className={`lone ${pick === "lone" ? "on" : ""}`} onClick={() => sendWolfPick(hole.num, pick === "lone" ? null : "lone")}>Lone Wolf</button>
                  </div>
                </div>
              );
            })()}
            {state.games?.bbb && (() => {
              const cur = (state.bbb || {})[hole.num] || {};
              const rows: { key: "bingo" | "bango" | "bongo"; label: string; note: string }[] = [
                { key: "bingo", label: "Bingo", note: "first on green" },
                { key: "bango", label: "Bango", note: "closest once all on" },
                { key: "bongo", label: "Bongo", note: "first in the hole" },
              ];
              return (
                <div className="bbbbar">
                  <div className="wolf-head">Bingo Bango Bongo — tap who won each on hole {hole.num}</div>
                  {rows.map((r) => (
                    <div className="bbbrow" key={r.key}>
                      <div className="bbblabel">{r.label} <em>{r.note}</em></div>
                      <div className="wolf-picks">
                        {state.players.map((p) => (
                          <button key={p.id} className={cur[r.key] === p.id ? "on" : ""}
                            onClick={() => sendBbb(hole.num, r.key, cur[r.key] === p.id ? null : p.id)}>{p.name}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            <p className="foot">Tap the number to log par · everyone sees it immediately</p>
              </>
            )}
          </main>
        )}

        <nav className="tabs">
          <button onClick={() => setLeaving(true)}><Home size={17} /><span>Home</span></button>
          <button className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}><Trophy size={17} /><span>Leaderboard</span></button>
          <button className={tab === "score" ? "on" : ""} onClick={() => setTab("score")}><ClipboardList size={17} /><span>Scorecard</span></button>
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
            <h3>{roundTitle}</h3>
            <button className="codepill sheetcode" onClick={copyCode}>{copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Code {code}</>}</button>
            <p>Leaving keeps this round on your phone so you can jump back in. Ending it removes it from your Resume when you’re done for the day.</p>
            <button className="primary" onClick={() => { location.hash = ""; }}>Leave — keep it</button>
            <button className="dangerbtn" onClick={() => { localStorage.removeItem("gs:lastRound"); localStorage.removeItem("gs:lastRoundName"); location.hash = ""; }}>End round</button>
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
      <div className="topbar"><div className="mark"><LogoMark size={22} /><span>GREENSIDE</span></div></div>
      {children}
    </div></div>
  );
}
