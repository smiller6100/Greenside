// ---- Types ----
export interface Hole { num: number; par: number; yards: number; si: number }
export interface Player { id: string; name: string; hcp: number; group?: string }
export interface Formats { net: boolean; gross: boolean; stableford: boolean; skins: boolean }
export interface Games { sixes: boolean; wolf: boolean; vegas: boolean; nassau: boolean }
export type HcpMode = "perHole" | "course" | "gross";

export interface RoundState {
  code: string;
  name: string;
  formats: Formats;
  games?: Games;
  outing?: boolean;
  groupCount?: number;
  handicapMode: HcpMode;
  players: Player[];
  course: Hole[];
  scores: Record<string, Record<string, number>>; // playerId -> holeNum -> strokes
  wolf?: Record<string, string>;                   // holeNum -> partnerId | "lone"
  createdAt: number;
  lat?: number | null;
  lng?: number | null;
}

export interface Standing {
  id: string;
  name: string;
  hcp: number;
  thru: number;
  gross: number;
  net: number;
  toParGross: number;
  toParNet: number;
  points: number;
  skins: number;
}

// ---- Default course (par 72) ----
export const DEFAULT_COURSE: Hole[] = [
  { num: 1, par: 4, yards: 380, si: 5 },
  { num: 2, par: 5, yards: 540, si: 1 },
  { num: 3, par: 4, yards: 415, si: 11 },
  { num: 4, par: 3, yards: 175, si: 17 },
  { num: 5, par: 4, yards: 405, si: 7 },
  { num: 6, par: 4, yards: 360, si: 13 },
  { num: 7, par: 5, yards: 525, si: 3 },
  { num: 8, par: 3, yards: 195, si: 15 },
  { num: 9, par: 4, yards: 430, si: 9 },
  { num: 10, par: 4, yards: 400, si: 6 },
  { num: 11, par: 4, yards: 350, si: 12 },
  { num: 12, par: 3, yards: 165, si: 18 },
  { num: 13, par: 5, yards: 555, si: 2 },
  { num: 14, par: 4, yards: 420, si: 8 },
  { num: 15, par: 4, yards: 390, si: 14 },
  { num: 16, par: 4, yards: 370, si: 10 },
  { num: 17, par: 3, yards: 185, si: 16 },
  { num: 18, par: 5, yards: 535, si: 4 },
];

// strokes a player receives on a hole given course handicap + stroke index
export const strokesOn = (hcp: number, si: number) =>
  Math.floor(hcp / 18) + (si <= hcp % 18 ? 1 : 0);

export const fmtToPar = (n: number) => (n === 0 ? "E" : n > 0 ? `+${n}` : `${n}`);
export const toParClass = (n: number) => (n < 0 ? "under" : n > 0 ? "over" : "even");

