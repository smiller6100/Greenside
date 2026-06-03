// Preloaded course data for The Legend Clubs (verified par + handicap for all holes,
// exact per-hole yardage for the longest tee, and total yardage for every tee).
// Shorter-tee per-hole yardages are scaled to the correct published total.

export interface SeedCourse {
  name: string;
  where: string;
  par: number[];          // 18
  hcp: number[];          // 18 (stroke index)
  longest: string;        // name of the tee with real per-hole yardages
  longestYards: number[]; // 18, real
  tees: { name: string; total: number }[]; // all tees with published total (skip nulls)
}

export const SEED_COURSES: SeedCourse[] = [
  {
    name: "The Legend at Brandybrook", where: "Wales, WI",
    par: [4, 5, 4, 4, 4, 3, 4, 4, 4, 4, 4, 3, 5, 4, 5, 3, 4, 4],
    hcp: [7, 5, 3, 17, 15, 11, 13, 1, 9, 16, 4, 18, 10, 2, 6, 12, 14, 8],
    longest: "Championship",
    longestYards: [423, 503, 398, 336, 377, 194, 390, 475, 255, 396, 467, 201, 543, 441, 618, 189, 377, 423],
    tees: [
      { name: "Championship", total: 7006 }, { name: "Gentlemen", total: 6566 },
      { name: "Forward", total: 6227 }, { name: "Ladies", total: 5400 }, { name: "Junior", total: 4725 },
    ],
  },
  {
    name: "The Legend at Bergamont", where: "Oregon, WI",
    par: [4, 4, 4, 3, 5, 4, 3, 4, 5, 4, 5, 4, 4, 3, 5, 4, 3, 4],
    hcp: [11, 9, 3, 15, 13, 1, 7, 17, 5, 6, 14, 18, 2, 16, 12, 10, 8, 4],
    longest: "Black",
    longestYards: [393, 424, 403, 221, 567, 430, 241, 364, 627, 435, 516, 380, 428, 234, 601, 421, 229, 417],
    tees: [
      { name: "Black", total: 7331 }, { name: "Blue", total: 6773 }, { name: "White", total: 6210 },
      { name: "Red", total: 5189 }, { name: "Green", total: 3136 },
    ],
  },
  {
    name: "The Legend at Bristlecone", where: "Hartland, WI",
    par: [4, 4, 5, 3, 4, 3, 5, 4, 4, 4, 5, 3, 4, 3, 4, 5, 3, 4],
    hcp: [13, 11, 1, 17, 9, 15, 3, 7, 5, 12, 4, 14, 10, 16, 6, 2, 18, 8],
    longest: "Black",
    longestYards: [352, 395, 613, 199, 463, 218, 509, 474, 448, 430, 582, 230, 448, 178, 430, 488, 146, 402],
    tees: [
      { name: "Black", total: 7005 }, { name: "Blue", total: 6493 }, { name: "White", total: 6038 },
      { name: "Red", total: 5033 }, // Orange total was not published — omitted
    ],
  },
  {
    name: "The Legend at Merrill Hills", where: "Waukesha, WI",
    par: [4, 5, 4, 5, 3, 4, 4, 4, 3, 4, 4, 3, 5, 4, 4, 3, 5, 4],
    hcp: [8, 4, 6, 10, 18, 14, 2, 12, 16, 5, 9, 15, 3, 11, 13, 17, 1, 7],
    longest: "Black",
    longestYards: [448, 522, 391, 490, 205, 375, 447, 410, 192, 428, 370, 157, 532, 387, 354, 152, 527, 412],
    tees: [
      { name: "Black", total: 6799 }, { name: "Blue", total: 6486 }, { name: "White", total: 5982 },
      { name: "Gold", total: 5715 }, { name: "Red", total: 5197 }, { name: "Orange", total: 4428 },
      { name: "Teal", total: 2428 },
    ],
  },
];

export interface SeedEntry {
  name: string; where: string; lat: null; lng: null;
  holes: { num: number; par: number; yards: number; si: number }[];
  tees: { name: string; total: number; holes: { num: number; par: number; yards: number; si: number }[] }[];
  defaultTee: string;
}

export function buildSeedEntry(c: SeedCourse): SeedEntry {
  const longestTotal = c.tees.find((t) => t.name === c.longest)?.total || c.longestYards.reduce((a, b) => a + b, 0);
  const tees = c.tees
    .filter((t) => t.total && t.total > 0)
    .map((t) => {
      const isLongest = t.name === c.longest;
      const f = isLongest ? 1 : t.total / longestTotal;
      const holes = c.longestYards.map((y, i) => ({
        num: i + 1,
        par: c.par[i],
        yards: isLongest ? y : Math.round(y * f),
        si: c.hcp[i],
      }));
      return { name: t.name, total: holes.reduce((s, h) => s + h.yards, 0), holes };
    });
  // default to a middle tee by length
  const sorted = [...tees].sort((a, b) => b.total - a.total);
  const def = sorted[Math.floor(sorted.length / 2)] || tees[0];
  return { name: c.name, where: c.where, lat: null, lng: null, holes: def.holes, tees, defaultTee: def.name };
}
