// Renders a vector hole diagram from OSM geometry (lat/lng) projected to SVG.
// `hole` shape comes from the worker /api/holemap response.
import { useState, useEffect } from "react";

const ctr = (ring: number[][]) => {
  let la = 0, ln = 0; for (const p of ring) { la += p[0]; ln += p[1]; }
  return [la / ring.length, ln / ring.length];
};
const hav = (a: number[], b: number[]) => {
  const R = 6371000, d = Math.PI / 180;
  const dLa = (b[0] - a[0]) * d, dLn = (b[1] - a[1]) * d;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * d) * Math.cos(b[0] * d) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const yds = (m: number) => Math.round(m * 1.09361);
// Compass bearing (deg, 0=N clockwise) from point a to point b.
const bearing = (a: number[], b: number[]) => {
  const d = Math.PI / 180, toDeg = (r: number) => (r * 180) / Math.PI;
  const dLon = (b[1] - a[1]) * d;
  const y = Math.sin(dLon) * Math.cos(b[0] * d);
  const x = Math.cos(a[0] * d) * Math.sin(b[0] * d) - Math.sin(a[0] * d) * Math.cos(b[0] * d) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

type Hole = {
  ref: number | null;
  par: number | null;
  line: number[][];
  tee: number[];
  green: number[][] | null;
  greenC: number[];
  fairways?: number[][][];
  rough?: number[][][];
  tees?: number[][][];
  hazards: { kind: string; poly: number[][]; c: number[]; yards: number }[];
  teeToGreenYds: number;
};

const BOXW = 300, BOXH = 380, PAD = 8;

export default function HoleMap({ hole, me, others, weather }: { hole: Hole; me?: { lat: number; lng: number; acc?: number } | null; others?: { lat: number; lng: number; name: string; color: string }[]; weather?: { tempF: number; windMph: number; windDir: number; gustMph?: number } | null }) {
  const fairways = hole.fairways || [];
  const rough = hole.rough || [];
  const tees = hole.tees || [];
  // One selectable option per tee box (labelled by its straight-line yardage to the green).
  // Sorted long -> short; default to the box nearest the back tee so it matches the card.
  const teeOpts = tees
    .map((poly) => { const c = ctr(poly); return { c, yds: yds(hav(c, hole.greenC)) }; })
    .sort((a, b) => b.yds - a.yds);
  const selectable = teeOpts.length >= 2;
  let defIdx = 0;
  if (selectable) { let bd = 1e12; teeOpts.forEach((o, i) => { const d = hav(o.c, hole.tee); if (d < bd) { bd = d; defIdx = i; } }); }
  const [sel, setSel] = useState(defIdx);
  const [target, setTarget] = useState<{ lat: number; lng: number } | null>(null); // tap-to-measure point
  useEffect(() => { setTarget(null); }, [hole]); // clear the measure when the hole changes
  const cur = selectable ? teeOpts[Math.min(sel, teeOpts.length - 1)] : null;
  const teePoint = cur ? cur.c : hole.tee;
  const playLine = cur ? [teePoint, ...hole.line.slice(1)] : hole.line;

  // Gather coords for the frame fit. Rough is excluded — it can span the whole course and
  // would shrink the hole to a dot; we still draw it (clipped to the frame) as a backdrop.
  const all: number[][] = [...hole.line];
  if (hole.green) all.push(...hole.green);
  fairways.forEach((f) => all.push(...f));
  tees.forEach((t) => all.push(...t));
  hole.hazards.forEach((h) => all.push(...h.poly));
  if (all.length < 2) return null;

  const lats = all.map((p) => p[0]);
  const lngs = all.map((p) => p[1]);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);
  const latC = (latMin + latMax) / 2;

  // Equirectangular meters relative to the SW corner (keeps shapes proportional).
  const mx = (lng: number) => (lng - lngMin) * 111320 * Math.cos((latC * Math.PI) / 180);
  const my = (lat: number) => (lat - latMin) * 110540;
  const spanX = Math.max(mx(lngMax), 1);
  const spanY = Math.max(my(latMax), 1);
  const scale = Math.min((BOXW - 2 * PAD) / spanX, (BOXH - 2 * PAD) / spanY);
  const offX = (BOXW - spanX * scale) / 2;
  const offY = (BOXH - spanY * scale) / 2;

  // Project [lat,lng] -> screen. Flip Y so north points up.
  const X = (lng: number) => offX + mx(lng) * scale;
  const Y = (lat: number) => BOXH - offY - my(lat) * scale;
  const pt = (p: number[]) => `${X(p[1]).toFixed(1)},${Y(p[0]).toFixed(1)}`;
  const poly = (ring: number[][]) => ring.map(pt).join(" ");

  const teeX = X(teePoint[1]), teeY = Y(teePoint[0]);
  const grX = X(hole.greenC[1]), grY = Y(hole.greenC[0]);

  // Place hazard carry labels, dropping any that would collide with one already placed
  // (bunkers cluster near the green, so their numbers overlap badly without this).
  // Rangefinder distances read from where you're standing (GPS) if we have it, else from the tee.
  const refPt = me && isFinite(me.lat) && isFinite(me.lng) ? [me.lat, me.lng] : teePoint;
  const placed: { x: number; y: number }[] = [{ x: grX, y: grY - 10 }]; // reserve the green-distance spot
  const hazLabels: { x: number; y: number; text: number; kind: string }[] = [];
  hole.hazards
    .map((h) => ({ x: X(h.c[1]), y: Y(h.c[0]) + 3, text: yds(hav(refPt, h.c)), kind: h.kind }))
    .sort((a, b) => a.text - b.text)
    .forEach((L) => {
      if (placed.some((p) => Math.abs(p.x - L.x) < 22 && Math.abs(p.y - L.y) < 12)) return;
      placed.push({ x: L.x, y: L.y });
      hazLabels.push(L);
    });

  let meInfo: { x: number; y: number; center: number; front: number; back: number } | null = null;
  if (me && isFinite(me.lat) && isFinite(me.lng)) {
    const p = [me.lat, me.lng];
    const center = yds(hav(p, hole.greenC));
    let front = center, back = center;
    if (hole.green && hole.green.length) {
      const ds = hole.green.map((g) => hav(p, g));
      front = yds(Math.min(...ds)); back = yds(Math.max(...ds));
    }
    meInfo = { x: X(me.lng), y: Y(me.lat), center, front, back };
  }

  const others2 = (others || []).filter((o) => o && isFinite(o.lat) && isFinite(o.lng)).map((o) => ({
    x: X(o.lng), y: Y(o.lat), name: o.name, color: o.color, yds: yds(hav([o.lat, o.lng], hole.greenC)),
  }));

  // Tap-to-measure: back-project a screen tap to lat/lng, then show carry/layup distances.
  const onMapClick = (e: any) => {
    const svgEl = e.currentTarget; const ctm = svgEl.getScreenCTM(); if (!ctm) return;
    const sp = svgEl.createSVGPoint(); sp.x = e.clientX; sp.y = e.clientY;
    const loc = sp.matrixTransform(ctm.inverse());
    const lng = lngMin + (loc.x - offX) / scale / (111320 * Math.cos((latC * Math.PI) / 180));
    const lat = latMin + (BOXH - offY - loc.y) / scale / 110540;
    if (isFinite(lat) && isFinite(lng)) setTarget({ lat, lng });
  };
  let measure: { x: number; y: number; ox: number; oy: number; toT: number; toGreen: number } | null = null;
  if (target) {
    measure = {
      x: X(target.lng), y: Y(target.lat), ox: X(refPt[1]), oy: Y(refPt[0]),
      toT: yds(hav(refPt, [target.lat, target.lng])), toGreen: yds(hav([target.lat, target.lng], hole.greenC)),
    };
  }

  // "Plays like": adjust the center-green yardage for head/tail wind (dominant) and temperature.
  // Only meaningful when we have your GPS position and current weather.
  let playsLike: number | null = null;
  if (meInfo && weather && weather.windMph != null) {
    const heading = bearing(refPt, hole.greenC);
    const windTo = (weather.windDir + 180) % 360; // direction the wind is blowing toward
    const tail = weather.windMph * Math.cos(((windTo - heading) * Math.PI) / 180); // +tailwind / −headwind
    const head = -tail;
    const windYds = head > 0 ? meInfo.center * head * 0.01 : meInfo.center * head * 0.005;
    const tempYds = meInfo.center * (70 - weather.tempF) * 0.0003; // cold air plays longer
    playsLike = Math.round(meInfo.center + windYds + tempYds);
  }

  const svg = (
    <svg className="holemap" viewBox={`0 0 ${BOXW} ${BOXH}`} preserveAspectRatio="xMidYMid meet" onClick={onMapClick} style={{ cursor: "crosshair" }}>
      {rough.map((r, i) => (
        <polygon key={"r" + i} className="hm-rough" points={poly(r)} />
      ))}
      {fairways.map((f, i) => (
        <polygon key={"f" + i} className="hm-fairway" points={poly(f)} />
      ))}
      {hole.hazards.filter((h) => h.kind === "water").map((h, i) => (
        <polygon key={"w" + i} className="hm-water" points={poly(h.poly)} />
      ))}
      {hole.hazards.filter((h) => h.kind === "bunker").map((h, i) => (
        <polygon key={"b" + i} className="hm-bunker" points={poly(h.poly)} />
      ))}
      {hole.green && <polygon className="hm-green" points={poly(hole.green)} />}
      {tees.map((t, i) => {
        const isSel = selectable && cur != null && ctr(t)[0] === cur.c[0] && ctr(t)[1] === cur.c[1];
        return (
          <polygon
            key={"t" + i}
            className={"hm-teebox" + (isSel ? " hm-teebox-sel" : "")}
            points={poly(t)}
            onClick={selectable ? (e) => { e.stopPropagation(); const k = teeOpts.findIndex((o) => o.c[0] === ctr(t)[0] && o.c[1] === ctr(t)[1]); if (k >= 0) setSel(k); } : undefined}
            style={selectable ? { cursor: "pointer" } : undefined}
          />
        );
      })}

      <polyline className="hm-line" points={playLine.map(pt).join(" ")} />

      {/* tee marker */}
      <circle className="hm-tee" cx={teeX} cy={teeY} r={5} />

      {others2.map((o, i) => (
        <g key={"o" + i}>
          <circle className="hm-them" cx={o.x} cy={o.y} r={5} style={{ fill: o.color }} />
          <text className="hm-themlabel" x={o.x} y={o.y - 8} textAnchor="middle">{o.name} {o.yds}</text>
        </g>
      ))}

      {meInfo && (
        <>
          <line className="hm-meline" x1={meInfo.x} y1={meInfo.y} x2={grX} y2={grY} />
          <circle className="hm-me-acc" cx={meInfo.x} cy={meInfo.y} r={11} />
          <circle className="hm-me" cx={meInfo.x} cy={meInfo.y} r={5.5} />
          <text className="hm-melabel" x={meInfo.x} y={meInfo.y - 10} textAnchor="middle">{meInfo.center}</text>
        </>
      )}

      {/* hazard carry distances (decluttered) */}
      {hazLabels.map((L, i) => (
        <text key={"hl" + i} className={"hm-hlabel " + (L.kind === "water" ? "hm-hlabel-w" : "hm-hlabel-b")}
          x={L.x} y={L.y} textAnchor="middle">{L.text}</text>
      ))}

      {/* tap-to-measure: line from your spot (or the tee) to the tapped point */}
      {measure && (
        <g className="hm-measure">
          <line className="hm-mline" x1={measure.ox} y1={measure.oy} x2={measure.x} y2={measure.y} />
          <circle className="hm-mtarget-o" cx={measure.x} cy={measure.y} r={8} />
          <circle className="hm-mtarget" cx={measure.x} cy={measure.y} r={4} />
          <text className="hm-mlabel" x={measure.x} y={measure.y - 11} textAnchor="middle">{measure.toT}</text>
        </g>
      )}
    </svg>
  );

  return (
    <>
      {selectable && (
        <div className="hm-tees">
          <span className="hm-tees-lbl">Tee</span>
          {teeOpts.map((o, i) => (
            <button key={i} className={"hm-tee-chip" + (i === Math.min(sel, teeOpts.length - 1) ? " on" : "")} onClick={() => setSel(i)}>{o.yds}</button>
          ))}
        </div>
      )}
      {weather && weather.windMph != null && (
        <div className="hm-wx">
          <span className="hm-wx-t">{weather.tempF}°F</span>
          <span className="hm-wx-wind">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" style={{ transform: `rotate(${(weather.windDir + 180) % 360}deg)` }}><path d="M12 3 L12 21 M12 3 L7.5 9 M12 3 L16.5 9" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {weather.windMph} mph{weather.gustMph && weather.gustMph > weather.windMph + 4 ? ` · g${weather.gustMph}` : ""}
          </span>
        </div>
      )}
      {svg}
      {meInfo && (
        <div className="hm-range">
          <span className="hm-range-lbl">To green</span>
          <span className="hm-range-v"><b>{meInfo.front}</b><i>front</i></span>
          <span className="hm-range-v big"><b>{meInfo.center}</b><i>center</i></span>
          <span className="hm-range-v"><b>{meInfo.back}</b><i>back</i></span>
          {playsLike != null && <span className="hm-range-v plays"><b>{playsLike}</b><i>plays like</i></span>}
        </div>
      )}
      {measure ? (
        <div className="hm-measure-bar">
          <span className="hm-mb-v"><b>{measure.toT}</b><i>{me && isFinite(me.lat) ? "to point" : "tee→point"}</i></span>
          <span className="hm-mb-sep" />
          <span className="hm-mb-v"><b>{measure.toGreen}</b><i>point→green</i></span>
          <button className="hm-mb-clear" onClick={() => setTarget(null)}>Clear</button>
        </div>
      ) : (
        <div className="hm-tip">Tap the hole to measure a carry or layup{me && isFinite(me.lat) ? "" : " from the tee"}</div>
      )}
    </>
  );
}
