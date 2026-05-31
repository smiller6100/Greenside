// ---- Types ----
export interface Hole { num: number; par: number; yards: number; si: number }
export interface Player { id: string; name: string; hcp: number }
export interface Formats { net: boolean; gross: boolean; stableford: boolean; skins: boolean }
export type HcpMode = "perHole" | "course" | "gross";

export interface RoundState {
  code: string;
  name: string;
  formats: Formats;
  handicapMode: HcpMode;
  players: Player[];
  course: Hole[];
  scores: Record<string, Record<string, number>>; // playerId -> holeNum -> strokes
  createdAt: number;
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
