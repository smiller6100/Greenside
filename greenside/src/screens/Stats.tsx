import { useMemo } from "react";
import { ChevronLeft, BarChart3 } from "lucide-react";

// Your performance across every round saved on this device — no account needed. Aggregates the
// same round history the "My rounds" list shows, keyed to whoever you were in each round (snap.me).

type RM = {
  date: number; name: string; code: string; courseName: string;
  hp: number; gross: number; par: number; toPar: number; toPar18: number;
  fwHit: number; fwAtt: number; girC: number; girElig: number; putts: number; puttsN: number;
  byPar: Record<number, { d: number; n: number }>; ended: boolean;
};

function roundMetrics(r: any): RM | null {
  const course = r.course || []; const sc = (r.scores || {})[r.me] || {}; const st = (r.stats || {})[r.me] || {};
  let gross = 0, par = 0, hp = 0, fwHit = 0, fwAtt = 0, girC = 0, girElig = 0, putts = 0, puttsN = 0;
  const byPar: Record<number, { d: number; n: number }> = { 3: { d: 0, n: 0 }, 4: { d: 0, n: 0 }, 5: { d: 0, n: 0 } };
  for (const h of course) {
    const s = sc[h.num]; const cl = st[h.num] || {};
    if (s != null) { gross += s; par += h.par; hp++; const b = byPar[h.par]; if (b) { b.d += s - h.par; b.n++; } }
    if (h.par >= 4 && (cl.fir === true || cl.fir === false)) { fwAtt++; if (cl.fir === true) fwHit++; }
    if (s != null && cl.putts != null) { girElig++; if (s - cl.putts <= h.par - 2) girC++; }
    if (cl.putts != null) { putts += cl.putts; puttsN++; }
  }
  if (hp === 0) return null;
  const norm = 18 / hp;
  return { date: r.endedAt || r.savedAt, name: r.name || r.code, code: r.code, courseName: r.courseName || "",
    hp, gross, par, toPar: gross - par, toPar18: (gross - par) * norm, fwHit, fwAtt, girC, girElig, putts, puttsN, byPar, ended: !!r.endedAt };
}

const fmtPar = (n: number) => (n > 0 ? `+${Math.round(n)}` : n < 0 ? `${Math.round(n)}` : "E");
const fmtParF = (n: number) => (n > 0 ? `+${n.toFixed(1)}` : n < 0 ? n.toFixed(1) : "E");

