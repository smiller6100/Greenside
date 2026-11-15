// Ryder Cup match-play engine. Pure, deterministic golf logic — unit-tested separately.
// Everything here works off integer course handicaps and hole Stroke Index (SI 1 = hardest).

export type HcpMethod = "low" | "full" | "gross";
export type Format = "singles" | "fourball" | "foursomes" | "scramble";
export type Side = "A" | "B";

export interface CupCourse { pars: number[]; sis: number[]; } // parallel arrays, 9 or 18 holes

// Allocate `S` handicap strokes across holes by Stroke Index. Positive gives strokes on the hardest
// holes first (SI 1,2,…); negative (a plus handicap) gives strokes back on the easiest (SI 18,17,…).
// Handles any S, wrapping for >18 (a second stroke on the hardest holes), and 9- or 18-hole sets.
export function allocateStrokes(S: number, sis: number[]): number[] {
  const n = sis.length;
  const out = new Array(n).fill(0);
  if (!S || n === 0) return out;
  const sign = S > 0 ? 1 : -1;
  let rem = Math.abs(Math.round(S));
  const full = Math.floor(rem / n);
  if (full) for (let i = 0; i < n; i++) out[i] += sign * full;
  rem -= full * n;
  if (rem > 0) {
    const order = sis.map((si, i) => ({ si, i })).sort((a, b) => (sign > 0 ? a.si - b.si : b.si - a.si));
    for (let k = 0; k < rem && k < n; k++) out[order[k].i] += sign;
  }
  return out;
}

// 2-person team handicap for alternate-shot (foursomes): 50% of the combined handicaps (USGA).
export function foursomesTeamHcp(hcps: number[]): number {
  return Math.round(0.5 * hcps.reduce((a, b) => a + b, 0));
}
// 2-person scramble team handicap: 35% of the low + 15% of the high (common 2-man scramble allowance).
export function scrambleTeamHcp(hcps: number[]): number {
  if (hcps.length === 1) return Math.round(hcps[0]);
  const sorted = [...hcps].sort((a, b) => a - b);
  return Math.round(0.35 * sorted[0] + 0.15 * sorted[sorted.length - 1]);
}

export type Scoring = "match" | "nassau"; // 1 point per match, or 3 (front 9 / back 9 / total 18)

export interface MatchInput {
  format: Format;
  method: HcpMethod;
  sideA: { id: string; hcp: number }[];
  sideB: { id: string; hcp: number }[];
  // Gross scores. Per-player formats (singles, fourball) key by player id; team formats
  // (foursomes, scramble) key by the side letter "A"/"B".
  gross: Record<string, (number | null)[]>;
  course: CupCourse;
  scoring?: Scoring; // default "match"
}

export interface MatchResult {
  holesPlayed: number;
  holesTotal: number;
  up: number;          // signed net of holes won, + favours A
  leader: Side | null;
  decided: boolean;    // closed out, or all holes played
  final: boolean;      // every hole played OR closed out (no more play)
  dormie: boolean;     // leader is up by exactly the holes remaining
  label: string;       // "A 3&2", "2 UP", "AS", "1 UP" …
  statusShort: string; // live banner, e.g. "A 2 UP", "AS", "A dormie"
  points: { A: number; B: number };     // banked once the match is final
  projected: { A: number; B: number };  // live projection while in progress
  holeResults: (Side | "halve" | null)[]; // per hole
  scoring: Scoring;
  segments?: { key: "front" | "back" | "total"; label: string; result: SegResult }[]; // nassau only
}

// One Nassau segment (front 9 / back 9 / total 18), decided by holes won — a tie goes to whoever won
// the hardest-handicap (lowest-SI) hole in the segment.
export interface SegResult {
  winner: Side | null;  // null only if every decisive hole halved
  a: number; b: number; // holes won in the segment
  played: number; holes: number;
  complete: boolean;    // all holes played, or the segment can no longer be caught
  tiedBySI: boolean;    // decided by the hardest-hole tiebreak
}