// Free satellite aerial of a coordinate via Esri World Imagery (no API key).
export function aerialUrl(lat: number, lng: number, w = 760, h = 360): string {
  const dLat = 0.011;
  const dLng = (dLat * (w / h)) / Math.cos((lat * Math.PI) / 180);
  const bbox = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=jpg&f=image`;
}

export function computeStandings(state: RoundState, format: string): Standing[] {
  const useHcp = state.handicapMode !== "gross";
  const course = state.course;

  const rows: Standing[] = state.players.map((p) => {
    const sc = state.scores[p.id] || {};
    const played = course.filter((h) => sc[h.num] != null);
    let gross = 0, net = 0, par = 0, points = 0;
    played.forEach((h) => {
      const g = sc[h.num];
      const rec = useHcp ? strokesOn(p.hcp, h.si) : 0;
      gross += g; par += h.par; net += g - rec;
      points += Math.max(0, 2 - (g - rec - h.par));
    });
    return {
      id: p.id, name: p.name, hcp: p.hcp, thru: played.length,
      gross, net, toParGross: gross - par, toParNet: net - par, points, skins: 0,
    };
  });

  // skins (net, no-carry simplification): unique lowest net wins the hole
  course.forEach((h) => {
    const entries = state.players
      .filter((p) => (state.scores[p.id] || {})[h.num] != null)
      .map((p) => ({
        id: p.id,
        net: (state.scores[p.id] || {})[h.num] - (useHcp ? strokesOn(p.hcp, h.si) : 0),
      }));
    if (entries.length !== state.players.length || entries.length === 0) return;
    const min = Math.min(...entries.map((e) => e.net));
    const low = entries.filter((e) => e.net === min);
    if (low.length === 1) {
      const r = rows.find((x) => x.id === low[0].id);
      if (r) r.skins += 1;
    }
  });

  const key = ({ net: "toParNet", gross: "toParGross", stableford: "points", skins: "skins" } as const)[
    format as "net" | "gross" | "stableford" | "skins"
  ] || "toParNet";
  const asc = format === "net" || format === "gross";
  return [...rows].sort((a: any, b: any) => (asc ? a[key] - b[key] : b[key] - a[key]));
}

// ---- In-round games ----
function rawNet(state: RoundState, player: Player, h: Hole): number | null {
  const g = (state.scores[player.id] || {})[h.num];
  if (g == null) return null;
  const rec = state.handicapMode !== "gross" ? strokesOn(player.hcp, h.si) : 0;
  return g - rec;
}
function teamBest(state: RoundState, team: Player[], h: Hole): number | null {
  const vals = team.map((p) => rawNet(state, p, h)).filter((v): v is number => v != null);
  return vals.length ? Math.min(...vals) : null;
}
function vegasNum(state: RoundState, team: Player[], h: Hole): number | null {
  const vals = team.map((p) => rawNet(state, p, h)).filter((v): v is number => v != null).sort((x, y) => x - y);
  if (vals.length < 2) return null;
  return Number(`${vals[0]}${vals[1]}`);
}

export function computeGames(state: RoundState): any {
  const P = state.players;
  const ready = P.length === 4;
  const g = state.games || ({} as any);
  const out: any = { ready, anyOn: !!(g.sixes || g.wolf || g.vegas || g.nassau) };
  if (!ready) return out;
  const course = state.course;
  const t1 = [P[0], P[1]], t2 = [P[2], P[3]];

  if (g.sixes) {
    const pts: Record<string, number> = {}; P.forEach((p) => (pts[p.id] = 0));
    const segs = [
      { lo: 1, hi: 6, a: [P[0], P[1]], b: [P[2], P[3]] },
      { lo: 7, hi: 12, a: [P[0], P[2]], b: [P[1], P[3]] },
      { lo: 13, hi: 18, a: [P[0], P[3]], b: [P[1], P[2]] },
    ];
    course.forEach((h) => {
      const seg = segs.find((s) => h.num >= s.lo && h.num <= s.hi); if (!seg) return;
      const ba = teamBest(state, seg.a, h), bb = teamBest(state, seg.b, h);
      if (ba == null || bb == null) return;
      if (ba < bb) seg.a.forEach((p) => pts[p.id]++); else if (bb < ba) seg.b.forEach((p) => pts[p.id]++);
    });
    out.sixes = { points: pts, segments: segs.map((s) => ({ label: `Holes ${s.lo}\u2013${s.hi}`, a: s.a.map((p) => p.id), b: s.b.map((p) => p.id) })) };
  }

  if (g.wolf) {
    const pts: Record<string, number> = {}; P.forEach((p) => (pts[p.id] = 0));
    const picks = state.wolf || {};
    course.forEach((h) => {
      const wolf = P[(h.num - 1) % 4];
      const pick = picks[h.num]; if (!pick) return;
      if (pick === "lone") {
        const wn = rawNet(state, wolf, h);
        const others = P.filter((p) => p.id !== wolf.id);
        const ob = teamBest(state, others, h);
        if (wn == null || ob == null) return;
        if (wn < ob) pts[wolf.id] += 3; else if (ob < wn) others.forEach((p) => pts[p.id]++);
      } else {
        const partner = P.find((p) => p.id === pick); if (!partner) return;
        const team = [wolf, partner], opp = P.filter((p) => p.id !== wolf.id && p.id !== partner.id);
        const tb = teamBest(state, team, h), ob = teamBest(state, opp, h);
        if (tb == null || ob == null) return;
        if (tb < ob) team.forEach((p) => pts[p.id]++); else if (ob < tb) opp.forEach((p) => pts[p.id]++);
      }
    });
    out.wolf = { points: pts, order: P.map((p) => p.id) };
  }

  if (g.vegas) {
    let a = 0, b = 0;
    course.forEach((h) => {
      const na = vegasNum(state, t1, h), nb = vegasNum(state, t2, h);
      if (na == null || nb == null) return;
      if (na < nb) a += nb - na; else if (nb < na) b += na - nb;
    });
    out.vegas = { teams: [t1.map((p) => p.id), t2.map((p) => p.id)], pts: [a, b] };
  }

  if (g.nassau) {
    const seg = (lo: number, hi: number) => {
      let up = 0;
      course.filter((h) => h.num >= lo && h.num <= hi).forEach((h) => {
        const ba = teamBest(state, t1, h), bb = teamBest(state, t2, h);
        if (ba == null || bb == null) return;
        if (ba < bb) up++; else if (bb < ba) up--;
      });
      return up;
    };
    const fmt = (u: number) => (u === 0 ? "All square" : u > 0 ? `Team 1 ${u} up` : `Team 2 ${-u} up`);
    out.nassau = { teams: [t1.map((p) => p.id), t2.map((p) => p.id)], lines: [
      { label: "Front 9", status: fmt(seg(1, 9)) },
      { label: "Back 9", status: fmt(seg(10, 18)) },
      { label: "Overall", status: fmt(seg(1, 18)) },
    ] };
  }
  return out;
}

// ---- Outing team scoring: 2 best net of each foursome per hole ----
export function computeTeams(state: RoundState): any[] {
  const useHcp = state.handicapMode !== "gross";
  const groups: Record<string, Player[]> = {};
  state.players.forEach((p) => { const g = p.group || "A"; (groups[g] = groups[g] || []).push(p); });
  const rows = Object.keys(groups).sort().map((g) => {
    const members = groups[g];
    let toPar = 0, thru = 0;
    state.course.forEach((h) => {
      const nets = members.map((p) => {
        const v = (state.scores[p.id] || {})[h.num];
        return v == null ? null : v - (useHcp ? strokesOn(p.hcp, h.si) : 0);
      }).filter((v): v is number => v != null).sort((a, b) => a - b);
      if (nets.length < 2) return;
      toPar += nets[0] + nets[1] - 2 * h.par;
      thru++;
    });
    return { group: g, names: members.map((p) => p.name), toPar, thru, count: members.length };
  });
  rows.sort((a, b) => (a.thru === 0 ? 1 : 0) - (b.thru === 0 ? 1 : 0) || a.toPar - b.toPar);
  return rows;
}
