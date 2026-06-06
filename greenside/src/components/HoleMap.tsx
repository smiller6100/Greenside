// Renders a vector hole diagram from OSM geometry (lat/lng) projected to SVG.
// `hole` shape comes from the worker /api/holemap response.
import { useState } from "react";

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

export default function HoleMap({ hole, me }: { hole: Hole; me?: { lat: number; lng: number; acc?: number } | null }) {
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
  const placed: { x: number; y: number }[] = [{ x: grX, y: grY - 10 }]; // reserve the green-distance spot
  const hazLabels: { x: number; y: number; text: number; kind: string }[] = [];
  hole.hazards
    .map((h) => ({ x: X(h.c[1]), y: Y(h.c[0]) + 3, text: yds(hav(teePoint, h.c)), kind: h.kind }))
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

  const svg = (
    <svg className="holemap" viewBox={`0 0 ${BOXW} ${BOXH}`} preserveAspectRatio="xMidYMid meet">
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
            onClick={selectable ? () => { const k = teeOpts.findIndex((o) => o.c[0] === ctr(t)[0] && o.c[1] === ctr(t)[1]); if (k >= 0) setSel(k); } : undefined}
            style={selectable ? { cursor: "pointer" } : undefined}
          />
        );
      })}

      <polyline className="hm-line" points={playLine.map(pt).join(" ")} />

      {/* tee marker */}
      <circle className="hm-tee" cx={teeX} cy={teeY} r={5} />

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
      {svg}
      {meInfo && (
        <div className="hm-range">
          <span className="hm-range-lbl">To green</span>
          <span className="hm-range-v"><b>{meInfo.front}</b><i>front</i></span>
          <span className="hm-range-v big"><b>{meInfo.center}</b><i>center</i></span>
          <span className="hm-range-v"><b>{meInfo.back}</b><i>back</i></span>
        </div>
      )}
    </>
  );
}