function segResult(holeResults: (Side | "halve" | null)[], sis: number[], lo: number, hi: number): SegResult {
  let a = 0, b = 0, played = 0; const holes = hi - lo + 1;
  for (let i = lo; i <= hi; i++) { const r = holeResults[i]; if (r == null) continue; played++; if (r === "A") a++; else if (r === "B") b++; }
  const complete = played === holes || Math.abs(a - b) > holes - played; // all in, or can't be caught
  let winner: Side | null = a > b ? "A" : b > a ? "B" : null, tiedBySI = false;
  if (winner == null) { // tie on holes → hardest won hole decides
    const won: { si: number; r: Side }[] = [];
    for (let i = lo; i <= hi; i++) { const r = holeResults[i]; if (r === "A" || r === "B") won.push({ si: sis[i], r }); }
    won.sort((x, y) => x.si - y.si);
    if (won.length) { winner = won[0].r; tiedBySI = true; }
  }
  return { winner, a, b, played, holes, complete, tiedBySI };
}

// Net score for each side on each hole, applying the chosen handicap method and format.
function sideNets(m: MatchInput): { A: (number | null)[]; B: (number | null)[] } {
  const { sis } = m.course;
  const n = sis.length;
  const teamBall = m.format === "foursomes" || m.format === "scramble";

  if (teamBall) {
    const teamHcp = (side: { hcp: number }[]) =>
      m.format === "foursomes" ? foursomesTeamHcp(side.map((p) => p.hcp)) : scrambleTeamHcp(side.map((p) => p.hcp));
    const hA = teamHcp(m.sideA);
    const hB = teamHcp(m.sideB);
    const base = m.method === "gross" ? 0 : m.method === "low" ? Math.min(hA, hB) : 0;
    const strokesA = allocateStrokes(m.method === "gross" ? 0 : hA - base, sis);
    const strokesB = allocateStrokes(m.method === "gross" ? 0 : hB - base, sis);
    const gA = m.gross["A"] || [];
    const gB = m.gross["B"] || [];
    const net = (g: (number | null)[], st: number[]) =>
      Array.from({ length: n }, (_, h) => (g[h] == null ? null : (g[h] as number) - st[h]));
    return { A: net(gA, strokesA), B: net(gB, strokesB) };
  }

  // Per-player formats: allocate each player's strokes, then take the side's best net per hole.
  const everyone = [...m.sideA, ...m.sideB];
  const minHcp = Math.min(...everyone.map((p) => p.hcp));
  const strokesFor = (hcp: number) =>
    allocateStrokes(m.method === "gross" ? 0 : m.method === "low" ? hcp - minHcp : hcp, sis);
  const playerNet = (p: { id: string; hcp: number }) => {
    const g = m.gross[p.id] || [];
    const st = strokesFor(p.hcp);
    return Array.from({ length: n }, (_, h) => (g[h] == null ? null : (g[h] as number) - st[h]));
  };
  const bestNet = (side: { id: string; hcp: number }[]) => {
    const nets = side.map(playerNet);
    return Array.from({ length: n }, (_, h) => {
      const vals = nets.map((arr) => arr[h]).filter((v) => v != null) as number[];
      return vals.length ? Math.min(...vals) : null;
    });
  };
  return { A: bestNet(m.sideA), B: bestNet(m.sideB) };
}