export default function Stats() {
  const rms = useMemo(() => {
    let raw: any[] = [];
    try { raw = JSON.parse(localStorage.getItem("gs:rounds") || "[]"); } catch { raw = []; }
    return raw.map(roundMetrics).filter(Boolean) as RM[];
  }, []);

  const goHome = () => { location.hash = ""; };

  const N = rms.length;
  const agg = useMemo(() => {
    if (!N) return null;
    const sum = (f: (r: RM) => number) => rms.reduce((t, r) => t + f(r), 0);
    const fwHit = sum((r) => r.fwHit), fwAtt = sum((r) => r.fwAtt);
    const girC = sum((r) => r.girC), girElig = sum((r) => r.girElig);
    const putts = sum((r) => r.putts), puttsN = sum((r) => r.puttsN);
    const avgToPar = sum((r) => r.toPar18) / N;
    const best = rms.reduce((b, r) => (r.toPar18 < b.toPar18 ? r : b), rms[0]);
    const byPar: Record<number, { d: number; n: number }> = { 3: { d: 0, n: 0 }, 4: { d: 0, n: 0 }, 5: { d: 0, n: 0 } };
    for (const r of rms) for (const p of [3, 4, 5]) { byPar[p].d += r.byPar[p].d; byPar[p].n += r.byPar[p].n; }
    const puttsPerHole = puttsN ? putts / puttsN : 0;
    return { fwHit, fwAtt, girC, girElig, puttsN, avgToPar, best, byPar, puttsPerHole, puttsPerRound: puttsPerHole * 18 };
  }, [rms, N]);

  const hasStats = !!agg && (agg.fwAtt > 0 || agg.girElig > 0 || agg.puttsN > 0);

  // Trend: oldest→newest, last 12 rounds, normalized to par per 18.
  const trend = useMemo(() => [...rms].sort((a, b) => a.date - b.date).slice(-12), [rms]);

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button>
        <h2>My stats</h2><span />
      </header>

      <div className="panel">
        {!agg ? (
          <div className="st-empty">
            <BarChart3 size={30} />
            <p>Play a round and your stats show up here — scoring, fairways, greens and putts, all from the rounds saved on this device.</p>
          </div>
        ) : (
          <>
            <div className="st-tiles">
              <div className="st-tile"><b>{N}</b><span>rounds</span></div>
              <div className="st-tile"><b className={agg.avgToPar > 0 ? "over" : "under"}>{fmtParF(agg.avgToPar)}</b><span>avg vs par</span></div>
              <div className="st-tile"><b className={agg.best.toPar18 > 0 ? "over" : "under"}>{fmtPar(agg.best.toPar18)}</b><span>best round</span></div>
              <div className="st-tile"><b>{hasStats && agg.puttsN ? Math.round(agg.puttsPerRound) : "–"}</b><span>putts / round</span></div>
            </div>

            {hasStats ? (
              <div className="st-section">
                <div className="st-h">Tee to green</div>
                <div className="st-bars">
                  <div className="st-bar">
                    <div className="st-bar-top"><span>Fairways hit</span><b>{agg.fwAtt ? `${Math.round((agg.fwHit / agg.fwAtt) * 100)}%` : "–"}</b></div>
                    <div className="st-track"><span style={{ width: `${agg.fwAtt ? (agg.fwHit / agg.fwAtt) * 100 : 0}%` }} /></div>
                    <div className="st-bar-sub">{agg.fwHit} of {agg.fwAtt}</div>
                  </div>
                  <div className="st-bar">
                    <div className="st-bar-top"><span>Greens in regulation</span><b>{agg.girElig ? `${Math.round((agg.girC / agg.girElig) * 100)}%` : "–"}</b></div>
                    <div className="st-track"><span style={{ width: `${agg.girElig ? (agg.girC / agg.girElig) * 100 : 0}%` }} /></div>
                    <div className="st-bar-sub">{agg.girC} of {agg.girElig}</div>
                  </div>
                  <div className="st-bar">
                    <div className="st-bar-top"><span>Putts per hole</span><b>{agg.puttsN ? agg.puttsPerHole.toFixed(2) : "–"}</b></div>
                    <div className="st-track"><span style={{ width: `${agg.puttsN ? Math.min(100, (agg.puttsPerHole / 3) * 100) : 0}%` }} /></div>
                    <div className="st-bar-sub">over {agg.puttsN} hole{agg.puttsN === 1 ? "" : "s"} tracked</div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="hint" style={{ textAlign: "center", marginTop: 4 }}>Turn on <b>fairways &amp; putts</b> on the scorecard during a round to unlock tee-to-green stats.</p>
            )}

            <div className="st-section">
              <div className="st-h">Scoring by par</div>
              <div className="st-pars">
                {[3, 4, 5].map((p) => {
                  const b = agg.byPar[p]; const avg = b.n ? b.d / b.n : null;
                  return (
                    <div className="st-par" key={p}>
                      <div className="st-par-n">Par {p}</div>
                      <div className={`st-par-v ${avg != null && avg > 0 ? "over" : avg != null && avg < 0 ? "under" : ""}`}>{avg != null ? fmtParF(avg) : "–"}</div>
                      <div className="st-par-sub">{b.n ? `${b.n} played` : "none yet"}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {trend.length >= 2 && (
              <div className="st-section">
                <div className="st-h">Recent rounds <span className="st-h-sub">vs par, per 18</span></div>
                <Spark rounds={trend} />
              </div>
            )}

            <p className="hint" style={{ textAlign: "center" }}>Saved on this device — scoring normalizes 9-hole rounds to 18 so they compare fairly.</p>
          </>
        )}
      </div>
    </div></div>
  );
}

function Spark({ rounds }: { rounds: RM[] }) {
  const W = 320, H = 96, PAD = 14;
  const vals = rounds.map((r) => r.toPar18);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const span = Math.max(hi - lo, 1);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, rounds.length - 1);
  const y = (v: number) => PAD + ((hi - v) / span) * (H - 2 * PAD);
  const zeroY = y(0);
  const pts = rounds.map((r, i) => `${x(i).toFixed(1)},${y(r.toPar18).toFixed(1)}`).join(" ");
  return (
    <svg className="st-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Recent rounds vs par">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} className="st-spark-zero" />
      <polyline className="st-spark-line" points={pts} />
      {rounds.map((r, i) => (
        <circle key={i} cx={x(i)} cy={y(r.toPar18)} r="3.5" className={`st-spark-dot ${r.toPar18 > 0 ? "over" : "under"}`} />
      ))}
    </svg>
  );
}
