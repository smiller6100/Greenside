// ---- Types ----
export interface Hole { num: number; par: number; yards: number; si: number; nine?: string }
export interface Player { id: string; name: string; hcp: number; group?: string }
export interface Formats { net: boolean; gross: boolean; stableford: boolean; chicago: boolean; skins: boolean }
export interface Games { sixes: boolean; wolf: boolean; vegas: boolean; nassau: boolean; nines: boolean; bbb: boolean; bestball: boolean }
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
  bbb?: Record<string, { bingo?: string; bango?: string; bongo?: string }>; // holeNum -> winners
  presses?: { sixes?: number[]; nassau?: number[] }; // start holes of presses per game
  sixesMode?: "points" | "skins"; // Sixes scoring: cumulative points vs match-play (ties push)
  teamMode?: "bestball" | "best2" | "scramble"; // outing team scoring
  teamScores?: Record<string, Record<string, number>>; // group -> holeNum -> team strokes (scramble)
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
  chicago: number;
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
// Color-code a score by result vs par (eagle/birdie/par/bogey/double+)
export const scoreTone = (rel: number) => (rel <= -2 ? "sc-eagle" : rel === -1 ? "sc-bird" : rel === 0 ? "sc-par" : rel === 1 ? "sc-bog" : "sc-dbl");

// Chicago (Quota) per-hole points off GROSS score vs par: dbl+ 0, bogey 1, par 2, birdie 4, eagle+ 8
function chicagoPts(toPar: number): number {
  if (toPar <= -2) return 8;
  if (toPar === -1) return 4;
  if (toPar === 0) return 2;
  if (toPar === 1) return 1;
  return 0;
}