export function computeMatch(m: MatchInput): MatchResult {
  const n = m.course.sis.length;
  const { A, B } = sideNets(m);
  const holeResults: (Side | "halve" | null)[] = [];
  let up = 0;
  let holesPlayed = 0;
  let decided = false, decUp = 0, decRem = 0; // frozen at the hole the match was clinched
  for (let h = 0; h < n; h++) {
    if (A[h] == null || B[h] == null) { holeResults.push(null); continue; }
    holesPlayed++;
    if ((A[h] as number) < (B[h] as number)) { up += 1; holeResults.push("A"); }
    else if ((B[h] as number) < (A[h] as number)) { up -= 1; holeResults.push("B"); }
    else holeResults.push("halve");
    if (!decided) {
      const rem = n - holesPlayed;
      if (Math.abs(up) > rem) { decided = true; decUp = up; decRem = rem; } // lead can't be caught
    }
  }
  const allPlayed = holesPlayed === n;
  const final = decided || allPlayed;
  const curLead = Math.abs(up);
  const lead = decided ? Math.abs(decUp) : curLead;
  const remaining = decided ? decRem : n - holesPlayed;
  const leader: Side | null = decided ? (decUp > 0 ? "A" : "B") : up > 0 ? "A" : up < 0 ? "B" : null;
  const dormie = !decided && curLead > 0 && curLead === n - holesPlayed;
  const winner: Side | null = final ? (decided ? (decUp > 0 ? "A" : "B") : up > 0 ? "A" : up < 0 ? "B" : null) : null;

  let label: string;
  if (!holesPlayed) label = "—";
  else if (decided) label = `${leader} ${lead}&${remaining}`;
  else label = up === 0 ? "AS" : `${leader} ${curLead} UP`;

  let statusShort: string;
  if (!holesPlayed) statusShort = "Not started";
  else if (decided) statusShort = `${leader} wins ${lead}&${remaining}`;
  else if (allPlayed) statusShort = up === 0 ? "Halved (AS)" : `${leader} wins ${curLead} UP`;
  else if (dormie) statusShort = `${leader} dormie · thru ${holesPlayed}`;
  else statusShort = up === 0 ? `All square · thru ${holesPlayed}` : `${leader} ${curLead} UP · thru ${holesPlayed}`;

  const scoring: Scoring = m.scoring === "nassau" ? "nassau" : "match";

  if (scoring === "nassau") {
    const sis = m.course.sis;
    const segDefs: { key: "front" | "back" | "total"; label: string; lo: number; hi: number }[] = [
      { key: "front", label: "Front 9", lo: 0, hi: Math.min(8, n - 1) },
    ];
    if (n > 9) segDefs.push({ key: "back", label: "Back 9", lo: 9, hi: n - 1 });
    segDefs.push({ key: "total", label: "Total 18", lo: 0, hi: n - 1 });
    const segments = segDefs.map((d) => ({ key: d.key, label: d.label, result: segResult(holeResults, sis, d.lo, d.hi) }));
    const pts = { A: 0, B: 0 }, proj = { A: 0, B: 0 };
    for (const s of segments) {
      const r = s.result;
      if (r.complete) { if (r.winner === "A") pts.A += 1; else if (r.winner === "B") pts.B += 1; else { pts.A += 0.5; pts.B += 0.5; } }
      if (r.played > 0) { if (r.winner === "A") proj.A += 1; else if (r.winner === "B") proj.B += 1; else { proj.A += 0.5; proj.B += 0.5; } }
    }
    const nf = (x: number) => (Number.isInteger(x) ? `${x}` : `${Math.floor(x)}½`);
    const nLabel = !holesPlayed ? "—" : final ? `${nf(pts.A)}–${nf(pts.B)}` : `${nf(proj.A)}–${nf(proj.B)}`;
    const nStatus = !holesPlayed ? "Not started"
      : final ? `Final · ${nf(pts.A)}–${nf(pts.B)} pts`
      : `${nf(proj.A)}–${nf(proj.B)} pts · thru ${holesPlayed}`;
    return { holesPlayed, holesTotal: n, up, leader, decided, final, dormie, label: nLabel, statusShort: nStatus, points: pts, projected: proj, holeResults, scoring, segments };
  }

  const points = final ? (winner === "A" ? { A: 1, B: 0 } : winner === "B" ? { A: 0, B: 1 } : { A: 0.5, B: 0.5 }) : { A: 0, B: 0 };
  // Projection reflects only matches that are actually under way: a match nobody has teed off in
  // contributes nothing (so the board doesn't read "projected 1.5–1.5" before the first tee shot).
  const projected = final ? points : !holesPlayed ? { A: 0, B: 0 } : up > 0 ? { A: 1, B: 0 } : up < 0 ? { A: 0, B: 1 } : { A: 0.5, B: 0.5 };

  return { holesPlayed, holesTotal: n, up, leader, decided, final, dormie, label, statusShort, points, projected, holeResults, scoring: "match" };
}

// Roll match results into the Cup scoreboard. Banked = points from finished matches; projected
// adds the current leader of each in-progress match.
export function cupTotals(results: MatchResult[]): { banked: { A: number; B: number }; projected: { A: number; B: number } } {
  const banked = { A: 0, B: 0 };
  const projected = { A: 0, B: 0 };
  for (const r of results) {
    banked.A += r.points.A; banked.B += r.points.B;
    projected.A += r.projected.A; projected.B += r.projected.B;
  }
  return { banked, projected };
}

// Points needed to clinch (win) and to retain, given the total matches/points in play.
export function clinch(totalPoints: number): { toWin: number; toRetain: number } {
  return { toWin: Math.floor(totalPoints / 2) + 1, toRetain: totalPoints / 2 };
}
