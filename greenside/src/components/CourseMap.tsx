// A course-overview map for the clubhouse board: faint green markers as the basemap, a colored
// dot per group at its latest GPS fix. Equirectangular projection (north-up), same math as HoleMap.
// Pure presentational — the board computes group positions and passes them in.

export type Green = { num: number; lat: number; lng: number };
export type GroupDot = {
  key: string;
  label: string;   // short tag drawn on the dot (e.g. "A" or "3")
  lat: number;
  lng: number;
  hole?: number;   // current hole, shown under the label
  color: string;
  fresh: boolean;  // dim the dot when the fix is stale
};

const BOXW = 340, BOXH = 360, PAD = 22;

export default function CourseMap({ greens, groups }: { greens: Green[]; groups: GroupDot[] }) {
  const pts: { lat: number; lng: number }[] = [...greens, ...groups];
  if (pts.length < 2) return null;

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  let latMin = Math.min(...lats), latMax = Math.max(...lats);
  let lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);
  // Guard against a zero span (e.g. a single cluster) so the projection stays finite.
  if (latMax - latMin < 1e-5) { latMin -= 5e-4; latMax += 5e-4; }
  if (lngMax - lngMin < 1e-5) { lngMin -= 5e-4; lngMax += 5e-4; }
  const latC = (latMin + latMax) / 2;

  const mx = (lng: number) => (lng - lngMin) * 111320 * Math.cos((latC * Math.PI) / 180);
  const my = (lat: number) => (lat - latMin) * 110540;
  const spanX = Math.max(mx(lngMax), 1);
  const spanY = Math.max(my(latMax), 1);
  const scale = Math.min((BOXW - 2 * PAD) / spanX, (BOXH - 2 * PAD) / spanY);
  // Center the drawing in the box; flip Y so north is up.
  const offX = (BOXW - spanX * scale) / 2;
  const offY = (BOXH - spanY * scale) / 2;
  const X = (lng: number) => offX + mx(lng) * scale;
  const Y = (lat: number) => BOXH - (offY + my(lat) * scale);

  return (
    <svg className="coursemap" viewBox={`0 0 ${BOXW} ${BOXH}`} role="img" aria-label="Course map with live group positions">
      <rect x="0" y="0" width={BOXW} height={BOXH} rx="14" className="cm-bg" />
      {greens.map((g) => (
        <g key={`gr${g.num}`}>
          <circle cx={X(g.lng)} cy={Y(g.lat)} r="8" className="cm-green" />
          <text x={X(g.lng)} y={Y(g.lat) + 3} className="cm-greenlab">{g.num}</text>
        </g>
      ))}
      {groups.map((d) => {
        const x = X(d.lng), y = Y(d.lat);
        return (
          <g key={d.key} opacity={d.fresh ? 1 : 0.4}>
            <circle cx={x} cy={y} r="13" fill={d.color} className="cm-dot" />
            <text x={x} y={y + 4} className="cm-dotlab">{d.label}</text>
            {d.hole ? <text x={x} y={y + 26} className="cm-dothole">{`H${d.hole}`}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}
