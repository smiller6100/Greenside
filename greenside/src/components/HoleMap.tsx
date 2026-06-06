// Renders a vector hole diagram from OSM geometry (lat/lng) projected to SVG.
// `hole` shape comes from the worker /api/holemap response.

type Hole = {
  ref: number | null;
  par: number | null;
  line: number[][];
  tee: number[];
  green: number[][] | null;
  greenC: number[];
  fairways: number[][][];
  hazards: { kind: string; poly: number[][]; c: number[]; yards: number }[];
  teeToGreenYds: number;
};

const BOXW = 300, BOXH = 380, PAD = 18;

export default function HoleMap({ hole }: { hole: Hole }) {
  // Gather every coordinate so the whole hole fits the frame.
  const all: number[][] = [...hole.line];
  if (hole.green) all.push(...hole.green);
  hole.fairways.forEach((f) => all.push(...f));
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

  const teeX = X(hole.tee[1]), teeY = Y(hole.tee[0]);
  const grX = X(hole.greenC[1]), grY = Y(hole.greenC[0]);

  // Place hazard carry labels, dropping any that would collide with one already placed
  // (bunkers cluster near the green, so their numbers overlap badly without this).
  const placed: { x: number; y: number }[] = [{ x: grX, y: grY - 10 }]; // reserve the green-distance spot
  const hazLabels: { x: number; y: number; text: number; kind: string }[] = [];
  hole.hazards
    .map((h) => ({ x: X(h.c[1]), y: Y(h.c[0]) + 3, text: h.yards, kind: h.kind }))
    .sort((a, b) => a.text - b.text)
    .forEach((L) => {
      if (placed.some((p) => Math.abs(p.x - L.x) < 22 && Math.abs(p.y - L.y) < 12)) return;
      placed.push({ x: L.x, y: L.y });
      hazLabels.push(L);
    });
  // Tee->green distance sits mid-line (open ground) instead of on top of the green/bunkers.
  const midX = (teeX + grX) / 2, midY = (teeY + grY) / 2;

  return (
    <svg className="holemap" viewBox={`0 0 ${BOXW} ${BOXH}`} preserveAspectRatio="xMidYMid meet">
      {hole.fairways.map((f, i) => (
        <polygon key={"f" + i} className="hm-fairway" points={poly(f)} />
      ))}
      {hole.hazards.filter((h) => h.kind === "water").map((h, i) => (
        <polygon key={"w" + i} className="hm-water" points={poly(h.poly)} />
      ))}
      {hole.hazards.filter((h) => h.kind === "bunker").map((h, i) => (
        <polygon key={"b" + i} className="hm-bunker" points={poly(h.poly)} />
      ))}
      {hole.green && <polygon className="hm-green" points={poly(hole.green)} />}

      <polyline className="hm-line" points={hole.line.map(pt).join(" ")} />

      {/* tee marker */}
      <circle className="hm-tee" cx={teeX} cy={teeY} r={5} />

      {/* hazard carry distances (decluttered) */}
      {hazLabels.map((L, i) => (
        <text key={"hl" + i} className={"hm-hlabel " + (L.kind === "water" ? "hm-hlabel-w" : "hm-hlabel-b")}
          x={L.x} y={L.y} textAnchor="middle">{L.text}</text>
      ))}

      {/* tee->green distance, mid-line in open space, drawn last so it stays on top */}
      <text className="hm-dist" x={midX} y={midY - 6} textAnchor="middle">{hole.teeToGreenYds} yd</text>
    </svg>
  );
}