export function computeStandings(state: RoundState, format: string): Standing[] {
  const useHcp = state.handicapMode !== "gross";
  const course = state.course;

  const rows: Standing[] = state.players.map((p) => {
    const sc = state.scores[p.id] || {};
    const played = course.filter((h) => sc[h.num] != null);
    let gross = 0, net = 0, par = 0, points = 0, chi = 0;
    played.forEach((h) => {
      const g = sc[h.num];
      const rec = useHcp ? strokesOn(p.hcp, h.si) : 0;
      gross += g; par += h.par; net += g - rec;
      points += Math.max(0, 2 - (g - rec - h.par));
      chi += chicagoPts(g - h.par);
    });
    return {
      id: p.id, name: p.name, hcp: p.hcp, thru: played.length,
      gross, net, toParGross: gross - par, toParNet: net - par, points,
      chicago: p.hcp - 39 + chi, skins: 0,
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

  const key = ({ net: "toParNet", gross: "toParGross", stableford: "points", chicago: "chicago", skins: "skins" } as const)[
    format as "net" | "gross" | "stableford" | "chicago" | "skins"
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
// Match play: holes team a is up over [lo,hi] (negative = team b up). Only played holes count.
export function holesUp(state: RoundState, a: Player[], b: Player[], lo: number, hi: number): number {
  let up = 0;
  state.course.filter((h) => h.num >= lo && h.num <= hi).forEach((h) => {
    const ba = teamBest(state, a, h), bb = teamBest(state, b, h);
    if (ba == null || bb == null) return;
    if (ba < bb) up++; else if (bb < ba) up--;
  });
  return up;
}
// The three rotating Sixes pairings.
export function sixesSegs(P: Player[]) {
  return [
    { lo: 1, hi: 6, a: [P[0], P[1]], b: [P[2], P[3]] },
    { lo: 7, hi: 12, a: [P[0], P[2]], b: [P[1], P[3]] },
    { lo: 13, hi: 18, a: [P[0], P[3]], b: [P[1], P[2]] },
  ];
}
function vegasNum(state: RoundState, team: Player[], h: Hole): number | null {
  const vals = team.map((p) => rawNet(state, p, h)).filter((v): v is number => v != null).sort((x, y) => x - y);
  if (vals.length < 2) return null;
  return Number(`${vals[0]}${vals[1]}`);
}

export function computeGames(state: RoundState): any {
  const P = state.players;
  const n = P.length;
  const g = state.games || ({} as any);
  const out: any = { n, anyOn: !!(g.sixes || g.wolf || g.vegas || g.nassau || g.nines || g.bbb || g.bestball) };
  const course = state.course;
  const t1 = [P[0], P[1]], t2 = [P[2], P[3]];

  const nm = (team: Player[]) => team.map((p) => p.name).join("/");
  const matchStatus = (u: number, a: Player[], b: Player[]) => (u === 0 ? "All square" : u > 0 ? `${nm(a)} ${u} up` : `${nm(b)} ${-u} up`);

  if (g.sixes && n === 4) {
    const pts: Record<string, number> = {}; P.forEach((p) => (pts[p.id] = 0));
    const segs = sixesSegs(P);
    course.forEach((h) => {
      const seg = segs.find((s) => h.num >= s.lo && h.num <= s.hi); if (!seg) return;
      const ba = teamBest(state, seg.a, h), bb = teamBest(state, seg.b, h);
      if (ba == null || bb == null) return;
      if (ba < bb) seg.a.forEach((p) => pts[p.id]++); else if (bb < ba) seg.b.forEach((p) => pts[p.id]++);
    });
    const prs = (state.presses?.sixes) || [];
    out.sixes = { mode: state.sixesMode || "points", points: pts, segments: segs.map((s) => {
      const presses = prs.filter((h) => h >= s.lo && h <= s.hi).sort((x, y) => x - y)
        .map((start) => ({ start, status: matchStatus(holesUp(state, s.a, s.b, start, s.hi), s.a, s.b) }));
      return { lo: s.lo, hi: s.hi, label: `Holes ${s.lo}\u2013${s.hi}`, a: s.a.map((p) => p.id), b: s.b.map((p) => p.id), status: matchStatus(holesUp(state, s.a, s.b, s.lo, s.hi), s.a, s.b), presses };
    }) };
  }

  if (g.wolf && (n === 3 || n === 4)) {
    const pts: Record<string, number> = {}; P.forEach((p) => (pts[p.id] = 0));
    const picks = state.wolf || {};
    course.forEach((h) => {
      const wolf = P[(h.num - 1) % n];
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

  if (g.nines && n === 3) {
    const pts: Record<string, number> = {}; P.forEach((p) => (pts[p.id] = 0));
    const award = [5, 3, 1];
    course.forEach((h) => {
      const arr = P.map((p) => ({ id: p.id, s: rawNet(state, p, h) })).filter((x): x is { id: string; s: number } => x.s != null);
      if (arr.length < 3) return;
      arr.sort((a, b) => a.s - b.s);
      let i = 0;
      while (i < 3) {
        let j = i; while (j + 1 < 3 && arr[j + 1].s === arr[i].s) j++;
        const share = award.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1);
        for (let k = i; k <= j; k++) pts[arr[k].id] += share;
        i = j + 1;
      }
    });
    out.nines = { points: pts };
  }

  if (g.vegas && n === 4) {
    let a = 0, b = 0;
    course.forEach((h) => {
      const na = vegasNum(state, t1, h), nb = vegasNum(state, t2, h);
      if (na == null || nb == null) return;
      if (na < nb) a += nb - na; else if (nb < na) b += na - nb;
    });
    out.vegas = { teams: [t1.map((p) => p.id), t2.map((p) => p.id)], pts: [a, b] };
  }

  if (g.nassau && n === 4) {
    const prs = (state.presses?.nassau) || [];
    const frontP = prs.filter((h) => h <= 9).sort((x, y) => x - y)
      .map((start) => ({ label: `Front press · from ${start}`, status: matchStatus(holesUp(state, t1, t2, start, 9), t1, t2) }));
    const backP = prs.filter((h) => h >= 10).sort((x, y) => x - y)
      .map((start) => ({ label: `Back press · from ${start}`, status: matchStatus(holesUp(state, t1, t2, start, 18), t1, t2) }));
    out.nassau = { teams: [t1.map((p) => p.id), t2.map((p) => p.id)], lines: [
      { label: "Front 9", status: matchStatus(holesUp(state, t1, t2, 1, 9), t1, t2) },
      { label: "Back 9", status: matchStatus(holesUp(state, t1, t2, 10, 18), t1, t2) },
      { label: "Overall", status: matchStatus(holesUp(state, t1, t2, 1, 18), t1, t2) },
    ], presses: [...frontP, ...backP] };
  }
  if (g.bestball && n === 4) {
    const tally = (team: Player[]) => {
      let toPar = 0, thru = 0;
      course.forEach((h) => {
        const b = teamBest(state, team, h);
        if (b == null) return;
        toPar += b - h.par; thru++;
      });
      return { toPar, thru };
    };
    out.bestball = { teams: [t1.map((p) => p.id), t2.map((p) => p.id)], a: tally(t1), b: tally(t2) };
  }

  if (g.bbb) {
    const pts: Record<string, number> = {}; P.forEach((p) => (pts[p.id] = 0));
    const picks = state.bbb || {};
    course.forEach((h) => {
      const hp = picks[h.num]; if (!hp) return;
      (["bingo", "bango", "bongo"] as const).forEach((w) => {
        const id = hp[w]; if (id && pts[id] != null) pts[id]++;
      });
    });
    out.bbb = { points: pts };
  }

  return out;
}

// ---- Outing team scoring: best ball (low ball), best 2, or scramble (one team ball) ----
export function computeTeams(state: RoundState): any[] {
  const useHcp = state.handicapMode !== "gross";
  const mode = state.teamMode || "best2";
  const groups: Record<string, Player[]> = {};
  state.players.forEach((p) => { const g = p.group || "1"; (groups[g] = groups[g] || []).push(p); });
  const rows = Object.keys(groups).map((g) => {
    const members = groups[g];
    let toPar = 0, thru = 0;
    state.course.forEach((h) => {
      if (mode === "scramble") {
        const ts = (state.teamScores?.[g] || {})[h.num];
        if (ts == null) return;
        toPar += ts - h.par; thru++;
      } else {
        const nets = members.map((p) => {
          const v = (state.scores[p.id] || {})[h.num];
          return v == null ? null : v - (useHcp ? strokesOn(p.hcp, h.si) : 0);
        }).filter((v): v is number => v != null).sort((a, b) => a - b);
        const need = mode === "bestball" ? 1 : 2;
        if (nets.length < need) return;
        toPar += nets.slice(0, need).reduce((a, b) => a + b, 0) - need * h.par;
        thru++;
      }
    });
    return { group: g, names: members.map((p) => p.name), toPar, thru, count: members.length };
  });
  rows.sort((a, b) => (a.thru === 0 ? 1 : 0) - (b.thru === 0 ? 1 : 0) || a.toPar - b.toPar);
  return rows;
}

// ---- Round option definitions (shared by Home setup and Round edit) ----
export const FORMAT_DEFS = [
  { id: "net", label: "Net" }, { id: "gross", label: "Gross" },
  { id: "stableford", label: "Stableford" }, { id: "chicago", label: "Chicago" }, { id: "skins", label: "Skins" },
] as const;
export const HCP_DEFS = [
  { id: "perHole", label: "Per-hole" }, { id: "course", label: "Course" }, { id: "gross", label: "Off" },
] as const;
export const GAME_DEFS = [
  { id: "wolf", label: "Wolf" }, { id: "nines", label: "Nines" },
  { id: "sixes", label: "Sixes" }, { id: "vegas", label: "Vegas" }, { id: "nassau", label: "Nassau" },
  { id: "bestball", label: "Best Ball" },
  { id: "bbb", label: "Bingo Bango Bongo" },
] as const;
export const GAME_HELP: Record<string, string> = {
  wolf: "3\u20134 players. A different \u201cwolf\u201d each hole picks a partner after the tee shots, or goes solo for triple. Set the pick on the Scorecard tab.",
  nines: "3 players. Each hole splits 9 points: 5 to the low score, 3 to the middle, 1 to the high (ties split). Most points wins.",
  sixes: "4 players. Teams of two, partners rotate every 6 holes. Low team score wins the hole \u2014 1 point per win.",
  vegas: "4 players. Two fixed teams. Each hole your pair\u2019s two scores make a number (low one first); the lower number wins the difference.",
  nassau: "4 players. Two fixed teams, best-ball match play. Three bets in one: front 9, back 9, and the overall 18.",
  bestball: "4 players. Two fixed teams; each hole counts only the better score of the pair. Lowest team total over 18 wins.",
  bbb: "Any size. 3 points a hole \u2014 Bingo (first on the green), Bango (closest once everyone\u2019s on), Bongo (first in the hole). You award them on the Scorecard tab. Most points wins.",
};

// ---- Multi-nine (27-hole / three-nines) composition ----
export interface Nine { name: string; holes: Hole[] }

// Group a flat hole list into nines by their `nine` label, preserving order.
export function ninesFromHoles(holes: Hole[]): Nine[] {
  const map = new Map<string, Hole[]>();
  const order: string[] = [];
  holes.forEach((h) => {
    const k = h.nine || "";
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k)!.push(h);
  });
  return order.map((k) => ({ name: k, holes: map.get(k)! }));
}

// True when a course is really multiple nines a player must choose between.
export function hasMultipleNines(holes: Hole[]): boolean {
  const labels = new Set(holes.map((h) => h.nine || ""));
  return labels.size >= 2 || holes.length > 18;
}

// Build a round from chosen nines (already in play order). Renumbers the holes 1..N and
// recomputes a combined stroke index. The classic 18-hole convention is "first nine gets the
// odd indexes, second nine the evens, each by its own 1-9 ranking"; this generalizes that to
// any number of nines by dealing the indexes round-robin across the nines by within-nine rank.
export function composeNines(nines: Nine[]): Hole[] {
  const k = nines.length;
  if (!k) return [];
  const rankMaps = nines.map((n) => {
    const idx = n.holes.map((h, i) => ({ h, i }));
    const haveSi = idx.some((x) => x.h.si > 0);
    const ordered = [...idx].sort((a, b) => (haveSi ? a.h.si - b.h.si : (b.h.par - a.h.par)) || (a.i - b.i));
    const rank = new Map<number, number>();
    ordered.forEach((x, r) => rank.set(x.i, r + 1));
    return rank;
  });
  const out: Hole[] = [];
  let num = 0;
  nines.forEach((n, j) => {
    n.holes.forEach((h, i) => {
      num += 1;
      const r = rankMaps[j].get(i) || (i + 1);
      out.push({ ...h, num, si: (r - 1) * k + j + 1, nine: n.name });
    });
  });
  return out;
}

// The three standard two-nine combinations for a 27-hole course, by nine name.
export function ninePresets(nines: Nine[]): { label: string; pick: number[] }[] {
  if (nines.length < 2) return [];
  const combos: { label: string; pick: number[] }[] = [];
  for (let a = 0; a < nines.length; a++) for (let b = a + 1; b < nines.length; b++) {
    combos.push({ label: `${nines[a].name} + ${nines[b].name}`, pick: [a, b] });
  }
  if (nines.length >= 3) combos.push({ label: "All " + nines.length * 9 + " holes", pick: nines.map((_, i) => i) });
  return combos;
}

// ---- Money settlement (auto settle-up) ----
// Sum per-game, per-player dollar results into one net balance per player.
export function netFromGames(games: Record<string, Record<string, number>>): Record<string, number> {
  const net: Record<string, number> = {};
  for (const g of Object.values(games)) for (const [pid, amt] of Object.entries(g)) net[pid] = (net[pid] || 0) + amt;
  return net;
}

// Reduce net balances (which sum to ~0) to the fewest cash transfers. Greedy largest-debtor /
// largest-creditor matching — minimal or near-minimal payments, which is all that matters here.
export function settleUp(net: Record<string, number>): { from: string; to: string; amount: number }[] {
  const bal = Object.entries(net).map(([id, v]) => ({ id, c: Math.round(v * 100) })).filter((x) => x.c !== 0);
  const debt = bal.filter((x) => x.c < 0).map((x) => ({ id: x.id, c: -x.c })).sort((a, b) => b.c - a.c);
  const cred = bal.filter((x) => x.c > 0).map((x) => ({ ...x })).sort((a, b) => b.c - a.c);
  const tx: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const m = Math.min(debt[i].c, cred[j].c);
    if (m > 0) tx.push({ from: debt[i].id, to: cred[j].id, amount: m / 100 });
    debt[i].c -= m; cred[j].c -= m;
    if (debt[i].c === 0) i++;
    if (cred[j].c === 0) j++;
  }
  return tx;
}
