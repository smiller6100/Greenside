// Renders a vector hole diagram from OSM geometry (lat/lng) projected to SVG.
// `hole` shape comes from the worker /api/holemap response.

type Hole = {
  ref: number | null;
  par: number | null;
  line: number[][];
  tee: number[];
  green: number[][] | null;
  greenC: number[];
  fairway: number[][] | null;
  hazards: { kind: string; poly: number[][]; c: number[]; yards: number }[];
  teeToGreenYds: number;
};

const BOXW = 300, BOXH = 380, PAD = 18;

export default function HoleMap({ hole }: { hole: Hole }) {
  // Gather every coordinate so the whole hole fits the frame.
  const all: number[][] = [...hole.line];
  if (hole.green) all.push(...hole.green);
  if (hole.fairway) all.push(...hole.fairway);
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

  return (
    <svg className="holemap" viewBox={`0 0 ${BOXW} ${BOXH}`} preserveAspectRatio="xMidYMid meet">
      {hole.fairway && <polygon className="hm-fairway" points={poly(hole.fairway)} />}
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
      {/* tee->green distance near the green */}
      <text className="hm-dist" x={grX} y={grY - 10} textAnchor="middle">{hole.teeToGreenYds} yd</text>

      {/* hazard carry distances */}
      {hole.hazards.map((h, i) => (
        <text key={"hl" + i} className={"hm-hlabel " + (h.kind === "water" ? "hm-hlabel-w" : "hm-hlabel-b")}
          x={X(h.c[1])} y={Y(h.c[0]) + 3} textAnchor="middle">{h.yards}</text>
      ))}
    </svg>
  );
}
